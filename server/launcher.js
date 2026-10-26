// 确保阅读器服务在运行：没开就在后台拉起（日志写到 data/server.log）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))
export const base = `http://127.0.0.1:${config.port ?? 8848}`

export async function alive() {
  try { return (await fetch(`${base}/api/books`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
}

export async function ensureServer() {
  if (await alive()) return true
  const dataDir = path.resolve(root, config.dataDir ?? './data')
  fs.mkdirSync(dataDir, { recursive: true })
  const out = fs.openSync(path.join(dataDir, 'server.log'), 'a')
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true })
  child.unref()
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await alive()) return true
  }
  return false
}
