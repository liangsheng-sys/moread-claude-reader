// 确保阅读器服务在运行：没开就在后台拉起（日志写到 data/server.log）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildId } from './build.js'
import { loadConfig, root } from './config.js'

export { root }
const config = loadConfig()
export const base = `http://127.0.0.1:${config.port}`

export async function alive() {
  try { return (await fetch(`${base}/api/books`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
}

async function runningBuild() {
  try { return (await (await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1500) })).json()).build ?? null } catch { return null }
}

/** 在跑的服务是旧代码（更新过之后没重启）就请它退出，返回是否重启了。 */
async function stopIfOutdated() {
  if (await runningBuild() === buildId(root)) return false
  try { await fetch(`${base}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1500) }) } catch {}
  for (let i = 0; i < 20 && await alive(); i++) await new Promise(r => setTimeout(r, 300))
  return true
}

export async function ensureServer() {
  if (await alive()) {
    if (!await stopIfOutdated()) return true
    if (await alive()) return true   // 0.6.0 及更早的服务没有退出接口，只能先用着
    console.log('[墨知] 代码已更新，已重启阅读器服务')
  }
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
