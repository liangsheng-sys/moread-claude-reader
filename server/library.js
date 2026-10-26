// 书库：扫描目录、后台解析 / 建索引、按需加载。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { extractBook } from './extract.js'
import { chunkSections, BookIndex } from './search.js'
import { embeddingEnabled, embedPassages } from './embed.js'
import { bookDir, events, getState, load } from './store.js'

const EXTRACT_VERSION = 2
let libraryDir = ''
const books = new Map()      // id -> { id, file, rel, size, mtime, meta, status }
const loaded = new Map()     // id -> { sections, index }
const queue = []
let working = false

export function initLibrary(dir) {
  libraryDir = dir
  fs.mkdirSync(libraryDir, { recursive: true })
}

export const getLibraryDir = () => libraryDir

export function scan(retryVectors = false) {
  const found = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(pdf|epub)$/i.test(e.name)) found.push(full)
    }
  }
  walk(libraryDir)
  const seen = new Set()
  for (const file of found) {
    const rel = path.relative(libraryDir, file).split(path.sep).join('/')
    const id = createHash('sha1').update(rel).digest('hex').slice(0, 12)
    seen.add(id)
    const stat = fs.statSync(file)
    const prev = books.get(id)
    if (prev && prev.size === stat.size && prev.mtime === stat.mtimeMs) {
      if (retryVectors && prev.meta && embeddingEnabled() && !prev.meta.status.vectors && !prev.meta.scanned) enqueue(id)
      continue
    }
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(path.join(bookDir(id), 'meta.json'), 'utf8')) } catch {}
    const fresh = meta && meta.size === stat.size && meta.mtime === stat.mtimeMs && meta.version === EXTRACT_VERSION
    const book = { id, file, rel, size: stat.size, mtime: stat.mtimeMs, meta: fresh ? meta : null, status: fresh ? meta.status : { stage: 'queued' } }
    books.set(id, book)
    loaded.delete(id)
    if (!fresh) enqueue(id)
    else if (embeddingEnabled() && !meta.status.vectors && !meta.scanned) enqueue(id)
  }
  for (const id of books.keys()) if (!seen.has(id)) { books.delete(id); loaded.delete(id) }
  return listBooks()
}

export function listBooks() {
  return [...books.values()].map(summary).sort((a, b) => (b.lastOpened ?? '').localeCompare(a.lastOpened ?? '') || a.title.localeCompare(b.title))
}

export function summary(book) {
  const state = getState(book.id)
  const m = book.meta
  return {
    id: book.id,
    title: m?.title ?? path.basename(book.rel),
    author: m?.author ?? '',
    format: m?.format ?? path.extname(book.rel).slice(1).toLowerCase(),
    path: book.file,
    sectionCount: m?.sectionCount ?? null,
    sectionBase: m?.sectionBase ?? null,
    sectionUnit: m?.sectionUnit ?? '',
    scanned: m?.scanned ?? false,
    status: book.status,
    progress: state.progress,
    furthest: state.furthest,
    lastOpened: state.lastOpened,
  }
}

export const getBook = id => books.get(id) ?? null

export function currentBookId() {
  const g = load(null, 'global', {})
  return g.currentBook && books.has(g.currentBook) ? g.currentBook : null
}

function enqueue(id) {
  if (!queue.includes(id)) queue.push(id)
  if (!working) runQueue()
}

async function runQueue() {
  working = true
  while (queue.length) {
    const id = queue.shift()
    const book = books.get(id)
    if (!book) continue
    try { await processBook(book) }
    catch (e) {
      book.status = { stage: 'error', error: e.message }
      console.error(`[书库] 处理失败 ${book.rel}:`, e)
      events.emit('change', { type: 'book', bookId: id })
    }
  }
  working = false
}

function setStatus(book, status) {
  book.status = status
  events.emit('change', { type: 'book', bookId: book.id, status })
}

async function processBook(book) {
  const dir = bookDir(book.id)
  fs.mkdirSync(dir, { recursive: true })
  let meta = book.meta
  if (!meta) {
    setStatus(book, { stage: 'extracting' })
    const t0 = Date.now()
    const data = await extractBook(book.file)
    const chunks = chunkSections(data.sections)
    fs.writeFileSync(path.join(dir, 'sections.json'), JSON.stringify(data.sections))
    fs.writeFileSync(path.join(dir, 'chunks.json'), JSON.stringify(chunks))
    fs.rmSync(path.join(dir, 'vectors.bin'), { force: true })
    const { sections, ...rest } = data
    meta = { ...rest, version: EXTRACT_VERSION, size: book.size, mtime: book.mtime, chunkCount: chunks.length, status: { stage: 'ready', vectors: false } }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
    book.meta = meta
    loaded.delete(book.id)
    console.log(`[书库] 已解析《${meta.title}》${meta.sectionCount}${meta.sectionUnit}，${chunks.length} 块，${Date.now() - t0}ms`)
    setStatus(book, meta.status)
  }
  if (embeddingEnabled() && !meta.status.vectors && !meta.scanned && meta.chunkCount > 0) {
    const chunks = JSON.parse(fs.readFileSync(path.join(dir, 'chunks.json'), 'utf8'))
    setStatus(book, { stage: 'embedding', done: 0, total: chunks.length, vectors: false })
    let last = 0
    let vectors
    try {
      vectors = await embedPassages(chunks.map(c => c.text), (done, total) => {
        if (Date.now() - last > 1000) { last = Date.now(); setStatus(book, { stage: 'embedding', done, total, vectors: false }) }
      })
    } catch (e) {
      // 向量是锦上添花：失败时书照常可读，检索退回纯词法；下次启动或重新扫描时再试
      console.error(`[书库] 向量索引失败《${meta.title}》：${e.message}（可运行 npm run fetch-model 手动下载模型）`)
      setStatus(book, { ...meta.status, vectorError: e.message })
      return
    }
    const dim = vectors[0].length
    const buf = new Float32Array(vectors.length * dim)
    vectors.forEach((v, i) => buf.set(v, i * dim))
    fs.writeFileSync(path.join(dir, 'vectors.bin'), Buffer.from(buf.buffer))
    meta.status = { stage: 'ready', vectors: true, dim }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
    loaded.delete(book.id)
    console.log(`[书库] 向量索引完成《${meta.title}》`)
    setStatus(book, meta.status)
  }
}

/** 加载正文与检索索引（解析完成后才可用）。 */
export function loadBook(id) {
  const book = books.get(id)
  if (!book?.meta) return null
  let entry = loaded.get(id)
  if (!entry) {
    const dir = bookDir(id)
    const sections = JSON.parse(fs.readFileSync(path.join(dir, 'sections.json'), 'utf8'))
    const chunks = JSON.parse(fs.readFileSync(path.join(dir, 'chunks.json'), 'utf8'))
    let vectors = null
    const vfile = path.join(dir, 'vectors.bin')
    if (book.meta.status.vectors && fs.existsSync(vfile)) {
      const raw = fs.readFileSync(vfile)
      const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      const dim = book.meta.status.dim
      vectors = chunks.map((_, i) => all.subarray(i * dim, (i + 1) * dim))
    }
    entry = { book, sections, index: new BookIndex(chunks, vectors) }
    loaded.set(id, entry)
  }
  return entry
}
