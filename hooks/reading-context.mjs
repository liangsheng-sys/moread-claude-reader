// UserPromptSubmit hook：每次用户在终端说话时，把当前阅读状态附给 Claude，并把这句话的字数记入陪伴足迹。
// 阅读器没开就什么也不输出，绝不阻塞对话。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let port = 8848
try { port = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).port ?? port } catch {}

let promptChars = 0
try { promptChars = [...(JSON.parse(fs.readFileSync(0, 'utf8')).prompt ?? '')].length } catch {}

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptChars }), signal: AbortSignal.timeout(1500),
  })
  if (res.ok) process.stdout.write(await res.text())
} catch { /* 阅读器未运行 */ }
