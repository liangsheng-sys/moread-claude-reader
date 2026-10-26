// 长期记忆：Claude 主动记下的、值得跨会话记住的事（用户的困惑、兴趣、掌握程度、学习习惯……）。
// 对应 MoRead ai/memory 的记忆固化，但由 Claude 自己判断何时记。检索用与书内相同的混合检索。
import { BookIndex } from './search.js'
import { embeddingEnabled, embedPassages } from './embed.js'
import * as store from './store.js'

export const MEMORY_KINDS = { insight: '理解', struggle: '困惑', interest: '兴趣', habit: '习惯', milestone: '进展' }

export const listMemories = () => store.load(null, 'memories', [])

export async function saveMemory({ bookId, kind, content, section }) {
  const list = listMemories()
  const item = { id: store.newId(), bookId: bookId ?? null, kind, content, section: section ?? null, createdAt: store.now() }
  if (embeddingEnabled()) {
    try { item.vector = Array.from((await embedPassages([content]))[0]) } catch { /* 没有向量也能词法检索 */ }
  }
  list.push(item)
  store.save(null, 'memories', list)
  store.events.emit('change', { type: 'memory', bookId: item.bookId })
  return item
}

export function deleteMemory(id) {
  const list = listMemories()
  const i = list.findIndex(m => m.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  store.save(null, 'memories', list)
  return true
}

export async function recallMemories(query, { bookId, topK = 8 } = {}) {
  const list = listMemories().filter(m => !bookId || m.bookId === bookId)
  if (!list.length) return []
  const vectors = list.every(m => m.vector) ? list.map(m => Float32Array.from(m.vector)) : null
  const index = new BookIndex(list.map((m, i) => ({ section: i, text: m.content })), vectors)
  const { results } = await index.search(query, { topK })
  return results.map(r => list[r.section])
}

// ---------- 每本书的学习进度摘要（滚动更新，只保留最新一份；对应 MoRead 的 save_plot_summary） ----------

export const getBookSummary = bookId => store.load(bookId, 'summary', null)

export function saveBookSummary(bookId, content, upto) {
  const item = { content, upto, updatedAt: store.now() }
  const history = store.load(bookId, 'summary-history', [])
  const prev = getBookSummary(bookId)
  if (prev) history.push(prev)
  store.save(bookId, 'summary-history', history.slice(-50))
  store.save(bookId, 'summary', item)
  store.events.emit('change', { type: 'summary', bookId })
  return item
}
