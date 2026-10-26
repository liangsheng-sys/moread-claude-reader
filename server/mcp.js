// 给 Claude Code 的 MCP 工具。命名与 MoRead 的 ReaderToolset 对齐。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { currentBookId, getBook, listBooks, loadBook, summary } from './library.js'
import { grep } from './search.js'
import { readEpubImage, normalizeChars } from './extract.js'
import * as store from './store.js'

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

/** 阅读范围：默认只到读过的最远位置（防剧透 / 跟上用户节奏）。 */
function scopeOf(id, meta, includeUnread, guard) {
  const furthest = store.getState(id).furthest
  if (includeUnread || !guard || furthest == null) return { max: Infinity, furthest }
  return { max: furthest, furthest }
}

export function createMcpServer(config) {
  const guard = config.spoilerGuard !== false
  const server = new McpServer({ name: 'moread-desk', version: '0.1.0' }, {
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
      furthest_read: state.furthest != null ? sectionName(meta, state.furthest) : null,
      selection: selection ? { section: selection.section, text: selection.text, at: selection.at } : null,
      reading_minutes_today: Math.round((state.readingLog[store.today()] ?? 0) / 60),
      reading_days: days.length,
      pending_questions: store.listInbox().filter(i => !i.seen).length,
      scanned_pdf: meta.scanned || undefined,
      tip: meta.format === 'pdf' ? '需要看页面上的图/公式/代码截图时，用 Read 工具读取 file 并传 pages 参数。' : undefined,
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
    const scope = scopeOf(r.id, r.meta, include_unread, guard)
    const end = Math.min(to ?? from, from + 30)
    if (from > scope.max) return fail(`${sectionName(r.meta, from)} 用户还没读到（最远读到 ${sectionName(r.meta, scope.furthest)}）。如用户同意剧透，可传 include_unread: true。`)
    const picked = sections.filter(s => s.index >= from && s.index <= Math.min(end, scope.max))
    let body = picked.map(s => {
      const head = `【${sectionName(r.meta, s.index)}${s.label && r.meta.format === 'epub' ? ' · ' + s.label : ''}${s.images ? ` · 含 ${s.images} 张图` : ''}】`
      return `${head}\n${s.text || '（本页没有文字层）'}`
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
      ? `\n\n要看图：Read 工具读取 "${getBook(r.id).file}"，pages: "${imgs.map(s => s.index).join(',')}"`
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
    const scope = scopeOf(r.id, r.meta, include_unread, guard)
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
    const scope = scopeOf(r.id, r.meta, include_unread, guard)
    let res
    try { res = grep(sections, pattern, { regex, allow: s => s.index <= scope.max, max }) }
    catch (e) { return fail(`正则无效：${e.message}`) }
    if (!res.total) return text('没有命中。')
    return text(`共 ${res.total} 处${res.total > res.hits.length ? `，显示前 ${res.hits.length} 处` : ''}：\n` +
      res.hits.map(h => `- ${sectionName(r.meta, h.section)}：…${h.context}…`).join('\n'))
  })

  server.registerTool('get_image', {
    description: 'EPUB：返回某一节里的第 n 张图片，供你直接看图。（PDF 请用 Read 工具读页面。）',
    inputSchema: { ...bookArg, section: z.number().int(), n: z.number().int().min(1).optional().describe('第几张，默认 1') },
  }, async ({ book_id, section, n = 1 }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    if (r.meta.format !== 'epub') return fail(`PDF 请用 Read 工具读取 "${getBook(r.id).file}"，pages: "${section}"。`)
    const s = loadBook(r.id).sections[section]
    const p = s?.imagePaths?.[n - 1]
    if (!p) return fail(`第 ${section} 节没有第 ${n} 张图（共 ${s?.imagePaths?.length ?? 0} 张）。`)
    const img = await readEpubImage(getBook(r.id).file, p)
    if (!img) return fail('图片读取失败。')
    if (img.mime === 'image/svg+xml') return text(Buffer.from(img.data, 'base64').toString('utf8').slice(0, 6000))
    return { content: [{ type: 'image', data: img.data, mimeType: img.mime }, { type: 'text', text: `${sectionName(r.meta, section)} 第 ${n}/${s.imagePaths.length} 张：${p}` }] }
  })

  server.registerTool('list_annotations', {
    description: '列出书中的划线和批注（用户的和你的），含讨论回复。',
    inputSchema: { ...bookArg, from: z.number().int().optional(), to: z.number().int().optional(), author: z.enum(['me', 'claude']).optional().describe('me=用户, claude=你') },
  }, async ({ book_id, from, to, author }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const list = store.listAnnotations(r.id)
      .filter(a => (from == null || a.section >= from) && (to == null || a.section <= to) && (!author || a.author === author))
      .sort((a, b) => a.section - b.section)
    if (!list.length) return text('还没有划线或批注。')
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
    },
  }, async ({ book_id, section, quote, note, style = 'wavy', color = 'purple' }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    const s = loadBook(r.id).sections.find(x => x.index === section)
    if (!s) return fail(`没有${sectionName(r.meta, section)}。`)
    const squash = t => normalizeChars(t).replace(/\s+/g, '')
    if (!squash(s.text).includes(squash(quote))) return fail(`${sectionName(r.meta, section)}里找不到这段原文，请用 read_book_section 核对后逐字引用。`)
    const item = store.addAnnotation(r.id, { section, quote, note, style, color, author: 'claude' })
    return text(`已在${sectionName(r.meta, section)}留下批注（id: ${item.id}）。`)
  })

  server.registerTool('reply_annotation', {
    description: '回复某条批注下的讨论（用户在阅读器里回复了你的批注、或在自己的划线下问你时用）。',
    inputSchema: { ...bookArg, annotation_id: z.string(), text: z.string() },
  }, async ({ book_id, annotation_id, text: body }) => {
    const r = resolve(book_id)
    if (r.error) return fail(r.error)
    return store.replyAnnotation(r.id, annotation_id, 'claude', body) ? text('已回复。') : fail('找不到这条批注。')
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
    return text('已发送到阅读器。')
  })

  server.registerTool('get_questions', {
    description: '取出用户在阅读器里发给你的内容（选中文字后的「问 Claude」、伴读面板留言、对批注的回复），取出后标记为已读。',
    inputSchema: {},
  }, async () => {
    const items = store.takeInbox()
    if (!items.length) return text('没有新的提问。')
    return text(items.map(i => {
      const b = getBook(i.bookId)
      const where = b?.meta ? `《${b.meta.title}》${i.section != null ? sectionName(b.meta, i.section) : ''}` : ''
      return { kind: { ask: '选段提问', message: '面板留言', reply: '回复批注' }[i.kind] ?? i.kind, book_id: i.bookId, where, quote: i.quote, text: i.text, annotation_id: i.annotationId, at: i.at }
    }))
  })

  return server
}
