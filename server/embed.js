// 本地向量模型（transformers.js + ONNX），首次使用时自动下载。
// multilingual-e5 要求查询加 "query: "、正文加 "passage: " 前缀。
import os from 'node:os'
import path from 'node:path'

// onnxruntime 在 Windows 上读不了含中文的路径，模型默认放在用户目录下的纯英文路径
export const defaultModelDir = () => path.join(os.homedir(), '.cache', 'moread-desk', 'models')

let extractorPromise = null
let settings = null

export function initEmbedding(cfg) {
  settings = { ...cfg, cacheDir: cfg.modelDir ?? defaultModelDir() }
  if (/[^\x00-\x7f]/.test(settings.cacheDir)) console.warn(`[向量] 模型目录含非英文字符，Windows 上可能加载失败：${settings.cacheDir}（可在 config.json 的 embedding.modelDir 改到纯英文路径）`)
}

export const embeddingEnabled = () => !!settings?.enabled

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = settings.cacheDir
      if (settings.remoteHost) env.remoteHost = settings.remoteHost
      return pipeline('feature-extraction', settings.model, { dtype: settings.dtype ?? 'q8' })
    })()
    extractorPromise.catch(() => { extractorPromise = null })
  }
  return extractorPromise
}

async function embed(texts) {
  const extractor = await getExtractor()
  const out = await extractor(texts, { pooling: 'mean', normalize: true })
  const [n, dim] = out.dims
  const vectors = []
  for (let i = 0; i < n; i++) vectors.push(out.data.slice(i * dim, (i + 1) * dim))
  return vectors
}

export const embedQuery = async q => (await embed([`query: ${q}`]))[0]

export async function embedPassages(texts, onProgress) {
  const all = []
  const batch = 16
  for (let i = 0; i < texts.length; i += batch) {
    all.push(...await embed(texts.slice(i, i + batch).map(t => `passage: ${t}`)))
    onProgress?.(Math.min(i + batch, texts.length), texts.length)
  }
  return all
}
