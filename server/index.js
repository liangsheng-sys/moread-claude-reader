// 墨知桌面：本地阅读器 + 给 Claude Code 的 MCP 伴读接口。只监听 127.0.0.1。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './mcp.js'
import { initStore, flushAll, events } from './store.js'
import * as store from './store.js'
import { initLibrary, scan, listBooks, getBook, summary, currentBookId, getLibraryDir, loadBook } from './library.js'
import { initEmbedding } from './embed.js'
import { getSettings, initSettings, updateSettings } from './settings.js'
import * as proactive from './proactive.js'
import { computeStats } from './stats.js'
import { deleteMemory, getBookSummary, listMemories, MEMORY_KINDS } from './memory.js'
import * as knowledge from './knowledge.js'
import { grep } from './search.js'
import { exportBookMarkdown } from './export.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = {
  port: 8848,
  libraryDir: '../书库',
  dataDir: './data',
  spoilerGuard: true,
  embedding: { enabled: true, model: 'Xenova/multilingual-e5-small', dtype: 'q8' },
  ...JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')),
}
// 调试：MOREAD_DATA_DIR 指向一份数据副本、MOREAD_PORT 换个端口，不碰真实的阅读记录。
// 必须两个一起用：伴读监听（scripts/watch.mjs）发现默认端口上的服务停了会立刻用真实数据重新拉起。
const dataDir = path.resolve(root, process.env.MOREAD_DATA_DIR || config.dataDir)
if (process.env.MOREAD_PORT) config.port = Number(process.env.MOREAD_PORT)
initStore(dataDir)
initSettings({ spoilerGuard: config.spoilerGuard })
initEmbedding(config.embedding)
initLibrary(path.resolve(root, config.libraryDir))

