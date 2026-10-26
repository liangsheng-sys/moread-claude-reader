// EPUB：foliate-js 渲染。Claude 的批注只给「节号 + 逐字原文」，这里首次显示时解析成 CFI 并回存。
import '/vendor/foliate/view.js'
import { Overlayer } from '/vendor/foliate/overlayer.js'
import { findQuote, fillColor, lineColor } from './anchor.js'

const DRAW = { highlight: Overlayer.highlight, underline: Overlayer.underline, wavy: Overlayer.squiggly }

const bookCSS = ({ fontSize }) => `
  @namespace epub "http://www.idpf.org/2007/ops";
  html { color-scheme: light dark; font-size: ${fontSize}% !important; }
  @media (prefers-color-scheme: dark) { a:link { color: #a5b8f0; } }
  p, li, blockquote, dd { line-height: 1.75; text-align: justify; }
  pre, code { white-space: pre-wrap !important; font-size: .9em; }
  img, svg { max-width: 100%; height: auto; }
  aside[epub|type~="footnote"], aside[epub|type~="endnote"] { display: none; }
`

export async function createEpubViewer({ stage, url, initial, onRelocate, onSelect, onAnnotationClick, getAnnotations, saveCfi }) {
  const view = document.createElement('foliate-view')
  view.className = 'epub-view'
  stage.append(view)
  await view.open(url)

  let fontSize = 100
  try { fontSize = Number(localStorage.getItem('moread.epubFont')) || 100 } catch {}
  let flow = 'paginated'
  try { flow = localStorage.getItem('moread.epubFlow') || 'paginated' } catch {}
  const r = view.renderer
  r.setAttribute('flow', flow)
  r.setAttribute('max-inline-size', '760px')
  r.setAttribute('max-column-count', '2')
  r.setAttribute('gap', '6%')
  r.setStyles?.(bookCSS({ fontSize }))

  const byValue = new Map()
  const drawn = new Map() // section index -> Set(cfi)

  view.addEventListener('relocate', ({ detail: d }) => {
    const section = d.section?.current ?? 0
    onRelocate({
      section, fraction: d.fraction ?? 0, cfi: d.cfi, tocLabel: d.tocItem?.label?.trim(),
      label: `${Math.round((d.fraction ?? 0) * 100)}% · 位置 ${d.location?.current ?? '?'}/${d.location?.total ?? '?'}`,
    })
  })

  const toPage = (rect, doc) => {
    const frame = doc.defaultView?.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 }
    return { left: rect.left + frame.left, right: rect.right + frame.left, top: rect.top + frame.top, bottom: rect.bottom + frame.top, width: rect.width, height: rect.height }
  }

  view.addEventListener('load', ({ detail: { doc, index } }) => {
    doc.addEventListener('pointerup', () => setTimeout(() => {
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed) return onSelect(null)
      const range = sel.getRangeAt(0)
      const text = sel.toString().trim()
      if (!text) return onSelect(null)
      onSelect({ section: index, text, cfi: view.getCFI(index, range), rect: toPage(range.getBoundingClientRect(), doc) })
    }, 10))
    doc.addEventListener('keydown', onKey)
  })

  async function drawSection(index) {
    const content = r.getContents().find(c => c.index === index)
    if (!content?.doc) return
    const old = drawn.get(index) ?? new Set()
    const now = new Set()
    for (const a of getAnnotations().filter(a => a.section === index)) {
      let cfi = a.cfi
      if (!cfi) {
        const range = findQuote(content.doc.body, a.quote)
        if (!range) continue
        cfi = view.getCFI(index, range)
        a.cfi = cfi
        saveCfi(a.id, cfi)
      }
      byValue.set(cfi, a)
      now.add(cfi)
      await view.addAnnotation({ value: cfi })
    }
    for (const cfi of old) if (!now.has(cfi)) view.deleteAnnotation({ value: cfi })
    drawn.set(index, now)
  }

  view.addEventListener('create-overlay', ({ detail: { index } }) => drawSection(index))
  view.addEventListener('draw-annotation', ({ detail: { draw, annotation } }) => {
    const a = byValue.get(annotation.value)
    if (!a) return
    const style = DRAW[a.style] ?? Overlayer.highlight
    draw(style, a.style === 'highlight' ? { color: fillColor(a.color).replace(/,\s*[\d.]+\)$/, ', 1)') } : { color: lineColor(a.color), width: a.style === 'wavy' ? 1.5 : 2 })
  })
  view.addEventListener('show-annotation', ({ detail: { value, range } }) => {
    const a = byValue.get(value)
    if (a) onAnnotationClick(a.id, toPage(range.getBoundingClientRect(), range.startContainer.ownerDocument))
  })

  function onKey(e) {
    if (e.target.closest?.('textarea, input')) return
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') view.goLeft()
    if (e.key === 'ArrowRight' || e.key === 'PageDown') view.goRight()
  }
  document.addEventListener('keydown', onKey)

  await view.init({ lastLocation: initial?.cfi ?? null, showTextStart: !initial })

  return {
    goTo: target => view.goTo(target),
    refreshAnnotations: () => { for (const c of r.getContents()) drawSection(c.index) },
    zoom: delta => {
      fontSize = delta === 0 ? 100 : Math.max(60, Math.min(220, fontSize + delta * 10))
      try { localStorage.setItem('moread.epubFont', fontSize) } catch {}
      r.setStyles?.(bookCSS({ fontSize }))
    },
    toggleFlow: () => {
      flow = flow === 'paginated' ? 'scrolled' : 'paginated'
      try { localStorage.setItem('moread.epubFlow', flow) } catch {}
      r.setAttribute('flow', flow)
      return flow
    },
    next: () => view.goRight(),
    prev: () => view.goLeft(),
    clearSelection: () => { for (const c of r.getContents()) c.doc?.getSelection()?.removeAllRanges() },
  }
}
