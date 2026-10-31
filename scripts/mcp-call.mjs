// 调试用：node scripts/mcp-call.mjs <tool> '<json args>'
const [tool, args = '{}'] = process.argv.slice(2)
const call = async (method, params, id = 1) => {
  const res = await fetch(`http://127.0.0.1:${process.env.MOREAD_PORT || 8848}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  return res.json()
}
if (!tool) {
  const r = await call('tools/list', {})
  console.log(r.result.tools.map(t => t.name).join(', '))
} else {
  const r = await call('tools/call', { name: tool, arguments: JSON.parse(args) })
  if (r.error) console.log('ERROR', r.error)
  else for (const c of r.result.content) console.log(c.type === 'text' ? c.text : `[${c.type} ${c.mimeType} ${c.data.length}b]`), r.result.isError && console.log('(isError)')
}
