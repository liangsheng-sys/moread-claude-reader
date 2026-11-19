// 陪伴足迹与阅读统计。口径参照 MoRead feature/companion/CompanionStatistics.kt、CompanionStory.kt：
// - 一轮有效交流＝用户说话后、下一条用户消息前收到 Claude 的非空回复（批注、笔记不算对话）
// - 同一本书、间隔不超过 30 分钟的交流合并为一次「共读」
// - 首次交流、第 10/50/100… 次交流在全部历史中计数，再按时段筛选展示
import { listBooks } from './library.js'
import { listMemories, MEMORY_KINDS } from './memory.js'
import * as store from './store.js'

const SESSION_GAP_MS = 30 * 60000
const MILESTONES = [10, 50, 100, 200, 500, 1000, 2000, 5000]

const dayOf = iso => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + n)
  return dayOf(d.toISOString())
}

export const DAYPARTS = [[0, 4, '深夜'], [5, 7, '清晨'], [8, 11, '上午'], [12, 17, '下午'], [18, 20, '傍晚'], [21, 23, '夜里']]
const daypart = h => DAYPARTS.find(([a, b]) => h >= a && h <= b)[2]

/** 把交流流水配成「轮」。 */
export function buildRounds(exchanges) {
  const rounds = []
  let open = null
  for (const e of [...exchanges].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.kind !== 'chat') continue
    if (e.role === 'user') {
      open = { at: e.at, bookId: e.bookId ?? null, source: e.source, chars: e.chars ?? 0, replied: false }
    } else if (e.role === 'claude' && open && (e.chars ?? 0) > 0) {
      if (!open.replied) { open.replied = true; rounds.push(open) }
      open.chars += e.chars
      open.bookId ??= e.bookId ?? null
    }
  }
  return rounds
}

