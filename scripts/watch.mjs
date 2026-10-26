// 伴读监听：由伴读会话里的 Claude 用 Monitor 工具启动（node scripts/watch.mjs）。
// 阅读器里发给 Claude 的消息、主动陪读任务，每条打印成一段输出；Monitor 把每段输出当作一次通知唤醒 Claude。
// 不依赖 channels（研究预览，很多账号还没开放）。阅读器服务没开时顺手拉起来。
import { base, ensureServer } from '../server/launcher.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const write = s => new Promise(r => process.stdout.write(s, r))

async function deliverPending() {
  const items = await (await fetch(`${base}/api/inbox/pending`)).json()
  if (!items.length) return
  for (const it of items) {
    const m = it.meta
    const attrs = Object.entries(m).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join(' ')
    await write(`[墨知 ${attrs}]\n${it.content}\n\n`)
  }
  // 写进 stdout 之后才标记已读：监听挂了的话消息还留在收件箱里
  await fetch(`${base}/api/inbox/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: items.map(i => i.id) }) })
}

let chain = Promise.resolve()
const deliver = () => (chain = chain.then(deliverPending).catch(e => console.error('投递失败：', e.message)))

let announced = false
for (;;) {
  try {
    await ensureServer()
    // client=channel：服务端据此显示「Claude 在线」并派发主动陪读任务
    const res = await fetch(`${base}/api/events?client=channel`)
    if (!announced) { await write('[墨知] 已连接阅读器，开始伴读。\n'); announced = true }
    await deliver()
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
        if (data && JSON.parse(data).type === 'inbox') deliver()
      }
    }
  } catch (e) {
    console.error('连接中断：', e.message)
  }
  await sleep(3000)
}
