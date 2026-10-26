// 书内检索：BM25 词法（中文按字二元 + 单字）+ 向量语义，RRF 融合。思路参照 MoRead 的 RetrievalPipeline。
import { embedQuery } from './embed.js'

const CHUNK_TARGET = 500
const CHUNK_MAX = 800

/** 按段落切块，块不跨 section，便于定位到页 / 章节。 */
export function chunkSections(sections) {
  const chunks = []
  for (const s of sections) {
    if (!s.text) continue
    let buf = ''
    const flush = () => {
      const text = buf.trim()
      if (text) chunks.push({ section: s.index, text })
      buf = ''
    }
    for (const para of s.text.split(/\n+/)) {
      if (para.length > CHUNK_MAX) {
        flush()
        for (let i = 0; i < para.length; i += CHUNK_TARGET) {
          buf = para.slice(i, i + CHUNK_TARGET)
          flush()
        }
        continue
      }
      if (buf.length + para.length > CHUNK_TARGET && buf.length > 0) flush()
      buf += (buf ? '\n' : '') + para
    }
    flush()
  }
  return chunks
}

export function tokenize(text) {
  const tokens = []
  for (const [run] of text.toLowerCase().matchAll(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu)) {
    if (/\p{Script=Han}/u.test(run[0])) {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i])
        if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
      }
    } else tokens.push(run)
  }
  return tokens
}

export class BookIndex {
  constructor(chunks, vectors = null) {
    this.chunks = chunks
    this.vectors = vectors // Float32Array[]，与 chunks 一一对应
    this.postings = new Map()
    this.lengths = new Float32Array(chunks.length)
    chunks.forEach((c, i) => {
      const tf = new Map()
      for (const t of tokenize(c.text)) tf.set(t, (tf.get(t) ?? 0) + 1)
      let len = 0
      for (const [t, n] of tf) {
        len += n
        let list = this.postings.get(t)
        if (!list) this.postings.set(t, list = [])
        list.push(i, n)
      }
      this.lengths[i] = len
    })
    this.avgLen = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, chunks.length)
  }

  lexical(query, allow, limit) {
    const k1 = 1.2, b = 0.75, N = this.chunks.length
    const scores = new Map()
    for (const t of new Set(tokenize(query))) {
      const list = this.postings.get(t)
      if (!list) continue
      const df = list.length / 2
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (let j = 0; j < list.length; j += 2) {
        const i = list[j], tf = list[j + 1]
        if (!allow(this.chunks[i])) continue
        const s = idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * this.lengths[i] / this.avgLen))
        scores.set(i, (scores.get(i) ?? 0) + s)
      }
    }
    return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit)
  }

  async semantic(query, allow, limit) {
    if (!this.vectors) return []
    const q = await embedQuery(query)
    const scored = []
    for (let i = 0; i < this.vectors.length; i++) {
      if (!allow(this.chunks[i])) continue
      const v = this.vectors[i]
      let dot = 0
      for (let d = 0; d < v.length; d++) dot += v[d] * q[d]
      scored.push([i, dot])
    }
    return scored.sort((a, b) => b[1] - a[1]).slice(0, limit)
  }

  async search(query, { allow = () => true, topK = 6, mode = 'hybrid' } = {}) {
    const pool = 50
    const lex = mode === 'vector' ? [] : this.lexical(query, allow, pool)
    let sem = []
    let semanticError = null
    if (mode !== 'lexical' && this.vectors) {
      try { sem = await this.semantic(query, allow, pool) } catch (e) { semanticError = e.message }
    }
    // Reciprocal Rank Fusion
    const fused = new Map()
    const add = (list, tag) => list.forEach(([i], rank) => {
      const f = fused.get(i) ?? { score: 0, via: [] }
      f.score += 1 / (60 + rank + 1)
      f.via.push(tag)
      fused.set(i, f)
    })
    add(lex, '词法')
    add(sem, '语义')
    const results = [...fused].sort((a, b) => b[1].score - a[1].score).slice(0, topK)
      .map(([i, f]) => ({ ...this.chunks[i], via: f.via }))
    return { results, usedVector: sem.length > 0, semanticError }
  }
}

/** 字面或正则检索，返回带上下文的命中。 */
export function grep(sections, pattern, { regex = false, allow = () => true, max = 30, context = 40 } = {}) {
  const re = regex
    ? new RegExp(pattern, 'giu')
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const hits = []
  let total = 0
  for (const s of sections) {
    if (!allow(s)) continue
    for (const m of s.text.matchAll(re)) {
      total++
      if (hits.length < max) {
        const start = Math.max(0, m.index - context)
        hits.push({
          section: s.index,
          match: m[0],
          context: s.text.slice(start, m.index + m[0].length + context).replace(/\n/g, ' '),
        })
      }
      if (m[0].length === 0) break
    }
  }
  return { hits, total }
}
