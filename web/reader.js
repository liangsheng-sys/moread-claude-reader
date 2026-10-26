import { marked } from '/vendor/marked/marked.esm.js'
import { COLORS, fillColor, lineColor } from './anchor.js'

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

const id = new URLSearchParams(location.search).get('id')
const base = `/api/books/${id}`
const book = await api(base)
document.title = `${book.title} · 墨知`
$('#title').textContent = book.title
const isPdf = book.format === 'pdf'
const where = s => isPdf ? `第${s}页` : (book.toc.filter(t => t.section != null && t.section <= s).pop()?.title ?? `第${s}节`)

const S = {
  annotations: await api(`${base}/annotations`),
  notes: await api(`${base}/notes`),
  messages: await api(`${base}/messages`),
  pos: book.progress,
  furthest: book.furthest,
  tab: 'toc',
  annFilter: 'all',
  selection: null,
  unread: false,
}
try { S.tab = localStorage.getItem('moread.tab') || 'toc' } catch {}

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
  $('#where').textContent = [p.tocLabel ?? (isPdf ? book.toc.filter(t => t.section != null && t.section <= p.section).pop()?.title : ''), p.label].filter(Boolean).join(' · ')
  $('#progressBar i').style.width = `${Math.round((p.fraction ?? 0) * 100)}%`
  hideSelbar()
  hidePopover()
  // 停留 1.5 秒才算「读到这里」，快速翻过的页不计入已读范围
  clearTimeout(progressTimer)
  progressTimer = setTimeout(() => {
    api(`${base}/progress`, { method: 'POST', body: p }).catch(() => {})
    if (S.furthest == null || p.section > S.furthest) S.furthest = p.section
    if (S.tab === 'toc') renderPanel()
  }, 1500)
}

let lastActive = Date.now()
for (const ev of ['mousemove', 'keydown', 'wheel', 'pointerdown']) document.addEventListener(ev, () => { lastActive = Date.now() }, { passive: true })
// EPUB 的内容在 iframe 里，事件不冒泡到外层
setInterval(() => {
  if (!isPdf) for (const f of document.querySelector('foliate-view')?.renderer?.getContents?.() ?? []) if (f.doc?.hasFocus()) lastActive = Date.now()
  if (document.visibilityState === 'visible' && Date.now() - lastActive < 3 * 60000) {
    api(`${base}/progress`, { method: 'POST', body: { activeSeconds: 30 } }).catch(() => {})
  }
}, 30000)

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
if (innerWidth < 860) $('#side').hidden = true

const avatar = who => who === 'claude' ? '<span class="avatar claude">C</span>' : '<span class="avatar me">我</span>'
const whoName = who => who === 'claude' ? 'Claude' : '我'

