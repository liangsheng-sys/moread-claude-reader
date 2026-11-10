// 给 Claude Code 的 MCP 工具。命名与 MoRead 的 ReaderToolset 对齐。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { currentBookId, getBook, listBooks, loadBook, summary } from './library.js'
import { grep } from './search.js'
import { readEpubImage, normalizeChars } from './extract.js'
import * as store from './store.js'
import { getSettings } from './settings.js'
import { chapterAt, quotaStatus, readPermit, useAnnotationQuota } from './proactive.js'
import { getBookSummary, MEMORY_KINDS, recallMemories, saveBookSummary, saveMemory } from './memory.js'
import { listOutlines, listTerms, saveOutline, saveTerm } from './knowledge.js'
import { renderPdfPage } from './render.js'
import { formatInboxItem } from './inbox.js'

const MAX_READ_CHARS = 8000

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] })
const fail = s => ({ content: [{ type: 'text', text: s }], isError: true })

function resolve(bookId) {
  const id = bookId || currentBookId()
  if (!id) return { error: '还没有正在读的书。先用 list_books 看看书库，或请用户在阅读器里打开一本。' }
  const book = getBook(id)
  if (!book) return { error: `找不到书籍 ${id}` }
  if (!book.meta) return { error: `《${summary(book).title}》还在解析中（${book.status.stage}），稍后再试。` }
  return { id, book, meta: book.meta }
}

const sectionName = (meta, s) => meta.format === 'pdf' ? `第${s}页` : `第${s}节`

function tocItemFor(meta, section) {
  let hit = null
  for (const t of meta.toc) if (t.section != null && t.section <= section && (!hit || t.section >= hit.section)) hit = t
  return hit?.title ?? null
}

/** 阅读范围：默认只到读过的最远位置（防剧透 / 跟上用户节奏）。「进入章节时批注」会临时放开到本章末尾。 */
function scopeOf(id, meta, includeUnread) {
  const furthest = store.getState(id).furthest
  if (includeUnread || !getSettings().spoilerGuard || furthest == null) return { max: Infinity, furthest }
  return { max: Math.max(furthest, readPermit(id) ?? -1), furthest }
}

const chars = s => [...(s ?? '')].length

