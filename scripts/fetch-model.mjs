// 断点续传下载向量模型（网络不稳时用）。国内可设 HF_ENDPOINT=https://hf-mirror.com
import fs from 'node:fs'
import path from 'node:path'
import { defaultModelDir } from '../server/embed.js'
import { loadConfig } from '../server/config.js'

const config = loadConfig()
const model = config.embedding?.model ?? 'Xenova/multilingual-e5-small'
const dtype = config.embedding?.dtype ?? 'q8'
const endpoint = (process.env.HF_ENDPOINT ?? config.embedding?.remoteHost ?? 'https://huggingface.co').replace(/\/$/, '')
const dir = path.join(config.embedding?.modelDir ?? defaultModelDir(), model)
const onnx = { q8: 'model_quantized.onnx', fp32: 'model.onnx', fp16: 'model_fp16.onnx' }[dtype] ?? 'model_quantized.onnx'
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', `onnx/${onnx}`]

async function download(name) {
  const dest = path.join(dir, name)
  const part = dest + '.part'
  if (fs.existsSync(dest)) return console.log(`✓ ${name}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  for (let attempt = 1; attempt <= 20; attempt++) {
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0
    try {
      const res = await fetch(`${endpoint}/${model}/resolve/main/${name}`, { headers: have ? { Range: `bytes=${have}-` } : {} })
      if (res.status === 416) break
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = have + Number(res.headers.get('content-length') ?? 0)
      const out = fs.createWriteStream(part, { flags: res.status === 206 ? 'a' : 'w' })
      let got = res.status === 206 ? have : 0
      for await (const chunk of res.body) {
        out.write(chunk)
        got += chunk.length
        process.stdout.write(`\r  ${name} ${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`)
      }
      await new Promise(r => out.end(r))
      process.stdout.write('\n')
      break
    } catch (e) {
      console.log(`\n  中断（${e.message}），第 ${attempt} 次重试…`)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  fs.renameSync(part, dest)
  console.log(`✓ ${name}`)
}

for (const f of files) await download(f)
console.log(`模型已就绪：${dir}`)
