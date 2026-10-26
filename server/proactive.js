// 主动陪读：观察阅读行为，在合适的时机给 Claude 派任务（经 channel 推送）。
// 对应 MoRead 的 ProactiveAnnotationService（随读段评）与陪伴提醒，但触发在本地判断，
// Claude 只在真正需要它的时候被叫醒。所有触发都受设置开关、每日上限和「Claude 是否在线」约束。
import { getBook } from './library.js'
import { getSettings } from './settings.js'
import * as store from './store.js'

const EVENT_TTL_MS = 20 * 60000   // 事件 20 分钟内没送达就作废，过时的「你卡住了吗」没有意义
const IDLE_MS = 10 * 60000        // 10 分钟没有心跳视为一段阅读结束
const MIN = 60

// ---------- Claude 在线状态（channel 桥接连着即在线） ----------

let channelClients = 0
export function setChannelClient(delta) {
  channelClients = Math.max(0, channelClients + delta)
  store.events.emit('change', { type: 'status', channel: channelClients > 0 })
}
export const channelOnline = () => channelClients > 0

// ---------- 章节划分 ----------

const CHAPTER_RE = /^\s*(第\s*[0-9０-９一二三四五六七八九十百零〇两]+\s*[章讲課课回]|chapter\s+[0-9ivxlc]+\b|lesson\s+\d+\b)/i

/**
 * 找出「章」：
 * 1. 目录里有 ≥3 条形如「第N章 / Chapter N」的标题时，取它们最常见的那一层，该层从第一章起的条目都算章
 *    （含其后的附录、后记）；章的结尾是下一个同层或更上层条目（如「第二部分」）。
 *    这样不管书把章挂在目录的第几层（有的 PDF 把全书都挂在「目录」书签下面）都能找对。
 * 2. 否则从最浅层往下找，直到最长的一「章」不超过全书的 35%。
 * 3. 没有可用的目录：PDF 每 10 页、EPUB 每节算一章。
 */
export function chaptersOf(meta) {
  const last = meta.sectionBase + meta.sectionCount - 1
  let entries = meta.toc.filter(t => t.section != null && t.section <= last).sort((a, b) => a.section - b.section)
  // 有的扫描版 PDF 每页一个书签，标题就是页码，不是真目录
  const pageMarks = entries.filter(t => /^\s*\d+\s*$/.test(t.title))
  if (pageMarks.length > entries.length / 2) entries = entries.filter(t => !pageMarks.includes(t))
  const build = (chapters, bounds) => {
    const seen = new Set()
    const starts = chapters.filter(t => !seen.has(t.section) && seen.add(t.section))
    const cuts = [...new Set(bounds.map(t => t.section))].sort((a, b) => a - b)
    return starts.map((t, i) => ({ index: i, title: t.title.trim(), start: t.section, end: (cuts.find(c => c > t.section) ?? last + 1) - 1 }))
  }
  const named = entries.filter(t => CHAPTER_RE.test(t.title))
  if (named.length >= 3) {
    const count = {}
    for (const t of named) count[t.depth] = (count[t.depth] ?? 0) + 1
    const depth = Number(Object.entries(count).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0])
    const first = Math.min(...named.filter(t => t.depth === depth).map(t => t.section))
    return build(entries.filter(t => t.depth === depth && t.section >= first), entries.filter(t => t.depth <= depth))
  }
  if (entries.length) {
    const maxDepth = Math.max(...entries.map(t => t.depth))
    for (let d = 0; d <= maxDepth; d++) {
      const level = entries.filter(t => t.depth <= d)
      if (level.length < 3) continue
      const chapters = build(level, level)
      if (Math.max(...chapters.map(c => c.end - c.start + 1)) <= meta.sectionCount * 0.35) return chapters
    }
  }
  const step = meta.format === 'pdf' ? 10 : 1
  const out = []
  for (let s = meta.sectionBase; s <= last; s += step) {
    out.push({ index: out.length, title: meta.format === 'pdf' ? `第${s}–${Math.min(s + step - 1, last)}页` : `第${s}节`, start: s, end: Math.min(s + step - 1, last) })
  }
  return out
}
export const chapterAt = (meta, section) => chaptersOf(meta).filter(c => c.start <= section).pop() ?? null

