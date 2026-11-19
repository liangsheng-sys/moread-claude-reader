// 书库：扫描目录、后台解析 / 建索引、按需加载。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { extractBook } from './extract.js'
import { chunkSections, BookIndex } from './search.js'
import { embeddingEnabled, embedPassages } from './embed.js'
import { bookDir, events, getState, load, save } from './store.js'
import { loadOcr, ocrPageText, ocrStatus, OCR_ENGINE } from './ocr.js'

const EXTRACT_VERSION = 2
// 书名 / 作者：PDF 自带的信息常常是制作软件的名字（超星的「ssreader」、Word 的文件名……），
// 这种就改用文件名。z-library 式文件名「书名 (作者) (z-library.sk, …)」拆成书名和作者。
const JUNK = /^(ssreader|pdg\S*|untitled|unknown|anonymous|admin(istrator)?|user|无标题|未命名|microsoft word\b.*|.*\.(docx?|pdf|indd|tiff?|jpe?g|txt)|[\d\s_-]+)$/i
const junk = s => !s?.trim() || JUNK.test(s.trim())
export function parseFileName(file) {
  let name = path.basename(file, path.extname(file)).replace(/\s*\((z-library|z-lib|1lib)[^()]*\)\s*$/i, '').trim()
  let author = ''
  // 末尾的一对括号（可能嵌套）是作者
  if (/[)）]$/.test(name)) {
    let depth = 0
    for (let i = name.length - 1; i >= 0; i--) {
      const c = name[i]
      if (c === ')' || c === '）') depth++
      else if ((c === '(' || c === '（') && --depth === 0) {
        if (i > 0) { author = name.slice(i + 1, -1).trim(); name = name.slice(0, i).trim() }
        break
      }
    }
  }
  return { title: name.replace(/_/g, ' ').replace(/\s{2,}/g, ' '), author }
}
function fixTitle(meta, file) {
  const fromFile = parseFileName(file)
  const before = `${meta.title}|${meta.author}`
  if (junk(meta.title) || /z-library|z-lib\.|1lib\./i.test(meta.title)) meta.title = fromFile.title
  if (junk(meta.author)) meta.author = fromFile.author
  return before !== `${meta.title}|${meta.author}`
}

// 重建的目录（Claude 根据书里印的目录页生成，或以后用户手动改）存在 toc.json，原目录留在 meta.tocOriginal。
// 只要 meta 被重新加载或重新解析，就再套一次，保证所有地方（阅读器、章节划分、Claude 的工具）用的是同一份目录。
const tocPath = id => path.join(bookDir(id), 'toc.json')
export const loadTocOverride = id => { try { return JSON.parse(fs.readFileSync(tocPath(id), 'utf8')) } catch { return null } }
function applyToc(id, meta) {
  if (!meta) return meta
  if (!meta.tocOriginal) meta.tocOriginal = meta.toc
  const o = loadTocOverride(id)
  meta.toc = o?.entries?.length ? o.entries : meta.tocOriginal
  meta.tocSource = o?.entries?.length ? o.source : 'book'
  return meta
}
/** 保存重建的目录；entries 为空则恢复书自带的目录。 */
export function setTocOverride(id, entries, source = 'claude') {
  const book = books.get(id)
  if (!book?.meta) return null
  if (entries?.length) fs.writeFileSync(tocPath(id), JSON.stringify({ source, entries, createdAt: new Date().toISOString() }))
  else fs.rmSync(tocPath(id), { force: true })
  applyToc(id, book.meta)
  events.emit('change', { type: 'toc', bookId: id })
  return book.meta.toc
}

// 有可检索的文字：本来就有文字层，或者已经本机识别过
const hasText = meta => !meta.scanned || !!meta.ocr
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
      if (retryVectors && prev.meta && embeddingEnabled() && !prev.meta.status.vectors && hasText(prev.meta)) enqueue(id)
      continue
    }
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(path.join(bookDir(id), 'meta.json'), 'utf8')) } catch {}
    const fresh = meta && meta.size === stat.size && meta.mtime === stat.mtimeMs && meta.version === EXTRACT_VERSION
    if (fresh && fixTitle(meta, file)) fs.writeFileSync(path.join(bookDir(id), 'meta.json'), JSON.stringify(meta))
    if (fresh) applyToc(id, meta)
    const book = { id, file, rel, size: stat.size, mtime: stat.mtimeMs, meta: fresh ? meta : null, status: fresh ? meta.status : { stage: 'queued' } }
    books.set(id, book)
    loaded.delete(id)
    if (!fresh) enqueue(id)
    else if (embeddingEnabled() && !meta.status.vectors && hasText(meta)) enqueue(id)
  }
  for (const id of books.keys()) if (!seen.has(id)) { books.delete(id); loaded.delete(id) }
  return listBooks()
}

export function listBooks() {
  return [...books.values()].map(summary).sort((a, b) => (b.lastOpened ?? '').localeCompare(a.lastOpened ?? '') || a.title.localeCompare(b.title))
}

