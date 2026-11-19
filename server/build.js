// 代码版本指纹：package.json 版本 + 服务端代码的修改时间。
// 阅读器服务在后台常驻，关掉浏览器也不会停；更新代码后再点「启动阅读器」，启动器据此发现在跑的是旧版，自动重启。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function buildId(root) {
  const h = createHash('sha1')
  h.update(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version)
  for (const f of fs.readdirSync(path.join(root, 'server')).sort()) {
    if (f.endsWith('.js')) h.update(f + fs.statSync(path.join(root, 'server', f)).mtimeMs)
  }
  return h.digest('hex').slice(0, 12)
}
