import { marked } from '/vendor/marked/marked.esm.js'
import { fillColor, lineColor, swatches } from './anchor.js'

const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const md = s => marked.parse(esc(s), { breaks: true })
const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}
const fmtTime = iso => {
  const d = new Date(iso), n = new Date()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
const toast = text => {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = text
  document.body.append(el)
  setTimeout(() => el.remove(), 3200)
}

const params = new URLSearchParams(location.search)
const id = params.get('id')
const base = `/api/books/${id}`
let book = await api(base)
document.title = `${book.title} · 墨知`
$('#title').textContent = book.title
const isPdf = book.format === 'pdf'
const unit = isPdf ? '页' : '节'
const tocTitleAt = s => book.toc.filter(t => t.section != null && t.section <= s).pop()?.title
const where = s => isPdf ? `第${s}页` : (tocTitleAt(s) ?? `第${s}节`)

const S = {
  annotations: await api(`${base}/annotations`),
  notes: await api(`${base}/notes`),
  messages: await api(`${base}/messages`),
  k: await api(`${base}/knowledge`),
  status: await api('/api/status'),
  colors: (await api('/api/settings')).settings.highlightColors ?? [],
  ocrLayer: book.ocr && book.ocr.stage !== 'none' ? await api(`${base}/ocr`) : {},
  pos: book.progress,
  furthest: book.furthest,
  tab: 'toc',
  tocView: 'toc',
  annFilter: 'all',
  termQuery: '',
  search: { q: '', result: null, loading: false },
  selection: null,
  unread: false,
}
try {
  S.tab = localStorage.getItem('moread.tab') || 'toc'
  S.tocView = localStorage.getItem('moread.tocView') || 'toc'
} catch {}

const panel = $('#panel')
const selbar = $('#selbar')
const pop = $('#popover')
let popId = null
let selPost

let viewer

// ---------- 进度与阅读时长 ----------

let progressTimer
function relocate(p) {
  S.pos = { ...S.pos, ...p }
  $('#where').textContent = [p.tocLabel ?? (isPdf ? tocTitleAt(p.section) : ''), p.label].filter(Boolean).join(' · ')
  $('#progressBar i').style.width = `${Math.round((p.fraction ?? 0) * 100)}%`
  hideSelbar()
  hidePopover()
  renderBookmarkButton()
  // 停留 1.5 秒才算「读到这里」，快速翻过的页不计入已读范围
  clearTimeout(progressTimer)
  progressTimer = setTimeout(() => {
    api(`${base}/progress`, { method: 'POST', body: p }).then(r => {
      if (r.finished) { book.finished = { at: new Date().toISOString(), by: 'auto' }; renderFinished(); toast('读完了这本书 🎉 以后重翻不会改掉「已读完」') }
    }).catch(() => {})
    if (S.furthest == null || p.section > S.furthest) S.furthest = p.section
    if (S.tab === 'toc') renderPanel()
  }, 1500)
}

// 「在读」：页面在前台、窗口有焦点、3 分钟内有过操作。切到别的程序、别的标签页、最小化都立刻不算，
// 只是鼠标从窗口上划过也不算（窗口没有焦点时的鼠标移动不记）。不算在读的时间另记为「开着没读」。
let lastActive = Date.now()
const focused = () => document.visibilityState === 'visible' && document.hasFocus()
for (const ev of ['mousemove', 'keydown', 'wheel', 'pointerdown']) document.addEventListener(ev, () => { if (focused()) lastActive = Date.now() }, { passive: true })
let tick = Date.now()
setInterval(() => {
  // EPUB 的内容在 iframe 里，事件不冒泡到外层；iframe 有焦点时 document.hasFocus() 也为真
  if (!isPdf && focused()) for (const f of document.querySelector('foliate-view')?.renderer?.getContents?.() ?? []) if (f.doc?.hasFocus()) lastActive = Date.now()
  const secs = Math.min(120, Math.round((Date.now() - tick) / 1000))
  tick = Date.now()
  const active = focused() && Date.now() - lastActive < 3 * 60000
  api(`${base}/progress`, { method: 'POST', body: active ? { activeSeconds: secs } : { idleSeconds: secs } }).catch(() => {})
}, 30000)

// ---------- 顶栏：书签 / 在线状态 / 主题 / 读完 ----------

function renderFinished() {
  const el = $('#finished')
  if (!el) return
  const f = book.finished
  el.textContent = f ? '✓ 已读完' : '标记读完'
  el.classList.toggle('on', !!f)
  el.title = f ? `${f.by === 'me' ? '你' : '读到正文结尾时自动'}标记于 ${new Date(f.at).toLocaleDateString('zh-CN')}；重翻不会改掉。点击取消` : '没翻到最后一页也可以手动标记读完'
}
$('#finished').onclick = async () => {
  const r = await api(`${base}/finished`, { method: 'POST', body: { on: !book.finished } })
  book.finished = r.finished || null
  renderFinished()
}

const bookmarkHere = () => S.k.bookmarks.find(b => b.section === S.pos?.section)
function renderBookmarkButton() {
  const on = !!bookmarkHere()
  $('#bookmark').textContent = on ? '★' : '☆'
  $('#bookmark').title = on ? '移除这里的书签' : '在这里加书签'
}
$('#bookmark').onclick = async () => {
  if (!S.pos) return
  const b = bookmarkHere()
  if (b) await api(`${base}/bookmarks/${b.id}`, { method: 'DELETE' })
  else await api(`${base}/bookmarks`, { method: 'POST', body: { section: S.pos.section, cfi: S.pos.cfi, label: [S.pos.tocLabel ?? tocTitleAt(S.pos.section), S.pos.label].filter(Boolean).join(' · ') } })
  toast(b ? '已移除书签' : '已加书签')
}

function renderStatus() {
  const online = S.status.online
  $('#presence').innerHTML = `<span class="dot-status ${online ? 'on' : ''}"></span>${online ? 'Claude 在线' : 'Claude 离线'}`
  $('#presence').title = online
    ? `伴读模式已连接：提问会实时送达，Claude 也会主动陪读。今日主动批注 ${S.status.annotations}/${S.status.annotationMax}`
    : '用「和Claude一起读.bat」启动后，提问会实时送达，Claude 也会主动陪读'
  $('#chatHint').textContent = online ? 'Claude 在线，会实时收到' : 'Claude 不在伴读模式：下次在终端说话时才会看到'
}

const THEMES = [['system', '◐', '跟随系统'], ['light', '☀', '浅色'], ['dark', '☾', '深色']]
function renderTheme() {
  const [, icon, label] = THEMES.find(t => t[0] === moreadTheme.get()) ?? THEMES[0]
  $('#theme').textContent = icon
  $('#theme').title = `主题：${label}（点击切换）`
}
$('#theme').onclick = () => {
  const i = THEMES.findIndex(t => t[0] === moreadTheme.get())
  moreadTheme.set(THEMES[(i + 1) % THEMES.length][0])
  renderTheme()
}
addEventListener('moread-theme', () => setTimeout(() => viewer?.refreshAnnotations(), 50))

// ---------- 侧栏 ----------

function setTab(tab) {
  S.tab = tab
  try { localStorage.setItem('moread.tab', tab) } catch {}
  if (tab === 'chat') S.unread = false
  for (const b of $('#tabs').children) {
    b.classList.toggle('on', b.dataset.tab === tab)
    b.querySelector('.dot')?.remove()
    if (b.dataset.tab === 'chat' && S.unread) b.insertAdjacentHTML('beforeend', '<span class="dot"></span>')
  }
  $('#composer').hidden = tab !== 'chat'
  renderPanel()
}
$('#tabs').onclick = e => { const t = e.target.closest('[data-tab]')?.dataset.tab; if (t) setTab(t) }
$('#toggleSide').onclick = () => { $('#side').hidden = !$('#side').hidden }
$('#searchBtn').onclick = () => { $('#side').hidden = false; setTab('search'); setTimeout(() => $('#searchInput')?.focus(), 0) }
if (innerWidth < 860) $('#side').hidden = true

const KIND = { insight: '理解', struggle: '困惑', interest: '兴趣', habit: '习惯', milestone: '进展' }
const avatar = who => who === 'claude' ? '<span class="avatar claude">C</span>' : '<span class="avatar me">我</span>'
const whoName = who => who === 'claude' ? 'Claude' : '我'
const readTo = s => S.furthest != null && s <= S.furthest

function renderPanel() {
  const keepScroll = panel.scrollTop
  const render = {
    toc: renderToc, ann: renderAnnotations, notes: renderNotes, chat: renderChat, search: renderSearch,
  }[S.tab] ?? renderToc
  render()
  if (S.tab === 'chat') panel.scrollTop = panel.scrollHeight
  else if (S.tab !== 'toc' || S.tocView !== 'toc') panel.scrollTop = keepScroll
}

function renderToc() {
  const views = [['toc', '目录'], ['outline', '大纲'], ['terms', `术语${S.k.terms.length ? ` ${S.k.terms.length}` : ''}`], ['marks', `书签${S.k.bookmarks.length ? ` ${S.k.bookmarks.length}` : ''}`]]
  const head = `<div class="chips">${views.map(([k, l]) => `<button class="chip${S.tocView === k ? ' on' : ''}" data-tocview="${k}">${l}</button>`).join('')}</div>`
  const cur = S.pos?.section
  let body = ''
  if (S.tocView === 'toc') {
    const rebuild = '<button class="link-btn" data-request="toc">请 Claude 根据书里的目录页重建</button>'
    if (book.tocSource === 'claude') body += `<div class="toc-note">这是 Claude 根据书里印的目录页重建的目录。<button class="link-btn" data-restoretoc>恢复书自带的目录</button></div>`
    else if (!book.tocUsable) body += `<div class="toc-note">${book.toc.length ? '这本书自带的目录不能用来分章（比如每页一个书签），' : '这本书没有目录，'}Claude 现在只能按每 10 页一段陪读。${rebuild}</div>`
    if (!book.toc.length) body += book.tocUsable ? '<div class="empty">这本书没有目录</div>' : ''
    else {
      const current = book.toc.filter(t => t.section != null && cur != null && t.section <= cur).pop()
      body += book.toc.map(t => `<div class="toc-item${t === current ? ' current' : ''}${t.section != null && readTo(t.section) ? ' read' : ''}" data-section="${t.section ?? ''}" style="padding-left:${8 + t.depth * 14}px">${esc(t.title)}${isPdf && t.section ? `<span class="num">${t.section}</span>` : ''}</div>`).join('')
    }
  } else if (S.tocView === 'outline') {
    const chapters = book.chapters.filter(c => readTo(c.start))
    body = chapters.length ? chapters.map(c => {
      const o = S.k.outlines[c.start]
      return `<div class="outline"><div class="outline-title" data-section="${c.start}">${esc(c.title)}<span class="num">${isPdf ? c.start : ''}</span></div>${o
        ? `<ol>${o.points.map(p => `<li>${esc(p.text)}${p.quote ? `<details><summary>依据</summary><div class="quote full" data-locate="${p.section ?? c.start}" data-quote="${esc(p.quote)}">${esc(p.quote)}</div></details>` : ''}</li>`).join('')}</ol>`
        : `<button class="link-btn" data-request="outline" data-start="${c.start}" data-title="${esc(c.title)}">请 Claude 写这一章的大纲</button>`}</div>`
    }).join('') : '<div class="empty">读过的章节会出现在这里，<br>Claude 可以为每章写要点大纲。</div>'
  } else if (S.tocView === 'terms') {
    const q = S.termQuery.trim().toLowerCase()
    const list = [...S.k.terms].sort((a, b) => (a.section ?? 0) - (b.section ?? 0))
      .filter(t => !q || [t.term, t.definition, ...t.aliases].some(x => x.toLowerCase().includes(q)))
    body = `<input type="text" id="termSearch" placeholder="搜索术语…" value="${esc(S.termQuery)}" style="margin-bottom:10px">` +
      (list.length ? list.map(t => `<div class="card" data-locate="${t.section ?? ''}" data-quote="${esc(t.quote ?? '')}"><div class="head"><b style="color:var(--ink);font-size:14px">${esc(t.term)}</b>${t.aliases.length ? `<span>${esc(t.aliases.join(' / '))}</span>` : ''}<span style="flex:1"></span>${t.section != null ? `<span>${esc(where(t.section))}</span>` : ''}<button class="icon-btn" data-delterm="${t.id}" title="删除" style="padding:0 4px">×</button></div><div>${esc(t.definition)}</div></div>`).join('')
        : `<div class="empty">${S.k.terms.length ? '没有匹配的术语' : '术语表还是空的。<br>Claude 读完一章时会顺手整理新概念。'}</div>`) +
      '<button class="link-btn" data-request="terms">请 Claude 整理目前读过部分的术语</button>'
  } else if (S.tocView === 'marks') {
    const list = [...S.k.bookmarks].sort((a, b) => a.section - b.section)
    body = list.length ? list.map(b => `<div class="toc-item" data-bookmark="${b.id}"><span>★</span><span style="flex:1">${esc(b.label || where(b.section))}</span><span class="num">${fmtTime(b.createdAt)}</span><button class="icon-btn" data-delbm="${b.id}" title="删除" style="padding:0 4px">×</button></div>`).join('')
      : '<div class="empty">还没有书签。<br>点顶栏的 ☆ 在当前位置加书签。</div>'
  }
  panel.innerHTML = head + body
  if (S.tocView === 'toc') panel.querySelector('.current')?.scrollIntoView({ block: 'center' })
  const input = $('#termSearch')
  if (input) input.oninput = () => { S.termQuery = input.value; const pos = input.selectionStart; renderPanel(); const n = $('#termSearch'); n.focus(); n.setSelectionRange(pos, pos) }
}

function renderAnnotations() {
  const list = S.annotations.filter(a => S.annFilter === 'all' || a.author === S.annFilter).sort((a, b) => a.section - b.section)
  panel.innerHTML = `<div class="chips">${[['all', '全部'], ['me', '我的'], ['claude', 'Claude']].map(([k, l]) => `<button class="chip${S.annFilter === k ? ' on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>` +
    (list.length ? list.map(a => `<div class="card" data-ann="${a.id}" data-section="${a.section}"><div class="head">${avatar(a.author)}<span>${esc(where(a.section))}</span>${a.proactive ? '<span title="Claude 主动留下的">· 随读</span>' : ''}<span style="flex:1"></span>${a.replies.length ? `💬 ${a.replies.length}` : ''}</div><div class="quote" style="border-color:${lineColor(a.color)}">${esc(a.quote)}</div>${a.note ? `<div class="md">${md(a.note)}</div>` : ''}</div>`).join('')
      : '<div class="empty">还没有批注。<br>选中文字就能划线，或者让 Claude 在书上留言。</div>')
}

function renderNotes() {
  const sum = S.k.summary
  const mems = S.k.memories
  panel.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:10px"><button class="btn" id="newNote" style="flex:1">＋ 写笔记</button><a class="btn" href="${base}/export.md" download title="导出这本书的摘要、大纲、术语、划线、笔记和对话">导出 Markdown</a></div><div id="noteForm"></div>` +
    (sum ? `<div class="card summary" style="cursor:default"><div class="head">${avatar('claude')}<b style="color:var(--ink)">学习进度摘要</b><span style="flex:1"></span><time>${fmtTime(sum.updatedAt)}</time></div><div class="md">${md(sum.content)}</div></div>` : '') +
    (mems.length ? `<details class="card" style="cursor:default"><summary class="head" style="cursor:pointer">${avatar('claude')}<b style="color:var(--ink)">Claude 记住的 ${mems.length} 件事</b></summary>${[...mems].reverse().map(m => `<div class="mem"><span class="tag">${esc(KIND[m.kind] ?? m.kind)}</span>${esc(m.content)}<time> · ${fmtTime(m.createdAt)}</time></div>`).join('')}</details>` : '') +
    (S.notes.length ? [...S.notes].reverse().map(n => `<div class="card" style="cursor:default"><div class="head">${avatar(n.author)}<b style="color:var(--ink)">${esc(n.title || '无题')}</b><span style="flex:1"></span><time>${fmtTime(n.updatedAt)}</time></div><div class="md">${md(n.content)}</div></div>`).join('')
      : (sum ? '' : '<div class="empty">还没有笔记。<br>可以请 Claude 帮你做章节总结、知识点梳理或练习题。</div>'))
}

function renderChat() {
  panel.innerHTML = S.messages.length
    ? `<div class="chat">${S.messages.map(m => `<div class="msg ${m.role === 'claude' ? 'claude' : 'me'}">${avatar(m.role)}<div class="body">${m.quote ? `<div class="quote" data-locate="${m.section}" data-quote="${esc(m.quote)}" style="cursor:pointer">${esc(m.quote)}</div>` : ''}<div class="md">${md(m.text)}</div><time>${fmtTime(m.at)}${m.section != null ? ` · ${esc(where(m.section))}` : ''}</time></div></div>`).join('')}</div>`
    : '<div class="empty">这里是你和 Claude 的伴读对话。<br>选中文字点「问 Claude」，或在下面直接留言。</div>'
}

function renderSearch() {
  const { q, result, loading } = S.search
  const mark = (ctx, m) => esc(ctx).replace(esc(m), `<mark>${esc(m)}</mark>`)
  panel.innerHTML = `<form id="searchForm" style="display:flex;gap:6px;margin-bottom:12px"><input type="text" id="searchInput" placeholder="在书中查找…" value="${esc(q)}"><button class="btn primary">查找</button></form>` +
    (loading ? '<div class="empty">查找中…</div>' : !result ? '<div class="empty">精确查找字词，同时按意思找相关段落。</div>' :
      `<div class="hint" style="margin-bottom:6px">精确匹配 ${result.total} 处${result.total > result.exact.length ? `（显示前 ${result.exact.length} 处）` : ''}</div>` +
      result.exact.map(h => `<div class="hit" data-locate="${h.section}" data-quote="${esc(h.match)}"><span class="num">${esc(where(h.section))}${readTo(h.section) ? '' : ' · 未读'}</span>…${mark(h.context, h.match)}…</div>`).join('') +
      (result.related.length ? `<div class="hint" style="margin:14px 0 6px">意思相关</div>` + result.related.map(r => `<div class="hit" data-locate="${r.section}" data-quote="${esc(r.text.slice(0, 20))}"><span class="num">${esc(where(r.section))}${readTo(r.section) ? '' : ' · 未读'}</span>${esc(r.text)}…</div>`).join('') : ''))
  $('#searchForm').onsubmit = async e => {
    e.preventDefault()
    const q = $('#searchInput').value.trim()
    if (!q) return
    S.search = { q, result: null, loading: true }
    renderPanel()
    try { S.search.result = await api(`${base}/search?q=${encodeURIComponent(q)}`) } catch { toast('查找失败') }
    S.search.loading = false
    renderPanel()
  }
}

async function request(text) {
  await api(`${base}/ask`, { method: 'POST', body: { text, section: S.pos?.section } })
  toast(S.status.online ? '已请 Claude 处理' : '已留言，下次在终端说话时 Claude 会看到')
}

panel.addEventListener('click', async e => {
  const t = e.target
  const f = t.closest('[data-filter]')
  if (f) { S.annFilter = f.dataset.filter; return renderPanel() }
  const tv = t.closest('[data-tocview]')
  if (tv) { S.tocView = tv.dataset.tocview; try { localStorage.setItem('moread.tocView', S.tocView) } catch {} return renderPanel() }
  if (t.id === 'newNote') return noteForm()
  if (t.closest('[data-restoretoc]')) return api(`${base}/toc`, { method: 'DELETE' })
  const req = t.closest('[data-request]')
  if (req) {
    return request({
      outline: `请为「${req.dataset.title}」这一章写大纲（save_chapter_outline）。`,
      terms: '请把我目前读过部分的重要术语整理进术语表（save_term）。',
      toc: '这本书自带的目录不好用，请根据书里印的目录页重建目录（save_toc）。',
    }[req.dataset.request])
  }
  const delterm = t.closest('[data-delterm]')
  if (delterm) { e.stopPropagation(); return api(`${base}/terms/${delterm.dataset.delterm}`, { method: 'DELETE' }) }
  const delbm = t.closest('[data-delbm]')
  if (delbm) { e.stopPropagation(); return api(`${base}/bookmarks/${delbm.dataset.delbm}`, { method: 'DELETE' }) }
  const bm = t.closest('[data-bookmark]')
  if (bm) {
    const b = S.k.bookmarks.find(x => x.id === bm.dataset.bookmark)
    return b && viewer.goTo(!isPdf && b.cfi ? b.cfi : b.section)
  }
  if (t.closest('summary')) return
  const loc = t.closest('[data-locate]')
  if (loc && loc.dataset.locate !== '') return viewer.locate(Number(loc.dataset.locate), loc.dataset.quote)
  const ann = t.closest('[data-ann]')
  const sec = t.closest('[data-section]')
  if (sec && sec.dataset.section !== '') viewer.goTo(Number(sec.dataset.section))
  if (ann) setTimeout(() => showPopover(ann.dataset.ann, ann.getBoundingClientRect()), 300)
})

function noteForm() {
  $('#noteForm').innerHTML = `<div class="card" style="cursor:default"><input type="text" id="nfTitle" placeholder="标题"><textarea id="nfBody" rows="5" placeholder="支持 Markdown" style="margin-top:6px"></textarea><div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end"><button class="btn" id="nfCancel">取消</button><button class="btn primary" id="nfSave">保存</button></div></div>`
  $('#nfTitle').focus()
  $('#nfCancel').onclick = () => { $('#noteForm').innerHTML = '' }
  $('#nfSave').onclick = async () => {
    const content = $('#nfBody').value.trim()
    if (!content) return
    await api(`${base}/notes`, { method: 'POST', body: { title: $('#nfTitle').value.trim(), content } })
  }
}

async function sendChat() {
  const text = $('#chatInput').value.trim()
  if (!text) return
  $('#chatInput').value = ''
  await api(`${base}/ask`, { method: 'POST', body: { text, section: S.pos?.section } })
}
$('#chatSend').onclick = sendChat
$('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendChat() })

// ---------- 选区工具条 ----------

const place = (el, rect, below = false) => {
  el.hidden = false
  const w = el.offsetWidth, h = el.offsetHeight
  let left = Math.min(Math.max(8, rect.left + (rect.right - rect.left) / 2 - w / 2), innerWidth - w - 8)
  let top = below || rect.top - h - 10 < 50 ? rect.bottom + 10 : rect.top - h - 10
  top = Math.min(top, innerHeight - h - 8)
  Object.assign(el.style, { left: `${left}px`, top: `${top}px` })
}
function showSelbar(sel) {
  S.selection = sel
  clearTimeout(selPost)
  // 告诉服务端当前选区，Claude 在终端里能直接看到
  selPost = setTimeout(() => api(`${base}/selection`, { method: 'POST', body: sel ? { section: sel.section, text: sel.text } : {} }).catch(() => {}), 400)
  if (!sel) return hideSelbar()
  hidePopover()
  selbar.innerHTML = `<div class="row">${swatches(S.colors).map(c => `<button class="sw" data-color="${c.id}" title="${esc(c.title)}" style="background:${fillColor(c.id).replace(/,\s*[\d.]+\)$/, ', .9)')}"></button>`).join('')}<span class="sep"></span><button class="icon-btn" data-act="wavy">波浪线</button><button class="icon-btn" data-act="ask">问 Claude</button><button class="icon-btn" data-act="copy">复制</button></div>`
  place(selbar, sel.rect)
}
function hideSelbar() { selbar.hidden = true }
selbar.addEventListener('mousedown', e => { if (!e.target.closest('textarea')) e.preventDefault() })
selbar.addEventListener('click', async e => {
  const sel = S.selection
  if (!sel) return
  const color = e.target.closest('[data-color]')?.dataset.color
  const act = e.target.closest('[data-act]')?.dataset.act
  if (color || act === 'wavy') {
    await api(`${base}/annotations`, { method: 'POST', body: { section: sel.section, quote: sel.text, cfi: sel.cfi, style: color ? 'highlight' : 'wavy', color: color ?? 'blue' } })
    viewer.clearSelection(); hideSelbar()
  } else if (act === 'copy') {
    await navigator.clipboard.writeText(sel.text).catch(() => {})
    toast('已复制'); hideSelbar()
  } else if (act === 'ask') {
    selbar.insertAdjacentHTML('beforeend', `<div class="ask"><textarea id="askInput" rows="2" placeholder="想问什么？留空就是「帮我讲讲这段」"></textarea><div style="display:flex;justify-content:flex-end;gap:6px"><button class="btn primary" id="askSend">发给 Claude</button></div></div>`)
    selbar.querySelector('[data-act=ask]').disabled = true
    place(selbar, sel.rect)
    $('#askInput').focus()
    const send = async () => {
      await api(`${base}/ask`, { method: 'POST', body: { section: sel.section, quote: sel.text, text: $('#askInput').value.trim() } })
      viewer.clearSelection(); hideSelbar()
      if (!$('#side').hidden) setTab('chat')
      toast(S.status.online ? '已发给 Claude' : '已发给 Claude，回终端说一声就行')
    }
    $('#askSend').onclick = send
    $('#askInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() })
  }
})

// ---------- 批注详情 / 讨论 ----------

function showPopover(annId, rect) {
  const a = S.annotations.find(x => x.id === annId)
  if (!a) return
  popId = annId
  hideSelbar()
  const mine = a.author === 'me'
  pop.innerHTML = `<div class="head" style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--ink-3)">${avatar(a.author)}<span class="who">${whoName(a.author)}</span><span>${esc(where(a.section))} · ${fmtTime(a.createdAt)}</span></div>
    <div class="quote full" style="border-color:${lineColor(a.color)}">${esc(a.quote)}</div>
    ${a.note ? `<div class="md">${md(a.note)}</div>` : ''}
    <div class="replies">${a.replies.map(r => `<div class="reply">${avatar(r.author)}<div class="md" style="flex:1">${md(r.text)}</div></div>`).join('')}</div>
    <textarea id="replyInput" rows="2" style="margin-top:10px" placeholder="${mine ? '写点想法，或问问 Claude…' : '回复 Claude…'}"></textarea>
    <div class="actions">${mine ? `${swatches(S.colors).map(c => `<button class="sw" data-recolor="${c.id}" title="${esc(c.title)}" style="width:16px;height:16px;border-radius:50%;border:0;background:${fillColor(c.id).replace(/,\s*[\d.]+\)$/, ', .9)')}"></button>`).join('')}<button class="icon-btn" data-del>删除</button>` : ''}<span style="flex:1"></span>${mine ? '<button class="btn" data-savenote>存为想法</button>' : ''}<button class="btn primary" data-reply>${mine ? '问 Claude' : '回复'}</button></div>`
  place(pop, rect, true)
}
function hidePopover() { pop.hidden = true; popId = null }
pop.addEventListener('click', async e => {
  const a = S.annotations.find(x => x.id === popId)
  if (!a) return
  const text = $('#replyInput')?.value.trim()
  if (e.target.closest('[data-del]')) { await api(`${base}/annotations/${a.id}`, { method: 'DELETE' }); hidePopover() }
  const rc = e.target.closest('[data-recolor]')?.dataset.recolor
  if (rc) await api(`${base}/annotations/${a.id}`, { method: 'PATCH', body: { color: rc, style: 'highlight' } })
  if (e.target.closest('[data-savenote]') && text) await api(`${base}/annotations/${a.id}`, { method: 'PATCH', body: { note: a.note ? `${a.note}\n\n${text}` : text } })
  if (e.target.closest('[data-reply]') && text) {
    await api(`${base}/annotations/${a.id}/replies`, { method: 'POST', body: { text } })
    toast(S.status.online ? '已发给 Claude' : '已发给 Claude，回终端说一声就行')
  }
})
document.addEventListener('mousedown', e => {
  if (!pop.hidden && !pop.contains(e.target)) hidePopover()
  if (!selbar.hidden && !selbar.contains(e.target)) hideSelbar()
})
document.addEventListener('keydown', e => { if (e.key === 'Escape') { hidePopover(); hideSelbar() } })

// ---------- 实时更新（Claude 留批注 / 说话 / 整理知识） ----------

let refreshTimer
const KNOWLEDGE = new Set(['outline', 'term', 'bookmark', 'summary', 'memory'])
new EventSource('/api/events').onmessage = async ev => {
  const e = JSON.parse(ev.data)
  if (e.type === 'status') {
    S.status = await api('/api/status')
    return renderStatus()
  }
  if (e.bookId !== id) return
  if (e.type === 'book') {
    if (e.ocr !== undefined) onOcrStatus(e.ocr)
    return
  }
  if (e.type === 'toc') {
    book = { ...book, ...(await api(base)), finished: book.finished }
    toast(book.tocSource === 'claude' ? 'Claude 重建了目录' : '已恢复书自带的目录')
    if (S.tab === 'toc') renderPanel()
    return
  }
  if (e.type === 'annotation' || e.type === 'annotation-deleted') {
    S.annotations = await api(`${base}/annotations`)
    S.status = await api('/api/status')
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => viewer.refreshAnnotations(), 100)
    if (e.type === 'annotation' && popId === e.item.id) showPopover(popId, pop.getBoundingClientRect())
    if (e.item?.author === 'claude' && !e.item.replies.length && Date.now() - Date.parse(e.item.createdAt) < 5000) toast(`Claude 在${where(e.item.section)}留了批注`)
    else if (e.item?.replies?.at(-1)?.author === 'claude' && popId !== e.item.id) toast('Claude 回复了你的批注')
  } else if (e.type === 'note') {
    S.notes = await api(`${base}/notes`)
    if (e.item.author === 'claude') toast(`Claude 写了笔记：${e.item.title}`)
  } else if (e.type === 'message') {
    S.messages.push(e.item)
    if (e.item.role === 'claude' && (S.tab !== 'chat' || $('#side').hidden)) {
      S.unread = true
      toast(`Claude：${e.item.text.slice(0, 40)}${e.item.text.length > 40 ? '…' : ''}`)
    }
  } else if (KNOWLEDGE.has(e.type)) {
    S.k = await api(`${base}/knowledge`)
    renderBookmarkButton()
    if (e.type === 'outline') toast('Claude 更新了章节大纲')
  } else return
  setTab(S.tab)
}

// ---------- 扫描版：本机文字识别 ----------

const ocrHint = '文字由本机的 RapidOCR 从扫描页识别，不联网、不上传；可能有个别错字。'
function renderOcr() {
  const o = book.ocr
  const el = $('#ocr')
  el.hidden = !o
  if (!o) return
  const stage = o.stage
  if (stage === 'done') el.innerHTML = `<span class="ocr-tag" title="${ocrHint}">本机识别文字</span>`
  else if (stage === 'running' || stage === 'queued') el.innerHTML = `<span class="ocr-tag" title="${ocrHint}识别完的页已经可以选中、划线和查找。">${stage === 'queued' ? '排队识别' : `本机识别中 ${o.done}/${o.total}`}</span><button class="icon-btn" data-ocr="stop">暂停</button>`
  else el.innerHTML = `${o.done ? `<span class="ocr-tag" title="${ocrHint}">已识别 ${o.done}/${book.sectionCount} 页</span>` : '<span class="ocr-tag off" title="扫描版：页面只是图片，不能选中文字或查找">扫描版</span>'}<button class="icon-btn" data-ocr="start" title="用本机的文字识别把扫描页转成文字（不联网、不上传）。之后能查找、划线，Claude 也能直接读文字。">${o.done ? '继续识别' : '识别文字（OCR）'}</button>`
}
$('#ocr').onclick = async e => {
  const act = e.target.closest('[data-ocr]')?.dataset.ocr
  if (!act) return
  e.target.disabled = true
  const res = await fetch(`${base}/ocr`, { method: act === 'start' ? 'POST' : 'DELETE' })
  if (!res.ok) toast((await res.json().catch(() => ({}))).error ?? '操作失败')
}
let ocrFetched = 0
async function onOcrStatus(o) {
  book.ocr = o ? { ...book.ocr, ...o } : book.ocr
  renderOcr()
  // 每多识别 10 页（或识别结束）就把新的文字层拿过来，翻到的页立刻能选中文字
  const done = o?.done ?? 0
  if (done - ocrFetched >= 10 || (o?.stage !== 'running' && done !== ocrFetched)) {
    ocrFetched = done
    S.ocrLayer = await api(`${base}/ocr`)
    viewer?.refreshOcr?.()
    if (o?.stage === 'done') toast('文字识别完成：现在可以查找、划线，Claude 也能直接读这本书了')
  }
}
ocrFetched = Object.keys(S.ocrLayer).length

// 阅读器放在最后创建：初始化时就会触发 relocate / 选区回调，用到上面声明的所有状态
// ---------- 阅读器 ----------

const stage = $('#stage')
stage.innerHTML = ''
const common = {
  stage,
  url: `${base}/file`,
  initial: book.progress,
  getAnnotations: () => S.annotations,
  getOcrPage: n => S.ocrLayer[n],
  onRelocate: relocate,
  onSelect: showSelbar,
  onAnnotationClick: showPopover,
  saveCfi: (annId, cfi) => api(`${base}/annotations/${annId}`, { method: 'PATCH', body: { cfi } }).catch(() => {}),
}
try {
  viewer = isPdf
    ? await (await import('./pdf-view.js')).createPdfViewer(common)
    : await (await import('./epub-view.js')).createEpubViewer(common)
} catch (e) {
  stage.innerHTML = `<div class="loading">打开失败：${esc(e.message)}</div>`
  throw e
}

if (!isPdf) {
  const btn = $('#flow')
  btn.hidden = false
  let flow = 'paginated'
  try { flow = localStorage.getItem('moread.epubFlow') || 'paginated' } catch {}
  btn.textContent = flow === 'paginated' ? '翻页' : '滚动'
  btn.onclick = () => { btn.textContent = viewer.toggleFlow() === 'paginated' ? '翻页' : '滚动' }
  for (const [cls, fn] of [['left', () => viewer.prev()], ['right', () => viewer.next()]]) {
    const b = document.createElement('button')
    b.className = `nav-zone ${cls}`
    b.textContent = cls === 'left' ? '‹' : '›'
    b.onclick = fn
    $('main').append(b)
  }
}
$('#zoomIn').onclick = () => viewer.zoom(1)
$('#zoomOut').onclick = () => viewer.zoom(-1)
$('#zoomFit').onclick = () => viewer.zoom(0)

renderStatus()
renderFinished()
renderOcr()
renderTheme()
renderBookmarkButton()
setTab(S.tab)

// 从回顾页 / 统计页跳过来：?section=12&quote=...
if (params.has('section')) setTimeout(() => viewer.locate(Number(params.get('section')), params.get('quote') ?? ''), 600)
