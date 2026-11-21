// 读取配置：内置默认值 ← config.json（随仓库发布）← config.local.json（本机覆盖，不入库）。
// 只用 Node 内置模块，hook 也能直接引用。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const defaults = {
  port: 8848,
  libraryDir: './书库',
  dataDir: './data',
  spoilerGuard: true,
  embedding: { enabled: true, model: 'Xenova/multilingual-e5-small', dtype: 'q8' },
}

const read = name => {
  const file = path.join(root, name)
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// 嵌套对象（embedding、ocr）按字段合并，本机只写想改的那一项即可。
const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v
  }
  return out
}

export function loadConfig() {
  const config = merge(merge(defaults, read('config.json')), read('config.local.json'))
  // 调试 / 截图用：临时换一个书库，不改配置文件
  if (process.env.MOREAD_LIBRARY_DIR) config.libraryDir = process.env.MOREAD_LIBRARY_DIR
  return config
}

export function configPort() {
  try { return loadConfig().port ?? defaults.port } catch { return defaults.port }
}
