// 整理书库：标签、书单。存在 data/shelf.json。
// 参考 MoRead 的 ShelfEntities（标签多对多、书单），做了简化：
// - 标签就是字符串，不单独建表；所在文件夹另作「分类」（library.categoryOf），不用手动打。
// - 书单有顺序，条目可以是书库里还没有的书（只记书名作者），书放进书库后按书名自动对上。
// - Claude 可以直接往书单里加书（MoRead 要用户在界面确认；这里书单只是清单，不动书和正文，加错了删掉即可）。
import { events, load, newId, now, save } from './store.js'
import { getBook, listBooks } from './library.js'

const data = () => {
  const d = load(null, 'shelf', null) ?? {}
  d.tags ??= {}
  d.lists ??= []
  return d
}
const commit = (d, e = {}) => { save(null, 'shelf', d); events.emit('change', { type: 'shelf', ...e }) }

// ---------- 标签 ----------

export const cleanTag = t => String(t ?? '').replace(/[,，、#\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20)
export const bookTags = id => data().tags[id] ?? []

export function setBookTags(id, tags) {
  const d = data()
  const clean = [...new Set(tags.map(cleanTag).filter(Boolean))].slice(0, 12)
  if (clean.length) d.tags[id] = clean
  else delete d.tags[id]
  commit(d, { bookId: id })
  events.emit('change', { type: 'book', bookId: id })
  return clean
}

export function editBookTags(id, { add = [], remove = [] }) {
  const drop = new Set(remove.map(cleanTag))
  return setBookTags(id, [...bookTags(id).filter(t => !drop.has(t)), ...add])
}

/** 所有标签及使用次数（按次数降序）。 */
export function allTags() {
  const count = new Map()
  for (const list of Object.values(data().tags)) for (const t of list) count.set(t, (count.get(t) ?? 0) + 1)
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([name, count]) => ({ name, count }))
}

/** 全局改名 / 删除标签（to 为空即删除）。 */
export function renameTag(from, to) {
  const d = data()
  to = cleanTag(to)
  let n = 0
  for (const [id, list] of Object.entries(d.tags)) {
    if (!list.includes(from)) continue
    n++
    const next = [...new Set(list.map(t => t === from ? to : t).filter(Boolean))]
    if (next.length) d.tags[id] = next
    else delete d.tags[id]
  }
  commit(d)
  return n
}

// ---------- 书单 ----------

// 书名比较：去掉书名号、标点、空格，「设计心理学1：日常的设计」和「设计心理学1 日常的设计」算同一本
const norm = s => String(s ?? '').toLowerCase().replace(/[《》〈〉「」『』“”"'‘’()（）[\]【】:：·・,，.。!！?？\-—_\s]/g, '')

/** 在书库里找书单条目对应的书：书名一致，或（标题够长时）一方包含另一方且只有一本符合。 */
function matchBook(item, books) {
  const t = norm(item.title)
  if (!t) return null
  const exact = books.filter(b => norm(b.title) === t)
  if (exact.length === 1) return exact[0]
  if (t.length < 4) return null
  const loose = books.filter(b => { const bt = norm(b.title); return bt.length >= 4 && (bt.includes(t) || t.includes(bt)) })
  return loose.length === 1 ? loose[0] : null
}

/** 补上书单条目和书库的对应关系（书后来放进了书库）。返回是否有变化。 */
function link(d) {
  const books = listBooks()
  let changed = false
  for (const l of d.lists) for (const it of l.items) {
    if (it.bookId && getBook(it.bookId)) continue
    const b = matchBook(it, books)
    if ((b?.id ?? null) !== (it.bookId ?? null)) { it.bookId = b?.id ?? null; changed = true }
  }
  return changed
}

const view = (l, books) => {
  const items = l.items.map(it => {
    const s = it.bookId ? books.find(x => x.id === it.bookId) : null
    if (!s) return { ...it, bookId: null, inLibrary: false, status: 'missing' }
    return { ...it, inLibrary: true, status: s.readStatus, fraction: s.progress?.fraction ?? 0, bookTitle: s.title, format: s.format }
  })
  const next = items.find(i => i.status !== 'finished')
  return { ...l, items, done: items.filter(i => i.status === 'finished').length, nextItemId: next?.id ?? null }
}

export function listLists() {
  const d = data()
  if (link(d)) save(null, 'shelf', d)
  const books = listBooks()
  return d.lists.map(l => view(l, books))
}

export const getList = id => listLists().find(l => l.id === id) ?? null

/** 按 id 或名字找书单（Claude 常常只记得名字）。 */
export function findList(idOrName) {
  const all = data().lists
  return all.find(l => l.id === idOrName) ?? all.find(l => norm(l.name) === norm(idOrName)) ?? null
}

export function createList({ name, description = '', by = 'me' }) {
  const d = data()
  const l = { id: newId(), name: String(name).trim().slice(0, 40) || '新书单', description: String(description).slice(0, 2000), createdBy: by, createdAt: now(), updatedAt: now(), items: [] }
  d.lists.push(l)
  commit(d, { listId: l.id })
  return l
}

export function updateList(id, patch) {
  const d = data()
  const l = d.lists.find(x => x.id === id)
  if (!l) return null
  if (patch.name != null) l.name = String(patch.name).trim().slice(0, 40) || l.name
  if (patch.description != null) l.description = String(patch.description).slice(0, 2000)
  if (patch.reply !== undefined) l.reply = patch.reply ? { text: String(patch.reply).slice(0, 2000), at: now() } : null
  l.updatedAt = now()
  commit(d, { listId: id })
  return l
}

export function deleteList(id) {
  const d = data()
  const i = d.lists.findIndex(x => x.id === id)
  if (i < 0) return false
  d.lists.splice(i, 1)
  commit(d, { listId: id })
  return true
}

/**
 * 往书单里加书。item：{ bookId? , title?, author?, note? }；position 从 0 开始，省略则加在末尾。
 * 书单里已经有的书（同一本或同名）不重复加，返回 { added, skipped }。
 */
export function addItems(listId, items, { position, by = 'me' } = {}) {
  const d = data()
  const l = d.lists.find(x => x.id === listId)
  if (!l) return null
  const added = [], skipped = []
  const books = listBooks()
  for (const raw of items) {
    const b = raw.bookId ? books.find(x => x.id === raw.bookId) : null
    const item = {
      id: newId(),
      bookId: b?.id ?? null,
      title: String(b?.title ?? raw.title ?? '').trim().slice(0, 120),
      author: String(raw.author ?? b?.author ?? '').trim().slice(0, 80),
      note: String(raw.note ?? '').trim().slice(0, 1000),
      addedBy: by,
      addedAt: now(),
    }
    if (!item.title) continue
    if (!item.bookId) item.bookId = matchBook(item, books)?.id ?? null
    const dup = [...l.items, ...added].find(x => (item.bookId && x.bookId === item.bookId) || norm(x.title) === norm(item.title))
    if (dup) { skipped.push(dup.title); continue }
    added.push(item)
  }
  const at = position == null ? l.items.length : Math.max(0, Math.min(position, l.items.length))
  l.items.splice(at, 0, ...added)
  l.updatedAt = now()
  commit(d, { listId })
  return { added, skipped }
}

export function updateItem(listId, itemId, patch) {
  const d = data()
  const l = d.lists.find(x => x.id === listId)
  const i = l?.items.findIndex(x => x.id === itemId) ?? -1
  if (i < 0) return null
  const it = l.items[i]
  for (const k of ['title', 'author', 'note']) if (patch[k] != null) it[k] = String(patch[k]).trim()
  if (patch.title != null) it.bookId = null   // 改了书名就重新对一次
  if (patch.position != null) {
    l.items.splice(i, 1)
    l.items.splice(Math.max(0, Math.min(patch.position, l.items.length)), 0, it)
  }
  l.updatedAt = now()
  link(d)
  commit(d, { listId })
  return it
}

export function removeItems(listId, itemIds) {
  const d = data()
  const l = d.lists.find(x => x.id === listId)
  if (!l) return null
  const drop = new Set(itemIds)
  const before = l.items.length
  l.items = l.items.filter(x => !drop.has(x.id))
  l.updatedAt = now()
  commit(d, { listId })
  return before - l.items.length
}

/** 这本书所在的书单，以及每个书单里它后面的下一本（读完一本时提示接着读什么）。 */
export function listsWithBook(bookId) {
  return listLists().filter(l => l.items.some(i => i.bookId === bookId)).map(l => {
    const i = l.items.findIndex(x => x.bookId === bookId)
    const next = l.items.slice(i + 1).find(x => x.status !== 'finished') ?? null
    return { id: l.id, name: l.name, position: i + 1, total: l.items.length, next }
  })
}

// 书从书库里移走时不删它的标签：可能只是暂时挪开，放回来（同名同大小）会沿用原来的 id。
export const READ_STATUS_LABEL = { unread: '未读', reading: '在读', finished: '读完', shelved: '搁置', missing: '不在书库' }
