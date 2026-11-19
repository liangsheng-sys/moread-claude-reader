// 用户设置（设置页可改），存 data/settings.json。默认值参照 MoRead 的 CompanionAutonomySettings /
// ProactiveAnnotationLimits，但主动陪读默认开启：桌面版不额外花钱，只占用 Claude 订阅的用量。
import { load, save } from './store.js'

export const DEFAULTS = {
  spoilerGuard: true,
  highlightColors: [],
  proactive: {
    // 读完 / 进入一章时请 Claude 留批注（MoRead「随读段评」）
    chapterAnnotations: true,
    timing: 'after',          // 'after' 读完一章后 | 'entry' 进入章节时（会允许 Claude 先读这一章）
    // 'chapter' 按章节：一章一次，条数按篇幅算（每 10 页 density 条，最多 maxPerUnit）
    // 'pages' 按页数分段：长章每 segmentPages 页一次，每次 minPerChapter~maxPerChapter 条
    annotationMode: 'chapter',
    density: 4,
    maxPerUnit: 40,
    segmentPages: 10,
    minPerChapter: 1,
    maxPerChapter: 5,
    dailyMax: 10,             // 每日主动批注上限
    chapterMinMinutes: 3,     // 一章至少认真读了这么久才算「读完」，快速翻过不触发
    termsOnChapter: true,     // 读完一章时顺手整理新术语
    outlineOnChapter: false,  // 读完一章时自动写章节大纲
    // 其他主动行为
    stuck: true,              // 在同一页停留过久时问一句要不要帮忙
    stuckMinutes: 8,
    welcomeBack: true,        // 隔一段时间回来时打招呼并回顾上次
    welcomeGapHours: 6,
    sessionMemory: true,      // 一段阅读结束后静默更新学习摘要与长期记忆
    sessionMinMinutes: 15,
    breakReminder: false,     // 连续阅读过久提醒休息
    breakMinutes: 45,
    dailyEventMax: 20,        // 每日主动事件总上限（防止意外刷屏、占满用量）
  },
}

// 自选荧光笔色：[{ hex: '#rrggbb', name }]，最多 8 个
const cleanColors = list => (Array.isArray(list) ? list : [])
  .filter(c => /^#[0-9a-f]{6}$/i.test(c?.hex ?? '')).slice(0, 8)
  .map(c => ({ hex: c.hex.toLowerCase(), name: String(c.name ?? '').slice(0, 12) }))

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v
  }
  return out
}

let initial = {}
export const initSettings = fromConfig => { initial = fromConfig }

export const getSettings = () => merge(merge(DEFAULTS, initial), load(null, 'settings', {}))

export function updateSettings(patch) {
  const next = merge(load(null, 'settings', {}), patch)
  const p = next.proactive ?? {}
  // 与 MoRead ProactiveAnnotationLimits.normalized 同样的约束：下限不超过上限，数值落在合理范围
  const clamp = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d
  for (const [k, lo, hi] of [['density', 1, 20], ['maxPerUnit', 1, 100], ['segmentPages', 3, 60], ['maxPerChapter', 1, 30], ['minPerChapter', 0, 30], ['dailyMax', 0, 500], ['chapterMinMinutes', 0, 120],
    ['stuckMinutes', 2, 120], ['welcomeGapHours', 1, 168], ['sessionMinMinutes', 5, 240], ['breakMinutes', 10, 240], ['dailyEventMax', 0, 300]]) {
    if (k in p) p[k] = clamp(p[k], lo, hi, DEFAULTS.proactive[k])
  }
  if ('minPerChapter' in p || 'maxPerChapter' in p) {
    const max = p.maxPerChapter ?? getSettings().proactive.maxPerChapter
    if ((p.minPerChapter ?? 0) > max) p.minPerChapter = max
  }
  if ('annotationMode' in p && !['chapter', 'pages'].includes(p.annotationMode)) p.annotationMode = DEFAULTS.proactive.annotationMode
  if ('highlightColors' in next) next.highlightColors = cleanColors(next.highlightColors)
  save(null, 'settings', next)
  return getSettings()
}