export function computeStats(periodDays) {
  const today = dayOf(new Date().toISOString())
  const since = periodDays ? addDays(today, -(periodDays - 1)) : null
  const inPeriod = day => day <= today && (!since || day >= since)
  const books = listBooks()
  const titles = Object.fromEntries(books.map(b => [b.id, b.title]))
  const exchanges = store.listExchanges()

  // ---------- 阅读 ----------
  const readingByDay = {}        // day -> secs（全部书）
  const readingByBookDay = {}    // bookId -> day -> secs
  const hours = Array(24).fill(0)
  const perBook = []
  for (const b of books) {
    const st = store.getState(b.id)
    readingByBookDay[b.id] = st.readingLog
    let secs = 0
    for (const [day, s] of Object.entries(st.readingLog)) {
      readingByDay[day] = (readingByDay[day] ?? 0) + s
      if (inPeriod(day)) secs += s
    }
    for (const [day, hs] of Object.entries(st.readingHours ?? {})) if (inPeriod(day)) for (const [h, s] of Object.entries(hs)) hours[h] += s
    if (secs > 0) perBook.push({ id: b.id, title: b.title, format: b.format, seconds: secs, percent: Math.round((b.progress?.fraction ?? 0) * 100), finished: !!b.finished })
  }
  perBook.sort((a, b) => b.seconds - a.seconds)
  const readDays = Object.keys(readingByDay).filter(d => readingByDay[d] >= 60).sort()
  const streak = (() => {
    let n = 0
    let d = readingByDay[today] >= 60 ? today : addDays(today, -1)
    while (readingByDay[d] >= 60) { n++; d = addDays(d, -1) }
    return n
  })()
  let longest = 0, run = 0, prev = null
  for (const d of readDays) { run = prev && addDays(prev, 1) === d ? run + 1 : 1; longest = Math.max(longest, run); prev = d }
  const heatmapStart = addDays(today, -7 * 26 + 1)
  const heatmap = []
  for (let d = heatmapStart; d <= today; d = addDays(d, 1)) heatmap.push([d, Math.round(readingByDay[d] ?? 0)])
  // 书开着但没在读（0.5.0 起才有记录）
  let idleSecs = 0
  for (const b of books) for (const [d, v] of Object.entries(store.getState(b.id).idleLog ?? {})) if (inPeriod(d)) idleSecs += v
  const periodSecs = Object.entries(readingByDay).filter(([d]) => inPeriod(d)).reduce((n, [, s]) => n + s, 0)
  const periodDaysRead = Object.entries(readingByDay).filter(([d, s]) => inPeriod(d) && s >= 60).length

  // ---------- 陪伴 ----------
  const allRounds = buildRounds(exchanges)
  const rounds = allRounds.filter(r => inPeriod(dayOf(r.at)))
  const claudeActs = exchanges.filter(e => e.role === 'claude' && e.kind !== 'chat' && inPeriod(dayOf(e.at)))
  const togetherBooks = new Set([...rounds.map(r => r.bookId), ...claudeActs.map(e => e.bookId)].filter(id => id && titles[id]))
  const chatChars = exchanges.filter(e => e.kind === 'chat' && inPeriod(dayOf(e.at))).reduce((n, e) => n + (e.chars ?? 0), 0)
  const roundsByHour = Array(24).fill(0)
  for (const r of rounds) roundsByHour[new Date(r.at).getHours()]++
  const peak = roundsByHour.reduce((best, n, h) => n > 0 && (best == null || n >= roundsByHour[best]) ? h : best, null)
  const firstDay = allRounds[0] ? dayOf(allRounds[0].at) : null
  let togetherSecs = 0
  for (const id of togetherBooks) for (const [d, s] of Object.entries(readingByBookDay[id] ?? {})) if (inPeriod(d)) togetherSecs += s

  // 时间线
  const events = []
  if (allRounds[0]) events.push({ type: 'first', at: allRounds[0].at, bookId: allRounds[0].bookId })
  MILESTONES.forEach(n => allRounds[n - 1] && events.push({ type: 'milestone', at: allRounds[n - 1].at, count: n }))
  const seen = new Set()
  let session = null
  for (const r of allRounds) {
    const first = r.bookId && !seen.has(r.bookId)
    if (r.bookId) seen.add(r.bookId)
    if (session && dayOf(session.at) === dayOf(r.at) && Date.parse(r.at) - Date.parse(session.endAt) <= SESSION_GAP_MS && session.bookId === r.bookId) {
      session.endAt = r.at
      session.rounds++
      session.firstMeeting ||= first
      session.sources.add(r.source)
    } else {
      if (session) events.push(session)
      session = { type: 'session', at: r.at, endAt: r.at, rounds: 1, bookId: r.bookId, firstMeeting: first, sources: new Set([r.source]) }
    }
  }
  if (session) events.push(session)
  // Claude 留下的批注 / 笔记：按天、按书合并成一条
  const acts = new Map()
  for (const e of exchanges.filter(e => e.role === 'claude' && (e.kind === 'annotation' || e.kind === 'note'))) {
    const key = `${dayOf(e.at)}|${e.bookId}`
    const a = acts.get(key) ?? { type: 'marks', at: e.at, bookId: e.bookId, annotations: 0, notes: 0, proactive: 0 }
    a[e.kind === 'note' ? 'notes' : 'annotations']++
    if (e.proactive) a.proactive++
    acts.set(key, a)
  }
  events.push(...acts.values())
  for (const e of exchanges.filter(e => e.kind === 'chapter_done')) events.push({ type: 'chapter', at: e.at, bookId: e.bookId, title: e.title })
  for (const m of listMemories()) events.push({ type: 'memory', at: m.createdAt, bookId: m.bookId, kind: MEMORY_KINDS[m.kind] ?? m.kind, content: m.content })

  const order = ['first', 'session', 'chapter', 'marks', 'milestone', 'memory']
  const byDay = new Map()
  for (const e of events) {
    const d = dayOf(e.at)
    if (!inPeriod(d)) continue
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(e.sources ? { ...e, sources: [...e.sources] } : e)
  }
  const days = [...byDay].sort((a, b) => b[0].localeCompare(a[0])).map(([day, list]) => {
    list.sort((a, b) => a.at.localeCompare(b.at) || order.indexOf(a.type) - order.indexOf(b.type))
    const dayRounds = rounds.filter(r => dayOf(r.at) === day)
    const hourly = Array(24).fill(0)
    dayRounds.forEach(r => hourly[new Date(r.at).getHours()]++)
    const last = new Date(list.at(-1).at)
    return { day, rounds: dayRounds.length, readingSeconds: Math.round(readingByDay[day] ?? 0), hourly, lastMinute: last.getHours() * 60 + last.getMinutes(), events: list }
  })

  return {
    today, period: periodDays ?? 'all', titles,
    footprint: {
      rounds: rounds.length,
      activeDays: new Set(rounds.map(r => dayOf(r.at))).size,
      books: togetherBooks.size,
      chatChars,
      readingSeconds: togetherSecs,
      claudeAnnotations: claudeActs.filter(e => e.kind === 'annotation').length,
      claudeNotes: claudeActs.filter(e => e.kind === 'note').length,
      memories: listMemories().filter(m => inPeriod(dayOf(m.createdAt))).length,
      firstDay,
      daysKnown: firstDay ? Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${firstDay}T12:00:00`)) / 86400000) + 1 : 0,
      roundsByHour, peakHour: peak, peakDaypart: peak == null ? null : daypart(peak),
      days,
    },
    reading: {
      seconds: periodSecs, idleSeconds: idleSecs, daysRead: periodDaysRead, streak, longestStreak: longest,
      totalDaysRead: readDays.length, heatmap, hours: hours.map(Math.round), perBook,
    },
  }
}
