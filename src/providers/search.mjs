// providers/search.mjs — DeepSeek 官方搜索 API 客户端（复用 DSH 的 DeepSeek 账号/Key）
//
// 端点：POST https://api.deepseek.com/v1/tools/search
// 认证：Authorization: Bearer <DEEPSEEK_API_KEY> 或 x-dsh-auth-token: <DeepSeek 账号 token>
// 取 token 顺序：DEEPSEEK_SEARCH_TOKEN → .secrets/deepseek-search.token → ~/.dsh/.credentials.yaml（DSH 账号）
// 限速：官方 5 QPS（账号级），这里做单进程窗口限速。
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readSecret } from '../shared/config.mjs'

const SEARCH_ENDPOINT = process.env.DEEPSEEK_SEARCH_URL || 'https://api.deepseek.com/v1/tools/search'
const FETCH_ENDPOINT = process.env.DEEPSEEK_FETCH_URL || 'https://api.deepseek.com/v1/tools/fetch'
const ENDPOINT = SEARCH_ENDPOINT
const QPS = Number(process.env.DEEPSEEK_SEARCH_QPS || 5)

let cachedToken = null

function fromCredentialsYaml () {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = path.join(home, '.credentials.yaml')
  if (!existsSync(file)) return null
  const s = readFileSync(file, 'utf8')
  const m = s.match(/deepseek-account-platform\/default:\s*\n(?:.*\n)*?\s*token:\s*(\S+)/)
  return m ? m[1] : null
}

export function searchToken () {
  if (cachedToken) return cachedToken
  const t0 = readSecret('DEEPSEEK_SEARCH_TOKEN', 'deepseek-search.token') || readSecret('DEEPSEEK_API_KEY', 'deepseek-search.token')
  if (t0) return (cachedToken = t0)
  const t = fromCredentialsYaml()
  if (t) return (cachedToken = t)
  throw new Error('no DeepSeek search token: set DEEPSEEK_SEARCH_TOKEN or .secrets/deepseek-search.token')
}

const starts = []
async function waitSlot () {
  for (;;) {
    const now = Date.now()
    while (starts.length && now - starts[0] > 1000) starts.shift()
    if (starts.length < QPS) { starts.push(now); return }
    await new Promise(r => setTimeout(r, 120))
  }
}

function norm (x) {
  const snippet = x.snippet || x.summary || ''
  return {
    title: String(x.title || '').trim(),
    url: String(x.url || '').trim(),
    site: x.site_name || '',
    author: x.author || '',
    snippet: String(snippet).replace(/\s+/g, ' ').slice(0, 600),
    summary: String(x.summary || '').slice(0, 1200),
    publishedAt: x.date || null,
    authority: Number.isFinite(x.authority) ? x.authority : null,
    score: Number.isFinite(x.rerank_score) ? x.rerank_score : null
  }
}

export async function search ({ query, count = 10, needContent = false, retries = 2 } = {}) {
  if (!query || !query.trim()) throw new Error('empty query')
  const token = searchToken()
  let lastErr = null
  for (let i = 0; i <= retries; i++) {
    await waitSlot()
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-auth-token': token },
        body: JSON.stringify({ query: query.trim(), count: Math.max(1, Math.min(50, count)), need_content: !!needContent }),
        signal: AbortSignal.timeout(45000)
      })
      const text = await res.text()
      if (res.status === 401) throw new Error('search 401: token rejected')
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`search ${res.status}: ${text.slice(0, 100)}`); await new Promise(r => setTimeout(r, 800 * (i + 1))); continue }
      if (!res.ok) throw new Error(`search ${res.status}: ${text.slice(0, 150)}`)
      const d = JSON.parse(text)
      const list = Array.isArray(d.results) ? d.results : []
      return { query, results: list.map(norm).filter(x => x.url && x.title) }
    } catch (e) {
      lastErr = e
      if (/401/.test(String(e.message))) throw e
      await new Promise(r => setTimeout(r, 500 * (i + 1)))
    }
  }
  throw lastErr || new Error('search failed')
}

export function searchInfo () {
  let token = false
  try { token = !!searchToken() } catch { /* 未配置：报告为 false，而不是让健康检查崩掉 */ }
  return { endpoint: ENDPOINT, fetchEndpoint: FETCH_ENDPOINT, qps: QPS, token }
}

// DeepSeek 网页正文抓取（返回 Markdown 文本），用于反爬/JS 渲染页面的兜底
export async function fetchViaDeepSeek (url, { retries = 2 } = {}) {
  const token = searchToken()
  let lastErr = null
  for (let i = 0; i <= retries; i++) {
    await waitSlot()
    try {
      const res = await fetch(FETCH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-auth-token': token },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(60000)
      })
      const text = await res.text()
      if (res.status === 401) throw new Error('fetch 401: token rejected')
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`fetch ${res.status}`); await new Promise(r => setTimeout(r, 800 * (i + 1))); continue }
      if (!res.ok) throw new Error(`fetch ${res.status}: ${text.slice(0, 120)}`)
      const d = JSON.parse(text)
      if (typeof d.content !== 'string' || d.content.length < 200) throw new Error('fetch: empty content')
      return d.content
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400 * (i + 1))) }
  }
  throw lastErr || new Error('fetch failed')
}
