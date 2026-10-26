// 轻量 JSON 持久化：每本书一个目录，内存缓存 + 延迟写盘。
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

export const events = new EventEmitter()
events.setMaxListeners(50)

const cache = new Map()
const timers = new Map()
let dataDir = './data'

export function initStore(dir) {
  dataDir = dir
  fs.mkdirSync(path.join(dataDir, 'books'), { recursive: true })
}

export const bookDir = id => path.join(dataDir, 'books', id)
const fileFor = (scope, name) => scope ? path.join(bookDir(scope), `${name}.json`) : path.join(dataDir, `${name}.json`)

export function load(scope, name, fallback) {
  const file = fileFor(scope, name)
  if (cache.has(file)) return cache.get(file)
  let value = fallback
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 首次使用 */ }
  cache.set(file, value)
  return value
}

export function save(scope, name, value) {
  const file = fileFor(scope, name)
  cache.set(file, value)
  clearTimeout(timers.get(file))
  timers.set(file, setTimeout(() => flushFile(file), 300))
}

function flushFile(file) {
  timers.delete(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cache.get(file), null, 1))
  fs.renameSync(tmp, file)
}

export function flushAll() {
  for (const [file, timer] of timers) { clearTimeout(timer); flushFile(file) }
}

export const newId = () => randomUUID().slice(0, 8)
export const now = () => new Date().toISOString()
export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- 阅读状态 ----------

export const getState = id => load(id, 'state', { progress: null, furthest: null, readingLog: {}, lastOpened: null })

export function updateProgress(id, p) {
  const state = getState(id)
  state.progress = { ...p, updatedAt: now() }
  if (state.furthest == null || p.section > state.furthest) state.furthest = p.section
  state.lastOpened = now()
  save(id, 'state', state)
  const g = load(null, 'global', {})
  g.currentBook = id
  save(null, 'global', g)
}

export function addReadingTime(id, seconds) {
  const state = getState(id)
  const key = today()
  state.readingLog[key] = (state.readingLog[key] ?? 0) + Math.max(0, Math.min(seconds, 120))
  save(id, 'state', state)
}

// ---------- 批注 / 笔记 / 消息 ----------

export const listAnnotations = id => load(id, 'annotations', [])

export function addAnnotation(id, a) {
  const list = listAnnotations(id)
  const item = { id: newId(), style: 'highlight', color: 'yellow', note: '', replies: [], createdAt: now(), ...a }
  list.push(item)
  save(id, 'annotations', list)
  events.emit('change', { type: 'annotation', bookId: id, item })
  return item
}

export function updateAnnotation(id, annId, patch) {
  const list = listAnnotations(id)
  const item = list.find(a => a.id === annId)
  if (!item) return null
  Object.assign(item, patch)
  save(id, 'annotations', list)
  events.emit('change', { type: 'annotation', bookId: id, item })
  return item
}

export function replyAnnotation(id, annId, author, text) {
  const list = listAnnotations(id)
  const item = list.find(a => a.id === annId)
  if (!item) return null
  item.replies.push({ author, text, at: now() })
  save(id, 'annotations', list)
  events.emit('change', { type: 'annotation', bookId: id, item })
  return item
}

export function deleteAnnotation(id, annId) {
  const list = listAnnotations(id)
  const i = list.findIndex(a => a.id === annId)
  if (i < 0) return false
  list.splice(i, 1)
  save(id, 'annotations', list)
  events.emit('change', { type: 'annotation-deleted', bookId: id, id: annId })
  return true
}

export const listNotes = id => load(id, 'notes', [])

export function writeNote(id, { noteId, title, content, author }) {
  const list = listNotes(id)
  let item = noteId ? list.find(n => n.id === noteId) : null
  if (item) Object.assign(item, { title: title ?? item.title, content, updatedAt: now() })
  else {
    item = { id: newId(), title: title ?? '', content, author, createdAt: now(), updatedAt: now() }
    list.push(item)
  }
  save(id, 'notes', list)
  events.emit('change', { type: 'note', bookId: id, item })
  return item
}

export const listMessages = id => load(id, 'messages', [])

export function addMessage(id, role, text, extra = {}) {
  const list = listMessages(id)
  const item = { id: newId(), role, text, at: now(), ...extra }
  list.push(item)
  save(id, 'messages', list)
  events.emit('change', { type: 'message', bookId: id, item })
  return item
}

// ---------- 给 Claude 的收件箱（阅读器里的「问 Claude」、回复、留言） ----------

export const listInbox = () => load(null, 'inbox', [])

export function pushInbox(entry) {
  const list = listInbox()
  const item = { id: newId(), at: now(), seen: false, ...entry }
  list.push(item)
  if (list.length > 200) list.splice(0, list.length - 200)
  save(null, 'inbox', list)
  events.emit('change', { type: 'inbox', bookId: entry.bookId, item })
  return item
}

export function takeInbox() {
  const list = listInbox()
  const pending = list.filter(i => !i.seen)
  for (const i of pending) i.seen = true
  if (pending.length) save(null, 'inbox', list)
  return pending
}
