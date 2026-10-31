// 把阅读器发给 Claude 的消息整理成文字。伴读监听（/api/inbox/pending）和 get_questions 共用，
// 保证 Claude 不管从哪条路收到，都能看到同样的上下文：是谁的批注、上面写了什么、之前聊过什么，
// 以及用户在这一页自己写下的想法 / 练习答案。
import { getBook } from './library.js'
import * as store from './store.js'

const who = a => a === 'claude' ? '你' : '用户'
const indent = s => s.replace(/\n/g, '\n  ')

export function formatInboxItem(i) {
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