// ---------- 计数与任务（持久化） ----------

function ledger() {
  const p = store.load(null, 'proactive', { date: '', events: 0, annotations: 0, tasks: {}, done: {} })
  if (p.date !== store.today()) {
    Object.assign(p, { date: store.today(), events: 0, annotations: 0 })
    const cutoff = Date.now() - 2 * 86400000
    for (const [id, t] of Object.entries(p.tasks)) if (Date.parse(t.createdAt) < cutoff) delete p.tasks[id]
  }
  return p
}
const commit = p => store.save(null, 'proactive', p)

export function quotaStatus() {
  const p = ledger()
  const s = getSettings().proactive
  return { events: p.events, eventMax: s.dailyEventMax, annotations: p.annotations, annotationMax: s.dailyMax, online: channelOnline() }
}

/** add_annotation 带 task_id 时调用：检查并占用这一章 / 今天的主动批注额度。 */
export function useAnnotationQuota(taskId, bookId, section) {
  const p = ledger()
  const task = p.tasks[taskId]
  if (!task || task.bookId !== bookId) return { ok: false, reason: '没有这个陪读任务（task_id 无效或已过期）' }
  if (section < task.start || section > task.end) return { ok: false, reason: `这个任务只针对第 ${task.start}–${task.end} ${task.unit}` }
  const s = getSettings().proactive
  if (task.used >= task.max) return { ok: false, reason: `本章主动批注已达上限（${task.max} 条）` }
  if (p.annotations >= s.dailyMax) return { ok: false, reason: `今日主动批注已达上限（${s.dailyMax} 条）` }
  task.used++
  p.annotations++
  commit(p)
  return { ok: true }
}

/** chapter_entry 任务会临时允许 Claude 读到这一章末尾（用户在设置里选了「进入章节时」）。 */
const permits = new Map()
export function readPermit(bookId) {
  const p = permits.get(bookId)
  return p && p.until > Date.now() ? p.upto : null
}

// ---------- 运行时状态 ----------

const rt = new Map()
const runtime = id => {
  let r = rt.get(id)
  if (!r) rt.set(id, r = { section: null, sectionActive: 0, lastBeat: 0, session: null, endDwell: 0 })
  return r
}

// ---------- 事件派发 ----------

function emit(type, bookId, { section, content, task }) {
  const s = getSettings().proactive
  const p = ledger()
  if (!channelOnline()) return false
  if (p.events >= s.dailyEventMax) return false
  let taskId
  if (task) {
    taskId = store.newId()
    p.tasks[taskId] = { ...task, bookId, type, used: 0, createdAt: store.now() }
  }
  p.events++
  commit(p)
  store.pushInbox({
    kind: 'event', event: type, bookId, section, taskId,
    text: content + (taskId ? `\n\n（task_id: ${taskId}，调用 add_annotation 时带上）` : ''),
    expiresAt: new Date(Date.now() + EVENT_TTL_MS).toISOString(),
  })
  console.log(`[陪读] ${type} 《${getBook(bookId)?.meta?.title}》第${section}`)
  return true
}

const once = (key, fn) => {
  const p = ledger()
  if (p.done[key]) return
  if (fn() !== false) { p.done[key] = store.now(); commit(p) }
}

const STYLE_GUIDE = 'style 按语义选：highlight＝金句 / 核心结论；underline＝知识点、术语、需要记住的事实；wavy＝与前文呼应、值得追问或容易误解的地方。不要整批用同一种。'
const VOICE = '批注用你自己的口吻写，像朋友在书边随手写的话：可以点破、追问、类比、提醒易错点，一两句话；不要复述或概括原文。'
const QUIET = '这是阅读器自动派来的陪读任务，用户在看书、不在看终端：做完后在终端只回一句话说明做了什么，不要长篇输出。'

