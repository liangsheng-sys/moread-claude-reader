// 把 PDF / EPUB 解析成统一的「段」(section) 结构，供检索和 Claude 读取。
// PDF：一页一段，section 从 1 开始（与页码一致）。
// EPUB：一个 spine 条目一段，section 从 0 开始（与 foliate-js 的 book.sections 下标一致）。
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { unzipSync, strFromU8 } from 'fflate'
import { parse as parseHtml } from 'node-html-parser'

const require = createRequire(import.meta.url)
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))

export async function extractBook(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.pdf') return extractPdf(filePath)
  if (ext === '.epub') return extractEpub(filePath)
  throw new Error(`不支持的格式：${ext}`)
}

// ---------- PDF ----------

async function extractPdf(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await fs.readFile(filePath))
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: path.join(pdfjsRoot, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts') + path.sep,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise

  const meta = await doc.getMetadata().catch(() => null)
  const sections = []
  const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject])
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = joinPdfLines(content.items)
    let images = 0
    try {
      const ops = await page.getOperatorList()
      for (const fn of ops.fnArray) if (imageOps.has(fn)) images++
    } catch { /* 个别页面解析失败不影响文字 */ }
    sections.push({ index: i, label: page.pageLabel ?? String(i), text: tidy(text), images })
    page.cleanup()
  }

  const toc = await pdfOutline(doc)
  const title = meta?.info?.Title?.trim() || path.basename(filePath, path.extname(filePath))
  const author = meta?.info?.Author?.trim() || ''
  const textChars = sections.reduce((n, s) => n + s.text.length, 0)
  await doc.destroy()
  return {
    format: 'pdf', title, author, sectionBase: 1, sectionCount: sections.length,
    sectionUnit: '页', toc, sections,
    scanned: textChars < sections.length * 20, // 几乎没有文字层 → 多半是扫描版
  }
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}⺀-⿟　-〿＀-￯]/u

/** 把 pdf.js 的文字项拼成段落：自动换行处接回去，行距明显变大处才分段。 */
function joinPdfLines(items) {
  const lines = []
  let cur = { text: '', y: null, h: 0, x0: Infinity, x1: -Infinity }
  for (const item of items) {
    if (!('str' in item)) continue
    if (item.str) {
      const [, , , d, e, f] = item.transform
      cur.text += item.str
      cur.y = f
      cur.h = Math.max(cur.h, item.height || Math.abs(d))
      cur.x0 = Math.min(cur.x0, e)
      cur.x1 = Math.max(cur.x1, e + item.width)
    }
    if (item.hasEOL && cur.text) {
      lines.push(cur)
      cur = { text: '', y: null, h: 0, x0: Infinity, x1: -Infinity }
    }
  }
  if (cur.text) lines.push(cur)
  return joinLines(lines)
}

/** lines: [{ text, y（基线，向上为正）, h, x0, x1 }]，按阅读顺序排好。OCR 结果也走这里。 */
export function joinLines(lines, margins = {}) {
  if (!lines.length) return ''
  const right = margins.right ?? Math.max(...lines.map(l => l.x1))
  const left = margins.left ?? Math.min(...lines.map(l => l.x0))
  let out = lines[0].text
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1], line = lines[i]
    const gap = prev.y != null && line.y != null ? prev.y - line.y : 0
    const h = Math.max(prev.h, line.h) || 10
    const shortLine = prev.x1 < right - h * 2      // 上一行没写满 → 段落结束
    const indented = line.x0 > left + h * 1.5      // 首行缩进
    const paragraph = gap > h * 1.9 || gap < -h || shortLine || indented
    if (paragraph) out += '\n' + line.text
    else {
      const a = prev.text.at(-1), b = line.text[0]
      out += (CJK.test(a) || CJK.test(b) || a === '-' ? '' : ' ') + line.text
    }
  }
  return out
}

async function pdfOutline(doc) {
  const outline = await doc.getOutline().catch(() => null)
  if (!outline) return []
  const out = []
  const walk = async (items, depth) => {
    for (const item of items) {
      let section = null
      try {
        let dest = item.dest
        if (typeof dest === 'string') dest = await doc.getDestination(dest)
        if (Array.isArray(dest)) section = (await doc.getPageIndex(dest[0])) + 1
      } catch { /* 目录项指向无效位置时保留标题 */ }
      out.push({ title: item.title, section, depth })
      if (item.items?.length) await walk(item.items, depth + 1)
    }
  }
  await walk(outline, 0)
  return out
}

// ---------- EPUB ----------