// ---------- 读完 ----------
// 读到正文结尾就算读完：书末的参考文献、索引、致谢之类不要求翻完。重翻时进度照常记录，但「已读完」不会消失。
const BACK_MATTER = /^\s*(参考文献|参考书目|索引|致谢|鸣谢|注释|译名对照|术语表|出版后记|版权|bibliography|references|index|acknowledg|notes|glossary|about the author|作者简介)/i
export function endOfBody(meta) {
  if (!meta) return null
  const last = meta.sectionBase + meta.sectionCount - 1
  const tail = meta.toc.filter(t => t.section != null && t.depth === 0 && t.section > meta.sectionBase + meta.sectionCount * 0.7)
  const back = tail.find(t => BACK_MATTER.test(t.title))
  return back ? Math.max(meta.sectionBase, back.section - 1) : last
}
/** 进度变化时检查：最远位置第一次越过正文结尾，就标记读完（之后手动取消也不会被自动改回来）。 */
export function checkFinished(id, prevFurthest) {
  const book = books.get(id)
  const state = getState(id)
  const end = endOfBody(book?.meta)
  if (end == null || state.finished || state.furthest == null || state.furthest < end) return false
  if (prevFurthest != null && prevFurthest >= end) return false
  state.finished = { at: new Date().toISOString(), by: 'auto' }
  save(id, 'state', state)
  return true
}
export function setFinished(id, on) {
  const state = getState(id)
  state.finished = on ? { at: new Date().toISOString(), by: 'me' } : false
  save(id, 'state', state)
  events.emit('change', { type: 'book', bookId: id })
  return state.finished
}

export function summary(book) {
  const state = getState(book.id)
  const m = book.meta
  // 0.5.0 之前读完的书：补记一次（finished 为 false 表示用户手动取消过）
  if (state.finished === undefined && m && state.furthest != null && state.furthest >= endOfBody(m)) {
    state.finished = { at: state.lastActiveAt ?? state.lastOpened ?? new Date().toISOString(), by: 'auto' }
    save(book.id, 'state', state)
  }
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
    ocr: m?.format === 'pdf' && m?.scanned ? { engine: m.ocr?.engine ?? null, ...(ocrStatus(book.id) ?? { stage: 'none' }) } : null,
    status: book.status,
    progress: state.progress,
    furthest: state.furthest,
    finished: state.finished || null,
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
    // 重新解析时把之前本机识别的文字并回去
    const ocr = loadOcr(book.id)
    if (ocr) mergeOcr(data.sections, ocr)
    const chunks = chunkSections(data.sections)
    fs.writeFileSync(path.join(dir, 'sections.json'), JSON.stringify(data.sections))
    fs.writeFileSync(path.join(dir, 'chunks.json'), JSON.stringify(chunks))
    fs.rmSync(path.join(dir, 'vectors.bin'), { force: true })
    const { sections, ...rest } = data
    if (ocr) rest.ocr = ocrMeta(ocr)
    fixTitle(rest, book.file)
    meta = { ...rest, version: EXTRACT_VERSION, size: book.size, mtime: book.mtime, chunkCount: chunks.length, status: { stage: 'ready', vectors: false } }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
    book.meta = applyToc(book.id, meta)
    loaded.delete(book.id)
    console.log(`[书库] 已解析《${meta.title}》${meta.sectionCount}${meta.sectionUnit}，${chunks.length} 块，${Date.now() - t0}ms`)
    setStatus(book, meta.status)
  }
  if (embeddingEnabled() && !meta.status.vectors && hasText(meta) && meta.chunkCount > 0) {
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

function mergeOcr(sections, ocr) {
  for (const s of sections) {
    const lines = ocr.pages[s.index]
    if (lines && (s.ocr || (s.text ?? '').trim().length < 20)) { s.text = ocrPageText(lines); s.ocr = true }
  }
}
const ocrMeta = ocr => ({ engine: OCR_ENGINE, local: true, pages: Object.keys(ocr.pages).length, complete: !!ocr.complete, updatedAt: new Date().toISOString() })

/** 把识别结果并入正文、重建词法索引；识别全部完成后再排队建向量（中途建了也会被下一批作废）。 */
export function applyOcrText(id, ocr, { complete }) {
  const book = books.get(id)
  if (!book?.meta) return
  const dir = bookDir(id)
  const sections = JSON.parse(fs.readFileSync(path.join(dir, 'sections.json'), 'utf8'))
  mergeOcr(sections, ocr)
  const chunks = chunkSections(sections)
  fs.writeFileSync(path.join(dir, 'sections.json'), JSON.stringify(sections))
  fs.writeFileSync(path.join(dir, 'chunks.json'), JSON.stringify(chunks))
  fs.rmSync(path.join(dir, 'vectors.bin'), { force: true })
  const meta = book.meta
  meta.ocr = ocrMeta(ocr)
  meta.chunkCount = chunks.length
  meta.status = { stage: 'ready', vectors: false }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
  loaded.delete(id)
  setStatus(book, meta.status)
  if (complete) enqueue(id)
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