function renderPanel() {
  const cur = S.pos?.section
  if (S.tab === 'toc') {
    if (!book.toc.length) { panel.innerHTML = '<div class="empty">这本书没有目录</div>'; return }
    const current = book.toc.filter(t => t.section != null && cur != null && t.section <= cur).pop()
    panel.innerHTML = book.toc.map((t, i) => `<div class="toc-item${t === current ? ' current' : ''}${t.section != null && S.furthest != null && t.section <= S.furthest ? ' read' : ''}" data-section="${t.section ?? ''}" style="padding-left:${8 + t.depth * 14}px">${esc(t.title)}${isPdf && t.section ? `<span class="num">${t.section}</span>` : ''}</div>`).join('')
    panel.querySelector('.current')?.scrollIntoView({ block: 'center' })
  } else if (S.tab === 'ann') {
    const list = S.annotations.filter(a => S.annFilter === 'all' || a.author === S.annFilter).sort((a, b) => a.section - b.section)
    panel.innerHTML = `<div class="chips">${[['all', '全部'], ['me', '我的'], ['claude', 'Claude']].map(([k, l]) => `<button class="chip${S.annFilter === k ? ' on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>` +
      (list.length ? list.map(a => `<div class="card" data-ann="${a.id}" data-section="${a.section}"><div class="head">${avatar(a.author)}<span>${esc(where(a.section))}</span><span style="flex:1"></span>${a.replies.length ? `💬 ${a.replies.length}` : ''}</div><div class="quote" style="border-color:${lineColor(a.color)}">${esc(a.quote)}</div>${a.note ? `<div class="md">${md(a.note)}</div>` : ''}</div>`).join('')
        : '<div class="empty">还没有批注。<br>选中文字就能划线，或者让 Claude 在书上留言。</div>')
  } else if (S.tab === 'notes') {
    panel.innerHTML = `<button class="btn" id="newNote" style="width:100%;margin-bottom:10px">＋ 写笔记</button><div id="noteForm"></div>` +
      (S.notes.length ? [...S.notes].reverse().map(n => `<div class="card" style="cursor:default"><div class="head">${avatar(n.author)}<b style="color:var(--ink)">${esc(n.title || '无题')}</b><span style="flex:1"></span><time>${fmtTime(n.updatedAt)}</time></div><div class="md">${md(n.content)}</div></div>`).join('')
        : '<div class="empty">还没有笔记。<br>可以请 Claude 帮你做章节总结、知识点梳理或练习题。</div>')
  } else if (S.tab === 'chat') {
    panel.innerHTML = S.messages.length
      ? `<div class="chat">${S.messages.map(m => `<div class="msg ${m.role === 'claude' ? 'claude' : 'me'}">${avatar(m.role)}<div class="body">${m.quote ? `<div class="quote" data-section="${m.section}" style="cursor:pointer">${esc(m.quote)}</div>` : ''}<div class="md">${md(m.text)}</div><time>${fmtTime(m.at)}${m.section != null ? ` · ${esc(where(m.section))}` : ''}</time></div></div>`).join('')}</div>`
      : '<div class="empty">这里是你和 Claude 的伴读对话。<br>选中文字点「问 Claude」，或在下面直接留言。</div>'
    panel.scrollTop = panel.scrollHeight
  }
}
$('#chatHint').textContent = '在终端里跟 Claude 说句话，它就会看到这里的留言'

panel.addEventListener('click', e => {
  const f = e.target.closest('[data-filter]')
  if (f) { S.annFilter = f.dataset.filter; return renderPanel() }
  if (e.target.id === 'newNote') return noteForm()
  const ann = e.target.closest('[data-ann]')
  const sec = e.target.closest('[data-section]')
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
  selbar.innerHTML = `<div class="row">${Object.keys(COLORS).slice(0, 4).map(c => `<button class="sw" data-color="${c}" title="划线" style="background:${fillColor(c).replace(/,\s*[\d.]+\)$/, ', .9)')}"></button>`).join('')}<span class="sep"></span><button class="icon-btn" data-act="wavy">波浪线</button><button class="icon-btn" data-act="ask">问 Claude</button><button class="icon-btn" data-act="copy">复制</button></div>`
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
      toast('已发给 Claude，回终端说一声就行')
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
    <div class="actions">${mine ? `${Object.keys(COLORS).slice(0, 4).map(c => `<button class="sw" data-recolor="${c}" style="width:16px;height:16px;border-radius:50%;border:0;background:${fillColor(c).replace(/,\s*[\d.]+\)$/, ', .9)')}"></button>`).join('')}<button class="icon-btn" data-del>删除</button>` : ''}<span style="flex:1"></span>${mine ? '<button class="btn" data-savenote>存为想法</button>' : ''}<button class="btn primary" data-reply>${mine ? '问 Claude' : '回复'}</button></div>`
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
    toast('已发给 Claude，回终端说一声就行')
  }
})
document.addEventListener('mousedown', e => {
  if (!pop.hidden && !pop.contains(e.target)) hidePopover()
  if (!selbar.hidden && !selbar.contains(e.target)) hideSelbar()
})
document.addEventListener('keydown', e => { if (e.key === 'Escape') { hidePopover(); hideSelbar() } })

// ---------- 实时更新（Claude 留批注 / 说话） ----------

let refreshTimer
new EventSource('/api/events').onmessage = async ev => {
  const e = JSON.parse(ev.data)
  if (e.bookId !== id) return
  if (e.type === 'annotation' || e.type === 'annotation-deleted') {
    S.annotations = await api(`${base}/annotations`)
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
  } else return
  setTab(S.tab)
}

// 阅读器放在最后创建：初始化时就会触发 relocate / 选区回调，用到上面声明的所有状态
// ---------- 阅读器 ----------

const stage = $('#stage')
stage.innerHTML = ''
const common = {
  stage,
  url: `${base}/file`,
  initial: book.progress,
  getAnnotations: () => S.annotations,
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

setTab(S.tab)
