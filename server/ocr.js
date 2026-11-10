// 扫描版 PDF 的本机文字识别（RapidOCR，scripts/ocr.py）。一次只跑一本，排队处理。
// 结果存 data/books/<id>/ocr.json，原 PDF 不改：
//   - 识别出的文字并入 sections.json（检索、Claude 读原文、随读批注都用它），重新解析也会再并回去
//   - 每行的位置交给阅读器，叠成一层透明文字，扫描页上也能选中、划线
// 服务中途重启时，没识别完的书会接着从断点继续。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applyOcrText, getBook } from './library.js'
import { joinLines, tidy } from './extract.js'
import { bookDir, events, getState } from './store.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const OCR_ENGINE = 'RapidOCR'
const MIN_SCORE = 0.5
let python = 'python'
const jobs = new Map()   // id -> { stage: 'queued' | 'running', done, total, child? }
const queue = []
let working = false

const ocrPath = id => path.join(bookDir(id), 'ocr.json')
export function loadOcr(id) {
  try { return JSON.parse(fs.readFileSync(ocrPath(id), 'utf8')) } catch { return null }
}
const saveOcr = (id, data) => fs.writeFileSync(ocrPath(id), JSON.stringify(data))

/** 一页的识别结果 → 正文（与 PDF 文字层同样的分段规则）。 */
export function ocrPageText(lines) {
  const ok = lines.filter(l => l.s >= MIN_SCORE && l.t.trim())
    .sort((a, b) => (Math.abs(a.b[1] - b.b[1]) < 0.006 ? a.b[0] - b.b[0] : a.b[1] - b.b[1]))
  // OCR 的行框紧贴字形，比排版字号小，直接当行高会把普通行距误判成分段。
  // 改用本页常见的行距（中位数）推算行高：正常行距 < 1.9 倍行高，段间距才会超过。
  const gaps = ok.slice(1).map((l, i) => l.b[3] - ok[i].b[3]).filter(g => g > 0).sort((a, b) => a - b)
  const pitch = gaps.length >= 3 ? gaps[gaps.length >> 1] * 1000 : null
  // 页眉页码常常比正文更靠边：正文的左右边界取长行（超过半页宽）的中位数
  const median = xs => xs.sort((a, b) => a - b)[xs.length >> 1]
  const long = ok.filter(l => l.b[2] - l.b[0] > 0.5)
  const margins = long.length >= 3 ? { left: median(long.map(l => l.b[0] * 1000)), right: median(long.map(l => l.b[2] * 1000)) } : {}
  // 换成「向上为正」的坐标，单位为页面的千分之一
  return tidy(joinLines(ok.map(l => ({ text: l.t, y: -l.b[3] * 1000, h: pitch ? pitch / 1.5 : (l.b[3] - l.b[1]) * 1000, x0: l.b[0] * 1000, x1: l.b[2] * 1000 })), margins))
}

/** 给阅读器画透明文字层用：{ 页码: [{ t, b }] } */
export function ocrLayer(id) {
  const data = loadOcr(id)
  if (!data) return {}
  const out = {}
  for (const [n, lines] of Object.entries(data.pages)) out[n] = lines.filter(l => l.s >= MIN_SCORE).map(({ t, b }) => ({ t, b }))
  return out
}

export function ocrStatus(id) {
  const job = jobs.get(id)
  if (job) return { stage: job.stage, done: job.done, total: job.total }
  const data = loadOcr(id)
  if (!data) return null
  return { stage: data.error ? 'error' : data.complete ? 'done' : 'paused', done: Object.keys(data.pages).length, error: data.error }
}

const notify = id => events.emit('change', { type: 'book', bookId: id, ocr: ocrStatus(id) })

export function initOcr(cfg = {}) {
  python = cfg.python || 'python'
  // 接着跑上次没跑完的
  for (const dir of fs.existsSync(bookDir('')) ? fs.readdirSync(bookDir('')) : []) {
    const data = loadOcr(dir)
    if (data?.wanted && !data.complete && getBook(dir)) startOcr(dir)
  }
}

