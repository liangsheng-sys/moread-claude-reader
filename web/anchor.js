// 与服务端 extract.js 的 normalizeChars 相同：康熙部首、兼容汉字、全角字母数字 → 标准字符（一对一）
const COMPAT = /[⺀-⿟豈-﫿０-９Ａ-Ｚａ-ｚ]/g
const norm = s => s.replace(COMPAT, c => c.normalize('NFKC'))

// 在 DOM 里按「逐字原文」定位 Range：忽略所有空白，兼容 PDF 文字层的断行与 EPUB 的排版空格。
export function findQuote(root, quote) {
  const doc = root.ownerDocument
  const q = norm(quote).replace(/\s+/g, '')
  if (!q) return null
  const map = []
  let flat = ''
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n; (n = walker.nextNode());) {
    const t = norm(n.nodeValue)
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) continue
      flat += t[i]
      map.push(n, i)
    }
  }
  const at = flat.indexOf(q)
  if (at < 0) return null
  const range = doc.createRange()
  range.setStart(map[at * 2], map[at * 2 + 1])
  const end = at + q.length - 1
  range.setEnd(map[end * 2], map[end * 2 + 1] + 1)
  return range
}

/** 合并同一行上相邻的矩形，避免 PDF 文字层碎片化的高亮。 */
export function mergeRects(rects) {
  const out = []
  for (const r of [...rects].filter(r => r.width > 0 && r.height > 0).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.top - r.top) < r.height * 0.5 && r.left <= last.right + 4) {
      last.right = Math.max(last.right, r.right)
      last.bottom = Math.max(last.bottom, r.bottom)
      last.top = Math.min(last.top, r.top)
    } else out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  }
  return out
}

export const COLORS = {
  yellow: ['--hl-yellow', '--line-yellow'],
  green: ['--hl-green', '--line-green'],
  blue: ['--hl-blue', '--line-blue'],
  pink: ['--hl-pink', '--line-pink'],
  purple: ['--hl-purple', '--line-purple'],
}
export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
export const fillColor = c => cssVar((COLORS[c] ?? COLORS.yellow)[0])
export const lineColor = c => cssVar((COLORS[c] ?? COLORS.yellow)[1])
