// 统一 embedding 客户端：默认 OpenRouter 的 baai/bge-m3（1024 维），可切自建 llama.cpp。
//
// 环境变量：
//   EMBED_PROVIDER  openrouter（默认） | local
//   EMBED_BASE_URL  local 模式地址，默认 http://127.0.0.1:8033/v1/embeddings
//   EMBED_MODEL     local 模型名，默认 bge-m3
//   EMBED_FALLBACK  默认 1（local 失败时回退 OpenRouter）
//   OPENROUTER_API_KEY / .secrets/openrouter.key
import { readSecret } from '../shared/config.mjs'

const LOCAL_URL = process.env.EMBED_BASE_URL || 'http://127.0.0.1:8033/v1/embeddings'
const PROVIDER = process.env.EMBED_PROVIDER || 'openrouter'
const LOCAL_MODEL = process.env.EMBED_MODEL || 'bge-m3'
const OR_URL = 'https://openrouter.ai/api/v1/embeddings'
const OR_MODEL = process.env.EMBED_OR_MODEL || 'baai/bge-m3'
const FALLBACK = process.env.EMBED_FALLBACK !== '0'
const BATCH = Number(process.env.EMBED_BATCH || 32)

const orKey = () => readSecret('OPENROUTER_API_KEY', 'openrouter.key')

async function post (url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
  const d = JSON.parse(text)
  if (!Array.isArray(d.data)) throw new Error('bad embedding response')
  return d.data.map(x => x.embedding)
}

async function openrouter (chunk) {
  const key = orKey()
  if (!key) throw new Error('missing OpenRouter key')
  return post(OR_URL, { authorization: `Bearer ${key}` }, { model: OR_MODEL, input: chunk })
}

export async function embedBatch (texts) {
  const list = texts.map(t => String(t || '').slice(0, 2000))
  const out = []
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH)
    let vecs = null
    if (PROVIDER === 'local' && LOCAL_URL) {
      try {
        vecs = await post(LOCAL_URL, {}, { model: LOCAL_MODEL, input: chunk })
      } catch (e) {
        if (!FALLBACK) throw e
        console.error('[embed] local failed, fallback OpenRouter:', String(e.message).slice(0, 80))
      }
    }
    if (!vecs) vecs = await openrouter(chunk)
    out.push(...vecs)
  }
  return out
}

export function embedInfo () {
  return { provider: PROVIDER, url: PROVIDER === 'local' ? LOCAL_URL : OR_URL, model: PROVIDER === 'local' ? LOCAL_MODEL : OR_MODEL, dims: 1024, fallback: FALLBACK }
}
