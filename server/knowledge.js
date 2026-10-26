// 每本书的结构化知识：章节大纲（MoRead「目录 → 大纲」）、术语表（MoRead「人物」页在学习类书里的对应物）、书签。
import * as store from './store.js'

// ---------- 章节大纲：每章一份，要点附逐字原文作为依据 ----------

export const listOutlines = bookId => store.load(bookId, 'outlines', {})

export function saveOutline(bookId, { start, end, title, points }) {
  const all = listOutlines(bookId)
  all[start] = { start, end, title, points, updatedAt: store.now() }
  store.save(bookId, 'outlines', all)
  store.events.emit('change', { type: 'outline', bookId })
  return all[start]
}

// ---------- 术语表：按术语名去重，后写覆盖 ----------

export const listTerms = bookId => store.load(bookId, 'terms', [])

export function saveTerm(bookId, { term, definition, section, quote, aliases = [] }) {
  const list = listTerms(bookId)
  const key = term.trim().toLowerCase()
  let item = list.find(t => t.term.trim().toLowerCase() === key)
  if (item) Object.assign(item, { definition, section: section ?? item.section, quote: quote ?? item.quote, aliases: [...new Set([...item.aliases, ...aliases])], updatedAt: store.now() })
  else list.push(item = { id: store.newId(), term: term.trim(), definition, section, quote, aliases, createdAt: store.now(), updatedAt: store.now() })
  store.save(bookId, 'terms', list)
  store.events.emit('change', { type: 'term', bookId })
  return item
}

export function deleteTerm(bookId, id) {
  const list = listTerms(bookId)
  const i = list.findIndex(t => t.id === id)
  if (i >= 0) { list.splice(i, 1); store.save(bookId, 'terms', list); store.events.emit('change', { type: 'term', bookId }) }
  return i >= 0
}

// ---------- 书签 ----------

export const listBookmarks = bookId => store.load(bookId, 'bookmarks', [])

export function addBookmark(bookId, { section, cfi, label, excerpt }) {
  const list = listBookmarks(bookId)
  const item = { id: store.newId(), section, cfi: cfi ?? null, label: label ?? '', excerpt: excerpt ?? '', createdAt: store.now() }
  list.push(item)
  store.save(bookId, 'bookmarks', list)
  store.events.emit('change', { type: 'bookmark', bookId })
  return item
}

export function deleteBookmark(bookId, id) {
  const list = listBookmarks(bookId)
  const i = list.findIndex(b => b.id === id)
  if (i >= 0) { list.splice(i, 1); store.save(bookId, 'bookmarks', list); store.events.emit('change', { type: 'bookmark', bookId }) }
  return i >= 0
}
