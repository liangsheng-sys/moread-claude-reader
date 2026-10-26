// 墨知桌面：本地阅读器 + 给 Claude Code 的 MCP 伴读接口。只监听 127.0.0.1。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './mcp.js'
import { initStore, flushAll, events } from './store.js'
import * as store from './store.js'
import { initLibrary, scan, listBooks, getBook, summary, currentBookId, getLibraryDir } from './library.js'
import { initEmbedding } from './embed.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = {
  port: 8848,
  libraryDir: '../书库',
  dataDir: './data',
  spoilerGuard: true,
  embedding: { enabled: true, model: 'Xenova/multilingual-e5-small', dtype: 'q8' },
  ...JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')),
}
const dataDir = path.resolve(root, config.dataDir)
initStore(dataDir)
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

// ---------- MCP（无状态 Streamable HTTP） ----------

app.post('/mcp', async (req, res) => {
  const server = createMcpServer(config)
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

// ---------- 阅读器 API ----------

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
  res.json({ ...summary(book), toc: book.meta?.toc ?? [], state: store.getState(book.id) })
})

app.get('/api/books/:id/file', (req, res) => {
  const book = bookOr404(req, res)
  if (book) res.sendFile(book.file)
})

app.post('/api/books/:id/progress', (req, res) => {
  const book = bookOr404(req, res)
  if (!book) return
  const { section, fraction, label, tocLabel, cfi, activeSeconds } = req.body
  if (Number.isInteger(section)) store.updateProgress(book.id, { section, fraction, label, tocLabel, cfi })
  if (activeSeconds) store.addReadingTime(book.id, activeSeconds)
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
  res.json(msg)
})

// 给 UserPromptSubmit hook 用：每次用户在终端说话时，附上当前阅读状态
app.get('/api/context', (req, res) => {
  const id = currentBookId()
  const lines = []
  if (id) {
    const b = getBook(id)
    const s = summary(b)
    const p = s.progress
    if (b.meta && p) {
      const where = s.format === 'pdf' ? `第${p.section}页/共${s.sectionCount}页` : `第${p.section}节/共${s.sectionCount}节`
      const minutesAgo = Math.round((Date.now() - Date.parse(p.updatedAt)) / 60000)
      const chapter = p.tocLabel ?? b.meta.toc.filter(t => t.section != null && t.section <= p.section).pop()?.title
      lines.push(`[墨知伴读] 用户正在读《${s.title}》${where}（${Math.round((p.fraction ?? 0) * 100)}%）${chapter ? ` · ${chapter}` : ''} · ${minutesAgo <= 1 ? '刚刚还在读' : `${minutesAgo} 分钟前`} · book_id=${id}`)
    }
    const sel = store.load(null, 'global', {}).selection
    if (sel?.bookId === id && Date.now() - Date.parse(sel.at) < 30 * 60000) lines.push(`[墨知伴读] 选中的文字（第${sel.section}${s.format === 'pdf' ? '页' : '节'}）：「${sel.text.slice(0, 300)}」`)
  }
  const pending = store.listInbox().filter(i => !i.seen)
  if (pending.length) lines.push(`[墨知伴读] 阅读器里有 ${pending.length} 条发给你的消息，调用 get_questions 查看。`)
  res.type('text/plain').send(lines.join('\n'))
})

// 给 channel 桥接用：待投递的消息（已格式化）与确认
app.get('/api/inbox/pending', (req, res) => {
  res.json(store.listInbox().filter(i => !i.seen).map(i => {
    const b = getBook(i.bookId)
    const unit = b?.meta?.format === 'pdf' ? '页' : '节'
    const where = b?.meta ? `《${b.meta.title}》${i.section != null ? `第${i.section}${unit}` : ''}` : ''
    const lines = [{ ask: `在${where}选中了一段问你：`, message: `在读${where}时给你留言：`, reply: `回复了你在${where}的批注：` }[i.kind] ?? where]
    if (i.quote) lines.push(`> ${i.quote.replace(/\n/g, '\n> ')}`)
    lines.push(i.text || '（没写问题，请讲讲这段）')
    const meta = { kind: i.kind, book_id: i.bookId }
    if (i.section != null) meta.section = String(i.section)
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

// 实时推送（Claude 留批注 / 说话时阅读器立即刷新）
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()
  const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`)
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  events.on('change', send)
  req.on('close', () => { clearInterval(ping); events.off('change', send) })
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