function chapterTask(type, bookId, meta, ch, extra = '') {
  const s = getSettings().proactive
  const p = ledger()
  const unit = meta.format === 'pdf' ? '页' : '节'
  const left = Math.max(0, s.dailyMax - p.annotations)
  const n = Math.min(s.maxPerChapter, left)
  const range = `第 ${ch.start}–${ch.end} ${unit}`
  const lines = [type === 'chapter_complete'
    ? `[主动陪读·读完一章] 用户刚读完《${meta.title}》「${ch.title}」（${range}${extra}）。`
    : `[主动陪读·进入新章] 用户刚开始读《${meta.title}》「${ch.title}」（${range}）。这一章已临时对你开放，可以先读完整章。`]
  if (n > 0) {
    lines.push(`请先 read_book_section 读这一章（有图就看图），挑 ${Math.min(s.minPerChapter, n)}–${n} 处真正值得的地方用 add_annotation 留批注；找不到值得写的就少写，不要凑数。${STYLE_GUIDE}${VOICE}`)
  }
  if (s.termsOnChapter) lines.push('如果这一章引入了新的重要术语 / 概念，用 save_term 记进术语表（先 list_terms 避免重复）。')
  if (s.outlineOnChapter && type === 'chapter_complete') lines.push('用 save_chapter_outline 写这一章的大纲（3~6 个要点，每点附一句逐字原文作为依据）。')
  if (type === 'chapter_complete') lines.push('最后可以用 say 说一句简短的话（可选，比如一个值得想想的问题）。')
  lines.push(QUIET)
  return { section: ch.start, content: lines.join('\n'), task: n > 0 ? { start: ch.start, end: ch.end, max: n, unit } : null }
}

// ---------- 触发 ----------

/** 进度变化（停留 1.5 秒后才上报）。 */
export function onProgress(bookId, prevSection, section) {
  const book = getBook(bookId)
  const meta = book?.meta
  if (!meta) return
  const s = getSettings().proactive
  const r = runtime(bookId)
  if (r.section !== section) { r.section = section; r.sectionActive = 0; r.endDwell = 0 }
  if (r.session) {
    r.session.from = Math.min(r.session.from, section)
    r.session.to = Math.max(r.session.to, section)
  }
  if (prevSection == null || prevSection === section) return
  const oldCh = chapterAt(meta, prevSection)
  const newCh = chapterAt(meta, section)
  if (oldCh && newCh && newCh.start > oldCh.start) maybeComplete(bookId, meta, oldCh)
  if (s.chapterAnnotations && s.timing === 'entry' && newCh && newCh.start !== oldCh?.start && section > prevSection) {
    once(`${bookId}:entry:${newCh.start}`, () => {
      const t = chapterTask('chapter_entry', bookId, meta, newCh)
      const ok = emit('chapter_entry', bookId, t)
      if (ok) permits.set(bookId, { upto: newCh.end, until: Date.now() + 30 * 60000 })
      return ok
    })
  }
}

function maybeComplete(bookId, meta, ch) {
  const s = getSettings().proactive
  const r = runtime(bookId)
  const furthest = store.getState(bookId).furthest ?? -1
  const active = store.getState(bookId).chapterActive?.[ch.start] ?? 0
  if (furthest < ch.end || active < s.chapterMinMinutes * MIN) return
  // 读完一章本身就是足迹，不管 Claude 在不在线都记下
  once(`${bookId}:chapterdone:${ch.start}`, () => store.logExchange({ role: 'system', kind: 'chapter_done', bookId, title: ch.title, section: ch.start }))
  if (!s.chapterAnnotations || s.timing !== 'after') return
  once(`${bookId}:complete:${ch.start}`, () =>
    emit('chapter_complete', bookId, chapterTask('chapter_complete', bookId, meta, ch, `，认真读了约 ${Math.max(1, Math.round(active / MIN))} 分钟`)))
}

