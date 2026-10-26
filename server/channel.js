// Claude Code channel 桥接：由 Claude Code 以 stdio 启动，把阅读器里发给 Claude 的消息
// （选段提问、伴读面板留言、批注回复）实时推进会话。阅读器服务没开时顺手拉起来。
// 注意：stdout 是 MCP 协议通道，日志只能写 stderr。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { base, ensureServer } from './launcher.js'

const log = (...a) => console.error('[moread-channel]', ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const mcp = new Server(
  { name: 'moread-channel', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      '用户在墨知阅读器里发给你的消息会以 <channel source="moread-channel" kind="..." book_id="..." section="..."> 到达。' +
      'kind=ask 是选中一段原文后的提问，kind=message 是伴读面板留言，kind=reply 是对某条批注的回复（带 annotation_id）。' +
      '用户此时在看书、不在看终端：用 moread 的 say 工具把回答发到阅读器侧栏；kind=reply 时用 reply_annotation 回在那条批注下。' +
      '需要原文时先 read_book_section / search_book，只读用户已读范围。这些消息已自动标记为已读，无需再调用 get_questions。' +
      'kind=event 是阅读器根据用户的阅读行为自动派来的「主动陪读」任务（读完一章、停留过久、隔天回来、一段阅读结束等），' +
      '按内容里的要求做；带 task_id 的，调用 add_annotation 时必须传上（用于额度控制），额度用完会被拒绝，那就停止。' +
      '主动任务里用户并没有在终端等你：完成后终端只回一句话。',
  },
)
await mcp.connect(new StdioServerTransport())

async function deliverPending() {
  const res = await fetch(`${base}/api/inbox/pending`)
  const items = await res.json()
  if (!items.length) return
  for (const it of items) {
    await mcp.notification({ method: 'notifications/claude/channel', params: { content: it.content, meta: it.meta } })
  }
  await fetch(`${base}/api/inbox/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: items.map(i => i.id) }) })
}

// 串行投递，避免两条消息同时到达时重复推送
let chain = Promise.resolve()
const deliver = () => (chain = chain.then(deliverPending).catch(e => log('投递失败：', e.message)))

// 订阅事件流，断线自动重连
async function listen() {
  for (;;) {
    try {
      await ensureServer()
      await deliver()
      const res = await fetch(`${base}/api/events?client=channel`)
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
      log('连接中断：', e.message)
    }
    await sleep(3000)
  }
}

listen()