export function startOcr(id) {
  const book = getBook(id)
  if (!book?.meta) throw new Error('书还在解析中')
  if (book.meta.format !== 'pdf') throw new Error('只有 PDF 需要识别文字')
  if (jobs.has(id)) return ocrStatus(id)
  const data = loadOcr(id) ?? { engine: OCR_ENGINE, pages: {} }
  data.wanted = true
  delete data.error
  saveOcr(id, data)
  jobs.set(id, { stage: 'queued', done: Object.keys(data.pages).length, total: book.meta.sectionCount })
  queue.push(id)
  notify(id)
  if (!working) runQueue()
  return ocrStatus(id)
}

export function cancelOcr(id) {
  const job = jobs.get(id)
  if (!job) return false
  const i = queue.indexOf(id)
  if (i >= 0) queue.splice(i, 1)
  job.cancelled = true
  job.child?.kill()
  const data = loadOcr(id)
  if (data) { data.wanted = false; saveOcr(id, data) }
  if (job.stage === 'queued') { jobs.delete(id); notify(id) }
  return true
}

async function runQueue() {
  working = true
  while (queue.length) {
    const id = queue.shift()
    try { await runBook(id) }
    catch (e) {
      console.error(`[识别] 失败 ${id}:`, e.message)
      const data = loadOcr(id)
      if (data) { data.error = e.message; data.wanted = false; saveOcr(id, data) }
    }
    jobs.delete(id)
    notify(id)
  }
  working = false
}

async function runBook(id) {
  const book = getBook(id)
  const job = jobs.get(id)
  if (!book?.meta || job.cancelled) return
  const data = loadOcr(id)
  const sections = JSON.parse(fs.readFileSync(path.join(bookDir(id), 'sections.json'), 'utf8'))
  // 已经有文字层的页、已经识别过的页都跳过；从用户读到的地方往后先做，读书的人很快就能用上
  const start = getState(id).progress?.section ?? 1
  const todo = sections.filter(s => !data.pages[s.index] && (s.ocr || (s.text ?? '').trim().length < 20)).map(s => s.index)
    .sort((a, b) => (a >= start) === (b >= start) ? a - b : a >= start ? -1 : 1)
  job.total = Object.keys(data.pages).length + todo.length
  job.stage = 'running'
  notify(id)
  if (!todo.length) return finish(id, data, book)

  const t0 = Date.now()
  console.log(`[识别] 开始《${book.meta.title}》${todo.length} 页`)
  const child = spawn(python, [path.join(root, 'scripts/ocr.py'), book.file, todo.join(',')], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  job.child = child
  // 让出 CPU：用户一边读书，识别在后台慢慢跑
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  let stderr = ''
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000) })
  const exited = new Promise((res, rej) => {
    child.on('error', e => rej(new Error(e.code === 'ENOENT' ? `找不到 Python（${python}）` : e.message)))
    child.on('close', code => res(code))
  })
  let sinceApply = 0, applied = 0, lastNotify = 0
  for await (const line of readline.createInterface({ input: child.stdout })) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    data.pages[r.page] = r.lines
    job.done = Object.keys(data.pages).length
    sinceApply++
    if (sinceApply % 5 === 0) saveOcr(id, data)
    // 先并入前 10 页，之后每 40 页一次：一边识别一边就能检索、让 Claude 读
    if (sinceApply >= (applied ? 40 : 10)) {
      saveOcr(id, data)
      applyOcrText(id, data, { complete: false })
      sinceApply = 0
      applied++
    }
    if (Date.now() - lastNotify > 2000) { lastNotify = Date.now(); notify(id) }
  }
  const code = await exited
  saveOcr(id, data)
  if (job.cancelled) {
    applyOcrText(id, data, { complete: false })
    console.log(`[识别] 已暂停《${book.meta.title}》${job.done}/${job.total}`)
    return
  }
  if (code !== 0) {
    applyOcrText(id, data, { complete: false })
    throw new Error(stderr.trim().split('\n').pop() || `识别进程退出（${code}）`)
  }
  console.log(`[识别] 完成《${book.meta.title}》${todo.length} 页，${Math.round((Date.now() - t0) / 1000)}s`)
  finish(id, data, book)
}

function finish(id, data, book) {
  data.complete = true
  data.wanted = false
  data.finishedAt = new Date().toISOString()
  saveOcr(id, data)
  applyOcrText(id, data, { complete: true })
}
