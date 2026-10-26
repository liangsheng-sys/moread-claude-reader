// Stop hook：Claude 答完一轮后，从对话记录里数出这轮回复的字数，记入陪伴足迹。
// 只统计字数，不上传内容；阅读器没开或解析失败都静默跳过。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let port = 8848
try { port = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).port ?? port } catch {}

function replyChars(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').trimEnd().split('\n')
  let n = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry
    try { entry = JSON.parse(lines[i]) } catch { continue }
    const content = entry.message?.content
    if (entry.type === 'user') {
      // 工具结果也以 user 身份出现，跳过；遇到真正的用户发言就停
      const isToolResult = Array.isArray(content) && content.every(c => c.type === 'tool_result')
      if (!isToolResult) break
      continue
    }
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c.type === 'text') n += [...c.text].length
    }
  }
  return n
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  const chars = input.transcript_path ? replyChars(input.transcript_path) : 0
  if (chars > 0) {
    await fetch(`http://127.0.0.1:${port}/api/footprint/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chars }), signal: AbortSignal.timeout(1500),
    })
  }
} catch { /* 静默 */ }
