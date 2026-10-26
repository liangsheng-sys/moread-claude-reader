// 导出一本书的全部记录为 Markdown（MoRead 的 ConversationTranscript / ReviewExporter 的合体）。
import * as store from './store.js'
import * as knowledge from './knowledge.js'
import { getBookSummary } from './memory.js'

const who = a => a === 'claude' ? 'Claude' : '我'
const quote = s => s.split('\n').map(l => `> ${l}`).join('\n')
const date = iso => iso?.slice(0, 16).replace('T', ' ') ?? ''

export function exportBookMarkdown(book) {
  const { meta } = book
  const unit = meta.format === 'pdf' ? '页' : '节'
  const where = s => `第${s}${unit}`
  const out = [`# ${meta.title}`, meta.author ? `*${meta.author}*` : '', `导出于 ${date(new Date().toISOString())} · 墨知桌面`, '']

  const summary = getBookSummary(book.id)
  if (summary) out.push('## 学习进度摘要', '', summary.content, '')

  const outlines = Object.values(knowledge.listOutlines(book.id)).sort((a, b) => a.start - b.start)
  if (outlines.length) {
    out.push('## 章节大纲', '')
    for (const o of outlines) {
      out.push(`### ${o.title}`, '')
      for (const p of o.points) out.push(`- ${p.text}${p.quote ? `\n  > ${p.quote}（${where(p.section ?? o.start)}）` : ''}`)
      out.push('')
    }
  }

  const terms = knowledge.listTerms(book.id)
  if (terms.length) {
    out.push('## 术语表', '')
    for (const t of [...terms].sort((a, b) => (a.section ?? 0) - (b.section ?? 0))) {
      out.push(`- **${t.term}**${t.aliases.length ? `（${t.aliases.join('、')}）` : ''}：${t.definition}${t.section != null ? `　*${where(t.section)}*` : ''}`)
    }
    out.push('')
  }

  const anns = [...store.listAnnotations(book.id)].sort((a, b) => a.section - b.section)
  if (anns.length) {
    out.push('## 划线与批注', '')
    for (const a of anns) {
      out.push(`**${where(a.section)}** · ${who(a.author)}`, '', quote(a.quote), '')
      if (a.note) out.push(a.note, '')
      for (const r of a.replies) out.push(`- ${who(r.author)}：${r.text.replace(/\n/g, ' ')}`)
      if (a.replies.length) out.push('')
    }
  }

  const notes = store.listNotes(book.id)
  if (notes.length) {
    out.push('## 读书笔记', '')
    for (const n of notes) out.push(`### ${n.title || '无题'}`, `*${who(n.author)} · ${date(n.updatedAt)}*`, '', n.content, '')
  }

  const msgs = store.listMessages(book.id)
  if (msgs.length) {
    out.push('## 伴读对话', '')
    for (const m of msgs) {
      out.push(`**${who(m.role)}** · ${date(m.at)}${m.section != null ? ` · ${where(m.section)}` : ''}`, '')
      if (m.quote) out.push(quote(m.quote), '')
      out.push(m.text, '')
    }
  }
  return out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}
