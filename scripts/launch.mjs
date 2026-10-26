// 双击启动：拉起阅读器服务并打开浏览器。
import { exec } from 'node:child_process'
import { ensureServer, base } from '../server/launcher.js'

if (await ensureServer()) {
  exec(`start "" "${base}/"`)
  console.log(`墨知已在运行：${base}`)
} else {
  console.error('启动失败，请查看 data/server.log')
  process.exitCode = 1
}