const app = express()
const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`])

// 防止其他网页借浏览器访问本地接口（DNS rebinding / 跨站请求）
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host)) return res.status(403).end()
  const origin = req.headers.origin
  if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return res.status(403).end()
  next()
})
app.use(express.json({ limit: '2mb' }))

const chars = s => [...(s ?? '')].length
const unitOf = b => b?.meta?.format === 'pdf' ? '页' : '节'

// ---------- MCP（无状态 Streamable HTTP） ----------

app.post('/mcp', async (req, res) => {
  const server = createMcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close(); server.close() })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('[MCP]', e)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null })
  }
})
app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end())

// ---------- 书库与阅读 ----------

const bookOr404 = (req, res) => {
  const book = getBook(req.params.id)
  if (!book) res.status(404).json({ error: '书籍不存在' })
  return book
}

app.get('/api/books', (req, res) => res.json({ libraryDir: getLibraryDir(), books: listBooks() }))
app.post('/api/rescan', (req, res) => res.json({ books: scan(true) }))

app.get('/api/books/:id', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  res.json({ ...summary(book), toc: book.meta?.toc ?? [], chapters: book.meta ? proactive.chaptersOf(book.meta) : [], state: store.getState(book.id) })
})

app.get('/api/books/:id/file', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.sendFile(book.file)
})

app.post('/api/books/:id/progress', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  const { section, fraction, label, tocLabel, cfi, activeSeconds } = req.body
  if (Number.isInteger(section)) {
    const prev = store.getState(book.id).progress?.section ?? null
    store.updateProgress(book.id, { section, fraction, label, tocLabel, cfi })
    proactive.onProgress(book.id, prev, section)
  }
  if (activeSeconds) {
    store.addReadingTime(book.id, activeSeconds)
    proactive.onHeartbeat(book.id, Math.min(activeSeconds, 120))
  }
  res.json({ ok: true })
})

app.post('/api/books/:id/selection', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  const g = store.load(null, 'global', {})
  g.selection = req.body.text ? { bookId: book.id, section: req.body.section, text: String(req.body.text).slice(0, 2000), at: store.now() } : null
  store.save(null, 'global', g)
  res.json({ ok: true })
})

// 用户自己的书内搜索：不受防剧透限制（书是用户的）
app.get('/api/books/:id/search', async (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  const entry = loadBook(book.id)
  const q = String(req.query.q ?? '').trim()
  if (!entry) return res.status(409).json({ error: '还在解析中' })
  if (!q) return res.json({ exact: [], total: 0, related: [] })
  const { hits, total } = grep(entry.sections, q, { max: 100, context: 30 })
  let related = []
  try {
    const exactSections = new Set(hits.map(h => h.section))
    related = (await entry.index.search(q, { topK: 8 })).results
      .filter(r => !exactSections.has(r.section)).slice(0, 5)
      .map(r => ({ section: r.section, text: r.text.slice(0, 160) }))
  } catch { /* 语义检索失败不影响精确结果 */ }
  res.json({ exact: hits, total, related })
})

// ---------- 批注 / 笔记 / 对话 ----------

app.get('/api/books/:id/annotations', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.json(store.listAnnotations(book.id))
})
app.post('/api/books/:id/annotations', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  const { section, quote, note, style, color, cfi } = req.body
  res.json(store.addAnnotation(book.id, { section, quote, note: note ?? '', style, color, cfi, author: 'me' }))
})
app.patch('/api/books/:id/annotations/:ann', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  const patch = {}
  for (const k of ['note', 'style', 'color', 'cfi']) if (k in req.body) patch[k] = req.body[k]
  const item = store.updateAnnotation(book.id, req.params.ann, patch)
  item ? res.json(item) : res.status(404).end()
})
app.delete('/api/books/:id/annotations/:ann', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.json({ ok: store.deleteAnnotation(book.id, req.params.ann) })
})
app.post('/api/books/:id/annotations/:ann/replies', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  const item = store.replyAnnotation(book.id, req.params.ann, 'me', req.body.text)
  if (!item) return res.status(404).end()
  store.pushInbox({ bookId: book.id, kind: 'reply', section: item.section, quote: item.quote, text: req.body.text, annotationId: item.id })
  store.logExchange({ role: 'user', kind: 'chat', source: 'reader', bookId: book.id, chars: chars(req.body.text) })
  res.json(item)
})

app.get('/api/books/:id/notes', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.json(store.listNotes(book.id))
})
app.post('/api/books/:id/notes', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.json(store.writeNote(book.id, { noteId: req.body.id, title: req.body.title, content: req.body.content, author: 'me' }))
})

app.get('/api/books/:id/messages', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.json(store.listMessages(book.id))
})
// 阅读器里发给 Claude：选段提问（带 quote）或面板留言
app.post('/api/books/:id/ask', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  const { section, quote, text } = req.body
  const msg = store.addMessage(book.id, 'user', text || '（请看这段）', { section, quote })
  store.pushInbox({ bookId: book.id, kind: quote ? 'ask' : 'message', section, quote, text })
  store.logExchange({ role: 'user', kind: 'chat', source: 'reader', bookId: book.id, chars: chars(text || quote) })
  res.json(msg)
})

// ---------- 书的知识：学习摘要 / 大纲 / 术语 / 书签 ----------

app.get('/api/books/:id/knowledge', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  res.json({
    summary: getBookSummary(book.id),
    outlines: knowledge.listOutlines(book.id),
    terms: knowledge.listTerms(book.id),
    bookmarks: knowledge.listBookmarks(book.id),
    memories: listMemories().filter(m => m.bookId === book.id).map(({ vector, ...m }) => m),
  })
})
app.post('/api/books/:id/bookmarks', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.json(knowledge.addBookmark(book.id, req.body))
})
app.delete('/api/books/:id/bookmarks/:bm', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.json({ ok: knowledge.deleteBookmark(book.id, req.params.bm) })
})
app.delete('/api/books/:id/terms/:term', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.json({ ok: knowledge.deleteTerm(book.id, req.params.term) })
})

app.get('/api/books/:id/export.md', (req, res) => {
  const book = bookOr404(req, res)
  if (!book?.meta) return
  const name = `${book.meta.title}·读书笔记.md`
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.type('text/markdown').send(exportBookMarkdown(book))
})

// ---------- 跨书：回顾 / 统计 / 记忆 / 设置 ----------

app.get('/api/review', (req, res) => {
  const books = listBooks().filter(b => b.status.stage !== 'queued')
  const annotations = [], notes = []
  for (const b of books) {
    for (const a of store.listAnnotations(b.id)) annotations.push({ ...a, bookId: b.id })
    for (const n of store.listNotes(b.id)) notes.push({ ...n, bookId: b.id })
  }
  res.json({ books: books.map(b => ({ id: b.id, title: b.title, format: b.format })), annotations, notes })
})
// 回顾页：把选中的划线交给 Claude（点评、串联、写总结）
app.post('/api/review/ask', (req, res) => {
  const { text, items = [] } = req.body
  const picked = items.map(({ bookId, id }) => {
    const a = store.listAnnotations(bookId).find(x => x.id === id)
    return a && `- 《${getBook(bookId)?.meta?.title}》第${a.section}${unitOf(getBook(bookId))}：「${a.quote}」${a.note ? `（批注：${a.note}）` : ''}`
  }).filter(Boolean)
  const bookId = items[0]?.bookId ?? null
  store.pushInbox({ bookId, kind: 'message', text: `${text || '请看看我挑的这些划线'}\n\n${picked.join('\n')}` })
  if (bookId) store.addMessage(bookId, 'user', `${text || '请看看我挑的这些划线'}（附 ${picked.length} 条划线）`)
  store.logExchange({ role: 'user', kind: 'chat', source: 'reader', bookId, chars: chars(text) })
  res.json({ ok: true, count: picked.length })
})

app.get('/api/stats', (req, res) => {
  const p = req.query.period === 'all' || !req.query.period ? null : Number(req.query.period)
  res.json(computeStats(p))
})

app.get('/api/memories', (req, res) => res.json({ kinds: MEMORY_KINDS, memories: listMemories().map(({ vector, ...m }) => ({ ...m, bookTitle: m.bookId ? getBook(m.bookId)?.meta?.title : null })) }))
app.delete('/api/memories/:id', (req, res) => res.json({ ok: deleteMemory(req.params.id) }))

app.get('/api/settings', (req, res) => res.json({ settings: getSettings(), quota: proactive.quotaStatus() }))
app.post('/api/settings', (req, res) => res.json({ settings: updateSettings(req.body), quota: proactive.quotaStatus() }))
app.get('/api/status', (req, res) => res.json(proactive.quotaStatus()))

// ---------- 终端侧（hooks） ----------

// UserPromptSubmit：返回当前阅读状态，同时把这句终端发言记入陪伴足迹（仅当用户最近在读书）
let lastTerminalPrompt = 0
app.all('/api/context', (req, res) => {
  const id = currentBookId()
  const lines = []
  let reading = false
  if (id) {
    const b = getBook(id)
    const s = summary(b)
    const p = s.progress
    const state = store.getState(id)
    reading = Date.now() - Date.parse(state.lastActiveAt ?? p?.updatedAt ?? 0) < 30 * 60000
    if (b.meta && p) {
      const where = `第${p.section}${unitOf(b)}/共${s.sectionCount}${unitOf(b)}`
      const minutesAgo = Math.round((Date.now() - Date.parse(p.updatedAt)) / 60000)
      const chapter = p.tocLabel ?? b.meta.toc.filter(t => t.section != null && t.section <= p.section).pop()?.title
      lines.push(`[墨知伴读] 用户正在读《${s.title}》${where}（${Math.round((p.fraction ?? 0) * 100)}%）${chapter ? ` · ${chapter}` : ''} · ${minutesAgo <= 1 ? '刚刚还在读' : `${minutesAgo} 分钟前`} · book_id=${id}`)
    }
    const sel = store.load(null, 'global', {}).selection
    if (sel?.bookId === id && Date.now() - Date.parse(sel.at) < 30 * 60000) lines.push(`[墨知伴读] 选中的文字（第${sel.section}${unitOf(b)}）：「${sel.text.slice(0, 300)}」`)
  }
  const pending = store.pendingInbox({ questionsOnly: true })
  if (pending.length) lines.push(`[墨知伴读] 阅读器里有 ${pending.length} 条发给你的消息，调用 get_questions 查看。`)
  const promptChars = Number(req.body?.promptChars ?? 0)
  if (req.method === 'POST' && promptChars > 0 && reading) {
    lastTerminalPrompt = Date.now()
    store.logExchange({ role: 'user', kind: 'chat', source: 'terminal', bookId: id, chars: promptChars })
  }
  res.type('text/plain').send(lines.join('\n'))
})

// Stop：Claude 在终端答完一轮，记下回复字数（只配对读书期间的终端发言）
app.post('/api/footprint/reply', (req, res) => {
  const n = Number(req.body?.chars ?? 0)
  if (n > 0 && Date.now() - lastTerminalPrompt < 30 * 60000) {
    store.logExchange({ role: 'claude', kind: 'chat', source: 'terminal', bookId: currentBookId(), chars: n })
  }
  res.json({ ok: true })
})

// ---------- channel 桥接 ----------

// 待投递的消息（已格式化）。主动陪读事件原样投递，用户消息加上来源说明。
app.get('/api/inbox/pending', (req, res) => {
  res.json(store.pendingInbox().map(i => {
    const meta = { kind: i.kind, book_id: i.bookId ?? '' }
    if (i.section != null) meta.section = String(i.section)
    if (i.kind === 'event') {
      meta.event = i.event
      if (i.taskId) meta.task_id = i.taskId
      return { id: i.id, content: i.text, meta }
    }
    const b = getBook(i.bookId)
    const where = b?.meta ? `《${b.meta.title}》${i.section != null ? `第${i.section}${unitOf(b)}` : ''}` : '阅读器'
    const lines = [{ ask: `在${where}选中了一段问你：`, message: `在${where}给你留言：`, reply: `回复了你在${where}的批注：` }[i.kind] ?? where]
    if (i.quote) lines.push(`> ${i.quote.replace(/\n/g, '\n> ')}`)
    lines.push(i.text || '（没写问题，请讲讲这段）')
    if (i.annotationId) meta.annotation_id = i.annotationId
    return { id: i.id, content: lines.join('\n'), meta }
  }))
})
app.post('/api/inbox/ack', (req, res) => {
  const ids = new Set(req.body.ids ?? [])
  const list = store.listInbox()
  for (const i of list) if (ids.has(i.id)) i.seen = true
  store.save(null, 'inbox', list)
  res.json({ ok: true })
})

// 实时推送（Claude 留批注 / 说话时阅读器立即刷新）。channel 桥接连接时带 ?client=channel，用来判断 Claude 是否在线。
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()
  const isChannel = req.query.client === 'channel'
  const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`)
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  events.on('change', send)
  if (isChannel) proactive.setChannelClient(1)
  req.on('close', () => {
    clearInterval(ping)
    events.off('change', send)
    if (isChannel) proactive.setChannelClient(-1)
  })
})

// ---------- 静态资源 ----------

app.use('/vendor/foliate', express.static(path.join(root, 'vendor/foliate-js')))
app.use('/vendor/pdfjs', express.static(path.join(root, 'node_modules/pdfjs-dist')))
app.use('/vendor/marked', express.static(path.join(root, 'node_modules/marked/lib')))
app.use(express.static(path.join(root, 'web')))

scan()
setInterval(() => { try { scan() } catch (e) { console.error(e) } }, 30000)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushAll(); process.exit(0) })
process.on('exit', flushAll)

app.listen(config.port, '127.0.0.1', () => {
  console.log(`墨知桌面已启动：http://127.0.0.1:${config.port}`)
  console.log(`书库目录：${getLibraryDir()}（放入 PDF / EPUB 即可，30 秒自动扫描）`)
  console.log(`MCP 接口：http://127.0.0.1:${config.port}/mcp`)
})
