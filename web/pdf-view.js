// PDF：pdf.js 官方 PDFViewer（连续滚动 + 文字层），划线画在 canvas 与文字层之间。
import { findQuote, mergeRects, fillColor, lineColor } from './anchor.js'

const wave = color => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='8' height='4'><path d='M0 3 Q2 0 4 3 T8 3' fill='none' stroke='${color}' stroke-width='1.4'/></svg>`)}") repeat-x left bottom`

export async function createPdfViewer({ stage, url, initial, onRelocate, onSelect, onAnnotationClick, getAnnotations }) {
  const pdfjsLib = await import('/vendor/pdfjs/build/pdf.mjs')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs'
  globalThis.pdfjsLib = pdfjsLib
  const { PDFViewer, EventBus, PDFLinkService } = await import('/vendor/pdfjs/web/pdf_viewer.mjs')

  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/vendor/pdfjs/web/pdf_viewer.css'
  document.head.append(link)

  stage.innerHTML = '<div class="pdf-container"><div class="pdfViewer"></div></div>'
  const container = stage.firstElementChild
  const eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus })
  const viewer = new PDFViewer({ container, eventBus, linkService, textLayerMode: 1, removePageBorders: false })
  linkService.setViewer(viewer)

  const pdf = await pdfjsLib.getDocument({
    url, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  }).promise
  viewer.setDocument(pdf)
  linkService.setDocument(pdf)
  const total = pdf.numPages

  const scaleKey = 'moread.pdfScale'
  eventBus.on('pagesinit', () => {
    let saved = null
    try { saved = localStorage.getItem(scaleKey) } catch {}
    viewer.currentScaleValue = saved ?? 'page-width'
    if (initial?.section) viewer.currentPageNumber = Math.min(initial.section, total)
    report(viewer.currentPageNumber)
  })
  eventBus.on('scalechanging', ({ scale, presetValue }) => {
    try { localStorage.setItem(scaleKey, presetValue ?? String(scale)) } catch {}
  })
  const report = n => onRelocate({ section: n, fraction: total > 1 ? (n - 1) / (total - 1) : 1, label: `第 ${n} / ${total} 页` })
  eventBus.on('pagechanging', ({ pageNumber }) => report(pageNumber))
  eventBus.on('textlayerrendered', ({ pageNumber }) => draw(pageNumber))

  // ---- 划线 ----
  function draw(pageNumber) {
    const pageView = viewer.getPageView(pageNumber - 1)
    const pageDiv = pageView?.div
    const textLayer = pageDiv?.querySelector('.textLayer')
    if (!textLayer) return
    pageDiv.querySelector('.mo-hl-layer')?.remove()
    const layer = document.createElement('div')
    layer.className = 'mo-hl-layer'
    textLayer.before(layer)
    const base = pageDiv.getBoundingClientRect()
    for (const a of getAnnotations().filter(a => a.section === pageNumber)) {
      const range = findQuote(textLayer, a.quote)
      if (!range) continue
      for (const r of mergeRects(range.getClientRects())) {
        const el = document.createElement('div')
        el.className = `mo-hl mo-${a.style}${a.author === 'claude' ? ' mo-claude' : ''}`
        el.dataset.id = a.id
        Object.assign(el.style, { left: `${r.left - base.left}px`, top: `${r.top - base.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` })
        if (a.style === 'highlight') el.style.background = fillColor(a.color)
        else if (a.style === 'underline') el.style.borderBottom = `2px solid ${lineColor(a.color)}`
        else el.style.background = wave(lineColor(a.color))
        layer.append(el)
      }
    }
  }
  const redrawAll = () => {
    for (let i = 1; i <= total; i++) if (viewer.getPageView(i - 1)?.div?.querySelector('.textLayer span')) draw(i)
  }

  // ---- 选区与点击 ----
  container.addEventListener('mouseup', () => setTimeout(() => {
    const sel = document.getSelection()
    if (!sel || sel.isCollapsed || !container.contains(sel.anchorNode)) return onSelect(null)
    const range = sel.getRangeAt(0)
    const page = range.startContainer.parentElement?.closest('.page')
    // 文字层按排版行断开：中文之间直接接上，西文之间补一个空格
    const text = sel.toString().trim().replace(/(.)\s*\n\s*(.)/gu, (_, a, b) =>
      /[\p{Script=Han}　-〿＀-￯]/u.test(a + b) || a === '-' ? a + b : `${a} ${b}`)
    if (!page || !text) return onSelect(null)
    onSelect({ section: Number(page.dataset.pageNumber), text, rect: range.getBoundingClientRect() })
  }, 10))
  container.addEventListener('click', e => {
    if (!document.getSelection()?.isCollapsed) return
    const page = e.target.closest?.('.page')
    for (const el of page?.querySelectorAll('.mo-hl') ?? []) {
      const r = el.getBoundingClientRect()
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2) {
        return onAnnotationClick(el.dataset.id, r)
      }
    }
  })

  document.addEventListener('keydown', e => {
    if (e.target.closest?.('textarea, input')) return
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { viewer.nextPage(); e.preventDefault() }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { viewer.previousPage(); e.preventDefault() }
  })

  return {
    goTo: section => { viewer.currentPageNumber = section },
    refreshAnnotations: redrawAll,
    zoom: delta => {
      if (delta === 0) viewer.currentScaleValue = 'page-width'
      else viewer.currentScale = Math.max(0.3, Math.min(5, viewer.currentScale * (delta > 0 ? 1.1 : 1 / 1.1)))
    },
    next: () => viewer.nextPage(),
    prev: () => viewer.previousPage(),
    clearSelection: () => document.getSelection()?.removeAllRanges(),
  }
}