export function createMcpServer() {
  const server = new McpServer({ name: 'moread-desk', version: '0.2.0' }, {
    instructions: '墨知桌面伴读：读取用户在本地阅读器里的进度、正文、划线，并能在书页上留下批注、在侧栏说话。默认只读取用户已读范围。',
  })

  const bookArg = { book_id: z.string().optional().describe('书籍 ID，省略则为用户当前正在读的书') }
  const unreadArg = { include_unread: z.boolean().optional().describe('是否包含用户还没读到的部分。仅在用户明确同意时才设为 true') }

  server.registerTool('list_books', {
    description: '列出书库里的所有书及阅读进度。',
    inputSchema: {},
  }, async () => text(listBooks().map(b => ({
    id: b.id, title: b.title, author: b.author, format: b.format, path: b.path,
    pages: b.sectionCount, progress: b.progress ? `${b.progress.label ?? ''} (${Math.round((b.progress.fraction ?? 0) * 100)}%)` : '未开始',
    status: b.status.stage, vectors: !!b.status.vectors, scanned: b.scanned,
  }))))

  server.registerTool('get_reading_progress', {
    description: '查看用户当前读到哪里：书名、位置、所在章节、读过的最远位置、当前选中的文字、今日阅读时长、未处理的提问数。陪读时应先调用它。',
    inputSchema: { ...bookArg },
  }, async ({ book_id }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const { id, meta } = r
    const state = store.getState(id)
    const p = state.progress
    const g = store.load(null, 'global', {})
    const selection = g.selection?.bookId === id ? g.selection : null
    const days = Object.keys(state.readingLog).sort()
    return text({
      book_id: id, title: meta.title, author: meta.author, format: meta.format,
      file: getBook(id).file,
      total: `${meta.sectionCount}${meta.sectionUnit}`,
      current: p ? { section: p.section, where: sectionName(meta, p.section), label: p.label, chapter: p.tocLabel ?? tocItemFor(meta, p.section), percent: Math.round((p.fraction ?? 0) * 100), updated_at: p.updatedAt } : null,
      chapter_range: p && chapterAt(meta, p.section) ? (({ title, start, end }) => ({ title, start, end }))(chapterAt(meta, p.section)) : undefined,
      learning_summary: getBookSummary(id) ?? undefined,
      furthest_read: state.furthest != null ? sectionName(meta, state.furthest) : null,
      selection: selection ? { section: selection.section, text: selection.text, at: selection.at } : null,
      reading_minutes_today: Math.round((state.readingLog[store.today()] ?? 0) / 60),
      reading_days: days.length,
      pending_questions: store.pendingInbox({ questionsOnly: true }).length,
      proactive_quota_today: (({ annotations, annotationMax }) => `主动批注 ${annotations}/${annotationMax}`)(quotaStatus()),
      scanned_pdf: meta.scanned || undefined,
      tip: meta.format === 'pdf' ? '需要看页面上的图/公式/代码截图时，用 view_page 看整页，小图用 region 放大。' : undefined,
    })
  })

  server.registerTool('list_chapters', {
    description: '列出目录，并标出用户已读 / 未读。',
    inputSchema: { ...bookArg },
  }, async ({ book_id }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const furthest = store.getState(r.id).furthest ?? -1
    if (!r.meta.toc.length) return text(`这本书没有目录。共 ${r.meta.sectionCount}${r.meta.sectionUnit}。`)
    return text(r.meta.toc.map(t =>
      `${'  '.repeat(t.depth)}${t.title}${t.section != null ? ` → ${sectionName(r.meta, t.section)}${t.section <= furthest ? ' ✓' : ''}` : ''}`).join('\n'))
  })

  server.registerTool('read_book_section', {
    description: `读取正文。PDF 按页码（从 1 开始），EPUB 按节号（从 0 开始，见 list_chapters）。单次最多 ${MAX_READ_CHARS} 字，超出时用 offset 续读。`,
    inputSchema: {
      ...bookArg, ...unreadArg,
      from: z.number().int().describe('起始页 / 节'),
      to: z.number().int().optional().describe('结束页 / 节（含），默认同 from'),
      offset: z.number().int().optional().describe('跳过前多少字，用于续读'),
    },
  }, async ({ book_id, from, to, offset = 0, include_unread }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const { sections } = loadBook(r.id)
    const scope = scopeOf(r.id, r.meta, include_unread)
    const end = Math.min(to ?? from, from + 30)
    if (from > scope.max) return fail(`${sectionName(r.meta, from)} 用户还没读到（最远读到 ${sectionName(r.meta, scope.furthest)}）。如用户同意剧透，可传 include_unread: true。`)
    const picked = sections.filter(s => s.index >= from && s.index <= Math.min(end, scope.max))
    let body = picked.map(s => {
      const head = `【${sectionName(r.meta, s.index)}${s.label && r.meta.format === 'epub' ? ' · ' + s.label : ''}${s.images ? ` · 含 ${s.images} 张图` : ''}${s.ocr ? ' · 本机 OCR 识别，可能有错字' : ''}】`
      return `${head}\n${s.text || '（本页没有文字层，也还没识别：用 view_page 看图）'}`
    }).join('\n\n')
    body = body.slice(offset)
    let more = ''
    if (body.length > MAX_READ_CHARS) {
      more = `\n\n……（已截断，传 offset: ${offset + MAX_READ_CHARS} 继续）`
      body = body.slice(0, MAX_READ_CHARS)
    }
    if (end > scope.max) more += `\n（${sectionName(r.meta, scope.max + 1)} 之后用户还没读到，已省略）`
    const imgs = picked.filter(s => s.images)
    if (imgs.length) more += r.meta.format === 'pdf'
      ? `\n\n要看图：view_page 工具，page 取 ${imgs.map(s => s.index).join(' / ')}`
      : `\n\n要看图：get_image 工具，section 取 ${imgs.map(s => s.index).join(' / ')}`
    return text(body + more)
  })

  server.registerTool('search_book', {
    description: '在书中按意思检索（向量语义 + BM25 词法混合）。适合「书里哪里讲过 X」「作者怎么定义 Y」。返回片段和所在页 / 节。',
    inputSchema: {
      ...bookArg, ...unreadArg,
      query: z.string().describe('检索内容，自然语言即可'),
      top_k: z.number().int().min(1).max(20).optional(),
      mode: z.enum(['hybrid', 'lexical', 'vector']).optional(),
      from: z.number().int().optional(), to: z.number().int().optional(),
    },
  }, async ({ book_id, query, top_k = 6, mode = 'hybrid', from, to, include_unread }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const { index } = loadBook(r.id)
    const scope = scopeOf(r.id, r.meta, include_unread)
    const allow = c => c.section <= scope.max && (from == null || c.section >= from) && (to == null || c.section <= to)
    const { results, usedVector, semanticError } = await index.search(query, { allow, topK: top_k, mode })
    const note = []
    if (!usedVector) note.push(r.book.status.stage === 'embedding' ? '向量索引还在构建，本次只用了词法检索。' : semanticError ? `向量检索失败（${semanticError}），只用了词法检索。` : '')
    if (scope.max !== Infinity) note.push(`范围：已读部分（至 ${sectionName(r.meta, scope.max)}）。`)
    if (!results.length) return text(`没有找到相关内容。${note.join(' ')}`)
    return text(results.map((h, i) => `[${i + 1}] ${sectionName(r.meta, h.section)}${tocItemFor(r.meta, h.section) ? ' · ' + tocItemFor(r.meta, h.section) : ''}（${h.via.join('+')}）\n${h.text}`).join('\n\n') + (note.join(' ') ? `\n\n${note.join(' ')}` : ''))
  })

  server.registerTool('grep_book', {
    description: '字面 / 正则精确查找，返回所有命中位置和上下文。适合找术语、函数名、编号。',
    inputSchema: {
      ...bookArg, ...unreadArg,
      pattern: z.string(), regex: z.boolean().optional(),
      max: z.number().int().min(1).max(100).optional(),
    },
  }, async ({ book_id, pattern, regex = false, max = 30, include_unread }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const { sections } = loadBook(r.id)
    const scope = scopeOf(r.id, r.meta, include_unread)
    let res
    try { res = grep(sections, pattern, { regex, allow: s => s.index <= scope.max, max }) }
    catch (e) { return fail(`正则无效：${e.message}`) }
    if (!res.total) return text('没有命中。')
    return text(`共 ${res.total} 处${res.total > res.hits.length ? `，显示前 ${res.hits.length} 处` : ''}：\n` +
      res.hits.map(h => `- ${sectionName(r.meta, h.section)}：…${h.context}…`).join('\n'))
  })

  server.registerTool('get_image', {
    description: 'EPUB：返回某一节里的第 n 张图片，供你直接看图。（PDF 请用 view_page。）',
    inputSchema: { ...bookArg, section: z.number().int(), n: z.number().int().min(1).optional().describe('第几张，默认 1') },
  }, async ({ book_id, section, n = 1 }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    if (r.meta.format !== 'epub') return fail(`PDF 请用 view_page，page: ${section}。`)
    const s = loadBook(r.id).sections[section]
    const p = s?.imagePaths?.[n - 1]
    if (!p) return fail(`第 ${section} 节没有第 ${n} 张图（共 ${s?.imagePaths?.length ?? 0} 张）。`)
    const img = await readEpubImage(getBook(r.id).file, p)
    if (!img) return fail('图片读取失败。')
    if (img.mime === 'image/svg+xml') return text(Buffer.from(img.data, 'base64').toString('utf8').slice(0, 6000))
    return { content: [{ type: 'image', data: img.data, mimeType: img.mime }, { type: 'text', text: `${sectionName(r.meta, section)} 第 ${n}/${s.imagePaths.length} 张：${p}` }] }
  })

  server.registerTool('view_page', {
    description: 'PDF：把一页渲染成图片给你看（示意图、公式、代码截图、版式）。先看整页；图太小看不清时，用 region 只渲染其中一块，等于放大。',
    inputSchema: {
      ...bookArg, ...unreadArg,
      page: z.number().int().min(1).describe('页码（从 1 开始）'),
      region: z.object({
        x: z.number().min(0).max(1), y: z.number().min(0).max(1),
        w: z.number().min(0.02).max(1), h: z.number().min(0.02).max(1),
      }).optional().describe('只看页面的一部分：左上角 (x, y) 和宽高 (w, h)，都是相对整页的比例，如右下四分之一为 {x:0.5,y:0.5,w:0.5,h:0.5}'),
      detail: z.enum(['normal', 'high']).optional().describe('high 输出更大的图（更占上下文），默认 normal'),
    },
  }, async ({ book_id, page, region, detail = 'normal', include_unread }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    if (r.meta.format !== 'pdf') return fail('EPUB 请用 get_image（read_book_section 会标出哪一节有图）。')
    const scope = scopeOf(r.id, r.meta, include_unread)
    if (page > scope.max) return fail(`${sectionName(r.meta, page)} 用户还没读到（最远读到 ${sectionName(r.meta, scope.furthest)}）。如用户同意剧透，可传 include_unread: true。`)
    try {
      const img = await renderPdfPage(getBook(r.id).file, page, { region, maxSide: detail === 'high' ? 2000 : 1400 })
      const part = region ? `（区域 x=${region.x} y=${region.y} w=${region.w} h=${region.h}）` : ''
      return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, { type: 'text', text: `${sectionName(r.meta, page)}${part} · ${img.width}×${img.height}` }] }
    } catch (e) {
      return fail(`渲染失败：${e.message}`)
    }
  })

  server.registerTool('list_annotations', {
    description: '列出书中的划线和批注（用户的和你的），含讨论回复。用户自己的批注里常写着他的想法和练习答案：对答案、复习、用户提到「我之前写过」时先查这里。',
    inputSchema: {
      ...bookArg, from: z.number().int().optional(), to: z.number().int().optional(),
      author: z.enum(['me', 'claude']).optional().describe('me=用户, claude=你'),
      query: z.string().optional().describe('只看原文、批注或讨论里含这个词的'),
    },
  }, async ({ book_id, from, to, author, query }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const q = query?.trim().toLowerCase()
    const list = store.listAnnotations(r.id)
      .filter(a => (from == null || a.section >= from) && (to == null || a.section <= to) && (!author || a.author === author))
      .filter(a => !q || [a.quote, a.note, ...a.replies.map(x => x.text)].some(s => s?.toLowerCase().includes(q)))
      .sort((a, b) => a.section - b.section)
    if (!list.length) return text(q ? `没有含「${query}」的划线或批注。` : '还没有划线或批注。')
    return text(list.map(a => ({
      id: a.id, where: sectionName(r.meta, a.section), by: a.author === 'claude' ? '你' : '用户',
      quote: a.quote, note: a.note || undefined, style: a.style,
      replies: a.replies.length ? a.replies.map(x => `${x.author === 'claude' ? '你' : '用户'}：${x.text}`) : undefined,
    })))
  })

  server.registerTool('add_annotation', {
    description: '在书页上留下你的批注：给一段原文划线并写下评论，用户翻到这里就能看到。quote 必须是该页 / 节里逐字存在的原文（10~80 字为宜）。',
    inputSchema: {
      ...bookArg,
      section: z.number().int().describe('页码（PDF）或节号（EPUB）'),
      quote: z.string().min(2).describe('逐字原文'),
      note: z.string().describe('你的批注'),
      style: z.enum(['highlight', 'underline', 'wavy']).optional(),
      color: z.enum(['yellow', 'green', 'blue', 'pink', 'purple']).optional(),
      task_id: z.string().optional().describe('主动陪读任务带来的 task_id（有就必须带上，用于额度控制）'),
    },
  }, async ({ book_id, section, quote, note, style = 'wavy', color = 'purple', task_id }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const s = loadBook(r.id).sections.find(x => x.index === section)
    if (!s) return fail(`没有${sectionName(r.meta, section)}。`)
    if (section > scopeOf(r.id, r.meta, false).max) return fail(`${sectionName(r.meta, section)}用户还没读到，不能在那里留批注。`)
    const squash = t => normalizeChars(t).replace(/\s+/g, '')
    if (!squash(s.text).includes(squash(quote))) return fail(`${sectionName(r.meta, section)}里找不到这段原文，请用 read_book_section 核对后逐字引用。`)
    if (store.listAnnotations(r.id).some(a => a.author === 'claude' && a.section === section && squash(a.quote) === squash(quote))) return fail('你已经在这段原文上留过批注了。')
    if (task_id) {
      const q = useAnnotationQuota(task_id, r.id, section)
      if (!q.ok) return fail(q.reason)
    }
    const item = store.addAnnotation(r.id, { section, quote, note, style, color, author: 'claude', proactive: !!task_id })
    store.logExchange({ role: 'claude', kind: 'annotation', bookId: r.id, section, chars: chars(note), proactive: !!task_id })
    return text(`已在${sectionName(r.meta, section)}留下批注（id: ${item.id}）。`)
  })

  server.registerTool('reply_annotation', {
    description: '回复某条批注下的讨论（用户在阅读器里回复了你的批注、或在自己的划线下问你时用）。',
    inputSchema: { ...bookArg, annotation_id: z.string(), text: z.string() },
  }, async ({ book_id, annotation_id, text: body }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    if (!store.replyAnnotation(r.id, annotation_id, 'claude', body)) return fail('找不到这条批注。')
    store.logExchange({ role: 'claude', kind: 'chat', source: 'reader', bookId: r.id, chars: chars(body) })
    return text('已回复。')
  })

  server.registerTool('list_notes', {
    description: '列出这本书的读书笔记（用户和你写的）。',
    inputSchema: { ...bookArg },
  }, async ({ book_id }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const list = store.listNotes(r.id)
    return text(list.length ? list : '还没有笔记。')
  })

  server.registerTool('write_note', {
    description: '写或更新一篇读书笔记（章节总结、知识点梳理、练习题、用户卡住的地方等），显示在阅读器的「笔记」页。传 note_id 则覆盖更新。支持 Markdown。',
    inputSchema: { ...bookArg, title: z.string(), content: z.string(), note_id: z.string().optional() },
  }, async ({ book_id, title, content, note_id }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const item = store.writeNote(r.id, { noteId: note_id, title, content, author: 'claude' })
    if (!note_id) store.logExchange({ role: 'claude', kind: 'note', bookId: r.id, chars: chars(content) })
    return text(`笔记已保存（id: ${item.id}）。`)
  })

  server.registerTool('say', {
    description: '在阅读器侧栏的「伴读」面板里对用户说话（用户正在看书、不看终端时用；简短为宜）。',
    inputSchema: { ...bookArg, message: z.string() },
  }, async ({ book_id, message }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const p = store.getState(r.id).progress
    store.addMessage(r.id, 'claude', message, { section: p?.section })
    store.logExchange({ role: 'claude', kind: 'chat', source: 'reader', bookId: r.id, chars: chars(message) })
    return text('已发送到阅读器。')
  })

  server.registerTool('get_questions', {
    description: '取出用户在阅读器里发给你的内容（选中文字后的「问 Claude」、伴读面板留言、对批注的回复），取出后标记为已读。',
    inputSchema: {},
  }, async () => {
    const items = store.takeInbox()
    if (!items.length) return text('没有新的提问。')
    return text(items.map(i => [
      `[${{ ask: '选段提问', message: '面板留言', reply: '回复批注' }[i.kind] ?? i.kind} book_id=${i.bookId}${i.annotationId ? ` annotation_id=${i.annotationId}` : ''}]`,
      formatInboxItem(i),
    ].join('\n')).join('\n\n'))
  })

  // ---------- 记忆（对应 MoRead 的滚动剧情摘要 + 长期记忆） ----------

  server.registerTool('save_book_summary', {
    description: '覆盖更新这本书的「学习进度摘要」：读到哪、掌握了哪些概念、还有什么疑问。只保留最新一份，下次陪读（或用户隔天回来）时会先看到它。200~500 字为宜。',
    inputSchema: { ...bookArg, content: z.string() },
  }, async ({ book_id, content }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    saveBookSummary(r.id, content, store.getState(r.id).furthest)
    return text('学习进度摘要已更新。')
  })

  server.registerTool('save_memory', {
    description: `记下一条值得长期记住的事，跨书、跨会话可用 recall_memory 想起来。适合：用户对某概念的困惑或理解程度、兴趣点、学习习惯、阶段性进展。不要记书的内容本身（那用笔记）。kind：${Object.entries(MEMORY_KINDS).map(([k, v]) => `${k}=${v}`).join('，')}。`,
    inputSchema: {
      ...bookArg,
      kind: z.enum(Object.keys(MEMORY_KINDS)),
      content: z.string().describe('一两句话，写清楚主语和具体内容，脱离上下文也能看懂'),
      global: z.boolean().optional().describe('与具体某本书无关（如学习习惯）时设为 true'),
    },
  }, async ({ book_id, kind, content, global }) => {
    let bookId = null, section = null
    if (!global) {
      const r = resolve(book_id)
      if (r.error) return fail(r.error)
      bookId = r.id
      section = store.getState(r.id).progress?.section ?? null
    }
    await saveMemory({ bookId, kind, content, section })
    store.logExchange({ role: 'claude', kind: 'memory', bookId, chars: chars(content) })
    return text('已记住。')
  })

  server.registerTool('recall_memory', {
    description: '按意思检索以前记下的长期记忆（用户的困惑、兴趣、进展等）。',
    inputSchema: { query: z.string(), book_id: z.string().optional().describe('只查这本书的记忆；省略则查全部'), top_k: z.number().int().min(1).max(20).optional() },
  }, async ({ query, book_id, top_k = 8 }) => {
    const list = await recallMemories(query, { bookId: book_id, topK: top_k })
    if (!list.length) return text('没有相关记忆。')
    return text(list.map(m => `- [${MEMORY_KINDS[m.kind] ?? m.kind}] ${m.content}（${m.createdAt.slice(0, 10)}${m.bookId ? ` · ${getBook(m.bookId)?.meta?.title ?? ''}` : ''}）`).join('\n'))
  })

  // ---------- 章节大纲与术语表 ----------

  server.registerTool('save_chapter_outline', {
    description: '保存一章的大纲（显示在阅读器「目录 → 大纲」里，用户可展开看依据并跳回原文）。每个要点附一句逐字原文作为依据。同一章再次保存会覆盖。',
    inputSchema: {
      ...bookArg,
      section: z.number().int().describe('这一章内的任意页码 / 节号'),
      points: z.array(z.object({
        text: z.string().describe('要点，一句话'),
        quote: z.string().optional().describe('逐字原文依据'),
        section: z.number().int().optional().describe('依据所在页 / 节'),
      })).min(1).max(12),
    },
  }, async ({ book_id, section, points }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const ch = chapterAt(r.meta, section)
    if (!ch) return fail('这一页不在任何章节里。')
    if (ch.start > scopeOf(r.id, r.meta, false).max) return fail('这一章用户还没读到。')
    saveOutline(r.id, { start: ch.start, end: ch.end, title: ch.title, points })
    return text(`已保存「${ch.title}」的大纲（${points.length} 个要点）。`)
  })

  server.registerTool('list_terms', {
    description: '列出这本书已整理的术语表。',
    inputSchema: { ...bookArg },
  }, async ({ book_id }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const list = listTerms(r.id)
    return text(list.length ? list.map(t => `- ${t.term}${t.aliases.length ? `（${t.aliases.join('、')}）` : ''}：${t.definition}${t.section != null ? `［${sectionName(r.meta, t.section)}］` : ''}`).join('\n') : '术语表是空的。')
  })

  server.registerTool('save_term', {
    description: '把一个术语 / 概念记进术语表（阅读器「目录 → 术语」里可搜索、可跳回出处）。同名术语会覆盖更新。definition 用自己的话写，简洁准确；quote 是书中定义或首次出现处的逐字原文。',
    inputSchema: {
      ...bookArg,
      term: z.string(), definition: z.string(),
      section: z.number().int().optional(), quote: z.string().optional(),
      aliases: z.array(z.string()).optional().describe('别名、英文名、缩写'),
    },
  }, async ({ book_id, term, definition, section, quote, aliases }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    if (section != null && section > scopeOf(r.id, r.meta, false).max) return fail('出处在用户还没读到的地方。')
    saveTerm(r.id, { term, definition, section, quote, aliases })
    return text(`已记入术语表：${term}`)
  })

  server.registerTool('list_outlines', {
    description: '查看已保存的章节大纲。',
    inputSchema: { ...bookArg },
  }, async ({ book_id }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const all = Object.values(listOutlines(r.id))
    return text(all.length ? all.map(o => `## ${o.title}\n${o.points.map(p => `- ${p.text}`).join('\n')}`).join('\n\n') : '还没有章节大纲。')
  })

  return server
}
