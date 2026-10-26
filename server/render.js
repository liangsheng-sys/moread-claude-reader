// PDF 页面渲染成图片给 Claude 看（不依赖 poppler）：pdf.js + @napi-rs/canvas（pdfjs-dist 自带的可选依赖）。
// 可只渲染页面的一部分（region，0~1 的比例坐标），用同样的像素预算看清小图、公式、代码截图。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pdfjsDir = path.join(root, 'node_modules/pdfjs-dist')
let pdfjs
const docs = new Map() // file -> Promise<PDFDocumentProxy>，只留最近两本

async function openPdf(file) {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (!docs.has(file)) {
    docs.set(file, pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(file)),
      cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep, cMapPacked: true,
      standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
      verbosity: 0,
    }).promise)
    while (docs.size > 2) {
      const [oldest, p] = docs.entries().next().value
      docs.delete(oldest)
      p.then(d => d.destroy()).catch(() => {})
    }
  }
  return docs.get(file)
}

/**
 * 渲染一页（或其中一块）为 JPEG。maxSide：输出图长边像素。
 * region: { x, y, w, h }，相对页面左上角的比例（0~1）。
 */
export async function renderPdfPage(file, pageNumber, { region, maxSide = 1400 } = {}) {
  const pdf = await openPdf(file)
  if (pageNumber < 1 || pageNumber > pdf.numPages) throw new Error(`页码超出范围（共 ${pdf.numPages} 页）`)
  const page = await pdf.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const r = region ?? { x: 0, y: 0, w: 1, h: 1 }
  const clamp = v => Math.min(1, Math.max(0, v))
  const x0 = clamp(r.x), y0 = clamp(r.y), x1 = clamp(r.x + r.w), y1 = clamp(r.y + r.h)
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) throw new Error('region 太小')
  // 缩放到「所选区域的长边 = maxSide」，小区域就等于放大看
  const scale = Math.min(maxSide / Math.max((x1 - x0) * base.width, (y1 - y0) * base.height), 8)
  const viewport = page.getViewport({ scale })
  const w = Math.ceil((x1 - x0) * viewport.width), h = Math.ceil((y1 - y0) * viewport.height)
  const { canvas, context } = pdf.canvasFactory.create(w, h)
  context.fillStyle = '#fff'
  context.fillRect(0, 0, w, h)
  await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -x0 * viewport.width, -y0 * viewport.height] }).promise
  page.cleanup()
  const data = await canvas.encode('jpeg', 85)
  return { data: Buffer.from(data).toString('base64'), mimeType: 'image/jpeg', width: w, height: h }
}
