// 把阅读器发给 Claude 的消息整理成文字。伴读监听（/api/inbox/pending）和 get_questions 共用，
// 保证 Claude 不管从哪条路收到，都能看到同样的上下文：是谁的批注、上面写了什么、之前聊过什么，
// 以及用户在这一页自己写下的想法 / 练习答案。
import { getBook } from './library.js'
import * as store from './store.js'
import { getList, READ_STATUS_LABEL } from './shelf.js'

const who = a => a === 'claude' ? '你' : '用户'
const indent = s => s.replace(/\n/g, '\n  ')

// 书单页发来的请求：附上书单现状，请 Claude 直接改书单
function formatListItem(i) {
  const l = getList(i.listId)
  if (!l) return `在书单页给你留言（书单已被删除）：${i.text}`
  const lines = [`在书单「${l.name}」（list_id=${l.id}）给你留言：`, i.text || '（没写要求，请看看这个书单，按顺序推荐接下来该读的书）']
  if (l.description) lines.push('', `书单说明：${l.description}`)
  lines.push('', l.items.length ? `现在的书单（共 ${l.items.length} 本，按顺序）：` : '书单现在是空的。')
  l.items.forEach((it, n) => lines.push(`${n + 1}. 《${it.title}》${it.author ? ` ${it.author}` : ''} · ${READ_STATUS_LABEL[it.status]}${it.note ? ` · ${it.note.slice(0, 60)}` : ''}`))
  lines.push('', '用户在书单页，不在看终端，也不在某本书里：直接用 save_reading_list 改书单（推荐的书写进 items，note 写一句为什么读、读到哪一步读它；需要调顺序就用 position），用 message 参数留一段给用户的话（显示在书单顶部）。不要用 say。终端里只回一句话。')
  return lines.join('\n')
}

export function formatInboxItem(i) {
  if (i.kind === 'list') return formatListItem(i)
  const b = getBook(i.bookId)
  const unit = b?.meta?.format === 'pdf' ? '页' : '节'
  const where = b?.meta ? `《${b.meta.title}》${i.section != null ? `第${i.section}${unit}` : ''}` : '阅读器'
  const annotations = i.bookId ? store.listAnnotations(i.bookId) : []
  const lines = []

  if (i.kind === 'reply') {
    const a = annotations.find(x => x.id === i.annotationId)
    lines.push(`在${where}回复了${a ? (a.author === 'claude' ? '你留的' : '他自己的') : ''}批注：`)
    lines.push(`> ${(a?.quote ?? i.quote ?? '').replace(/\n/g, '\n> ')}`)
    if (a?.note) lines.push(`批注内容（${who(a.author)}写的）：${indent(a.note)}`)
    // 之前的讨论（最后一条就是这次的回复，单独列出）
    const earlier = (a?.replies ?? []).slice(0, -1).slice(-6)
    if (earlier.length) lines.push('之前的讨论：', ...earlier.map(r => `- ${who(r.author)}：${indent(r.text)}`))
    lines.push(`这次的回复：${i.text}`)
  } else {
    lines.push(i.kind === 'ask' ? `在${where}选中了一段问你：` : `在${where}给你留言：`)
    if (i.quote) lines.push(`> ${i.quote.replace(/\n/g, '\n> ')}`)
    lines.push(i.text || '（没写问题，请讲讲这段）')
    // 用户在这一页自己写的批注常常就是他的想法或练习答案
    const here = annotations.filter(a => a.author === 'me' && a.section === i.section && a.note)
    if (here.length) lines.push('', '用户在这一页写过的批注：', ...here.map(a => `- 「${a.quote.slice(0, 40)}」：${indent(a.note)}`))
  }

  const mine = annotations.filter(a => a.author === 'me' && (a.note || a.replies.length))
  if (mine.length) lines.push('', `（用户在这本书里共有 ${mine.length} 条写了想法的批注；对答案、复习、提到「我之前写过 / 说过」时，先用 list_annotations author=me 看看。）`)
  return lines.join('\n')
}