async function extractEpub(filePath) {
  const zip = unzipSync(new Uint8Array(await fs.readFile(filePath)))
  const read = name => {
    const entry = zip[name] ?? zip[decodeURIComponent(name)]
    return entry ? strFromU8(entry) : null
  }
  const container = parseHtml(read('META-INF/container.xml') ?? '')
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path')
  if (!opfPath) throw new Error('EPUB 缺少 container.xml / OPF')
  const opfDir = path.posix.dirname(opfPath)
  const resolve = (base, href) => path.posix.normalize(path.posix.join(base === '.' ? '' : base, href.split('#')[0]))
  const opf = parseHtml(read(opfPath) ?? '')

  const manifest = new Map()
  for (const item of opf.querySelectorAll('manifest item')) {
    manifest.set(item.getAttribute('id'), {
      href: resolve(opfDir, decodeURIComponent(item.getAttribute('href') ?? '')),
      type: item.getAttribute('media-type') ?? '',
      props: item.getAttribute('properties') ?? '',
    })
  }
  const spine = opf.querySelectorAll('spine itemref')
    .map(ref => manifest.get(ref.getAttribute('idref')))
    .filter(Boolean)

  const sections = spine.map((item, index) => {
    const html = read(item.href) ?? ''
    const root = parseHtml(html, { blockTextElements: { script: false, style: false } })
    const body = root.querySelector('body') ?? root
    const images = body.querySelectorAll('img, image')
      .map(img => img.getAttribute('src') ?? img.getAttribute('xlink:href') ?? img.getAttribute('href'))
      .filter(Boolean)
      .map(src => resolve(path.posix.dirname(item.href), decodeURIComponent(src)))
    const heading = body.querySelector('h1, h2, h3')?.text?.trim()
    return { index, href: item.href, label: heading || '', text: tidy(body.structuredText ?? body.text), images: images.length, imagePaths: images }
  })

  const hrefToIndex = new Map(sections.map(s => [s.href, s.index]))
  const toc = epubToc(opf, manifest, read, resolve, hrefToIndex)
  // 没有目录标题的段，用最近的目录项补上，便于展示
  const titleBySection = new Map()
  for (const t of toc) if (t.section != null && !titleBySection.has(t.section)) titleBySection.set(t.section, t.title)
  let last = ''
  for (const s of sections) {
    last = titleBySection.get(s.index) ?? last
    if (!s.label) s.label = last
  }

  const meta = opf.querySelector('metadata')
  const pick = sel => meta?.querySelector(sel)?.text?.trim() ?? ''
  return {
    format: 'epub',
    title: pick('dc\\:title') || pick('title') || path.basename(filePath, '.epub'),
    author: pick('dc\\:creator') || pick('creator'),
    sectionBase: 0, sectionCount: sections.length, sectionUnit: '节', toc, sections, scanned: false,
  }
}

function epubToc(opf, manifest, read, resolve, hrefToIndex) {
  const out = []
  const nav = [...manifest.values()].find(m => m.props.split(/\s+/).includes('nav'))
  if (nav) {
    const doc = parseHtml(read(nav.href) ?? '')
    const tocNav = doc.querySelectorAll('nav').find(n => (n.getAttribute('epub:type') ?? '').includes('toc')) ?? doc.querySelector('nav')
    const walk = (ol, depth) => {
      for (const li of ol?.childNodes ?? []) {
        if (li.rawTagName?.toLowerCase() !== 'li') continue
        const a = li.querySelector('a, span')
        const href = a?.getAttribute('href')
        const target = href ? resolve(path.posix.dirname(nav.href), decodeURIComponent(href)) : null
        out.push({ title: a?.text?.trim() ?? '', section: target ? hrefToIndex.get(target) ?? null : null, depth })
        const child = li.childNodes.find(c => c.rawTagName?.toLowerCase() === 'ol')
        if (child) walk(child, depth + 1)
      }
    }
    walk(tocNav?.querySelector('ol'), 0)
    if (out.length) return out
  }
  const ncxId = opf.querySelector('spine')?.getAttribute('toc')
  const ncx = ncxId ? manifest.get(ncxId) : [...manifest.values()].find(m => m.type === 'application/x-dtbncx+xml')
  if (!ncx) return out
  const doc = parseHtml(read(ncx.href) ?? '')
  const walk = (parent, depth) => {
    for (const point of parent.childNodes) {
      if (point.rawTagName?.toLowerCase() !== 'navpoint') continue
      const src = point.querySelector('content')?.getAttribute('src')
      const target = src ? resolve(path.posix.dirname(ncx.href), decodeURIComponent(src)) : null
      out.push({ title: point.querySelector('text')?.text?.trim() ?? '', section: target ? hrefToIndex.get(target) ?? null : null, depth })
      walk(point, depth + 1)
    }
  }
  const map = doc.querySelector('navMap')
  if (map) walk(map, 0)
  return out
}

/** 读取 EPUB 内的图片，供 MCP 的 get_image 返回给 Claude。 */
export async function readEpubImage(filePath, innerPath) {
  const zip = unzipSync(new Uint8Array(await fs.readFile(filePath)), { filter: f => f.name === innerPath })
  const bytes = zip[innerPath]
  if (!bytes) return null
  const ext = path.extname(innerPath).toLowerCase()
  const mime = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext] ?? 'image/jpeg'
  return { data: Buffer.from(bytes).toString('base64'), mime }
}

// 只对 PDF 里常见的「长得像汉字」的字符做 NFKC：康熙部首（⼯ U+2F2F）、部首补充、兼容汉字、
// 全角字母数字。中文全角标点保持原样。阅读器端 anchor.js 用同一规则，保证引文能对上。
const COMPAT = /[⺀-⿟豈-﫿０-９Ａ-Ｚａ-ｚ]/g
export const normalizeChars = s => s.replace(COMPAT, c => c.normalize('NFKC'))

export function tidy(text) {
  return normalizeChars(text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