/** 阅读心跳：页面可见且最近有操作时每 30 秒一次。 */
export function onHeartbeat(bookId, seconds) {
  const meta = getBook(bookId)?.meta
  if (!meta) return
  const s = getSettings().proactive
  const r = runtime(bookId)
  const now = Date.now()
  const state = store.getState(bookId)
  const section = state.progress?.section
  const unit = meta.format === 'pdf' ? '页' : '节'

  // 新的一段阅读
  if (!r.session || now - r.lastBeat > IDLE_MS) {
    if (r.session) endSession(bookId, r)
    const lastActive = state.lastActiveAt ? Date.parse(state.lastActiveAt) : null
    r.session = { start: now, active: 0, from: section ?? 0, to: section ?? 0, breakDone: false }
    if (s.welcomeBack && lastActive && now - lastActive >= s.welcomeGapHours * 3600000 && section != null) {
      const hours = Math.round((now - lastActive) / 3600000)
      const summary = store.load(bookId, 'summary', null)
      emit('welcome_back', bookId, {
        section,
        content: [`[主动陪读·回来了] 用户隔了约 ${hours >= 48 ? Math.round(hours / 24) + ' 天' : hours + ' 小时'}，回来继续读《${meta.title}》，现在在第 ${section} ${unit}。`,
          summary ? `上次的学习摘要：${summary.content}` : '可以用 recall_memory / list_notes 回忆一下上次读到哪、聊过什么。',
          '用 say 简短打个招呼，一两句话帮用户接上上次的思路（比如上次停在哪个概念、留下的问题）。不要长。', QUIET].join('\n'),
      })
    }
  }
  r.lastBeat = now
  state.lastActiveAt = new Date(now).toISOString()
  store.save(bookId, 'state', state)
  r.session.active += seconds
  if (section == null) return
  r.sectionActive += seconds
  const ch = chapterAt(meta, section)
  // 每章读了多久存进 state，服务重启也不丢
  if (ch) {
    state.chapterActive ??= {}
    state.chapterActive[ch.start] = (state.chapterActive[ch.start] ?? 0) + seconds
    store.save(bookId, 'state', state)
  }

  // 读到一章最后一页并停留了 90 秒：不必等翻到下一章
  if (ch && section === ch.end) {
    r.endDwell += seconds
    if (r.endDwell >= 90) maybeComplete(bookId, meta, ch)
  }

  if (s.stuck && r.sectionActive >= s.stuckMinutes * MIN) {
    once(`${bookId}:stuck:${section}`, () => emit('stuck', bookId, {
      section,
      content: [`[主动陪读·停留较久] 用户在《${meta.title}》第 ${section} ${unit}已经停留了约 ${Math.round(r.sectionActive / MIN)} 分钟（期间一直在操作）。可能卡住了，也可能在认真做练习。`,
        '先 read_book_section 看这一页（有图就看图），然后用 say 轻轻问一句要不要帮忙，可以点出这页最可能卡人的地方。不要直接长篇讲解。', QUIET].join('\n'),
    }))
  }

  if (s.breakReminder && !r.session.breakDone && r.session.active >= s.breakMinutes * MIN) {
    r.session.breakDone = true
    emit('break', bookId, {
      section,
      content: `[主动陪读·休息提醒] 用户已经连续读了约 ${Math.round(r.session.active / MIN)} 分钟。用 say 提醒休息一下，可以顺带一句这段读到的要点。${QUIET}`,
    })
  }
}

function endSession(bookId, r) {
  const sess = r.session
  r.session = null
  const s = getSettings().proactive
  const meta = getBook(bookId)?.meta
  if (!meta || !s.sessionMemory || sess.active < s.sessionMinMinutes * MIN) return
  const unit = meta.format === 'pdf' ? '页' : '节'
  emit('session_end', bookId, {
    section: sess.to,
    content: [`[主动陪读·一段阅读结束] 用户刚结束一段约 ${Math.round(sess.active / MIN)} 分钟的阅读，《${meta.title}》第 ${sess.from}–${sess.to} ${unit}，已经离开。`,
      '请静默整理：用 save_book_summary 更新这本书的学习进度摘要（读到哪、掌握了什么、还有什么疑问）；如果这段时间里有值得长期记住的事（用户的困惑、兴趣、学习习惯、对某个概念的理解程度），用 save_memory 记一条。',
      '不要用 say（用户已经离开），终端里也只回一句话。'].join('\n'),
  })
}

// 定时检查：一段阅读结束（10 分钟没有心跳）
setInterval(() => {
  const now = Date.now()
  for (const [bookId, r] of rt) if (r.session && now - r.lastBeat > IDLE_MS) endSession(bookId, r)
}, 60000).unref()
