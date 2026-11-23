// 直连 opencode-go（OpenAI 兼容端点）的最小客户端：重试 + 用量记账
import { readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { env, envLegacy, readSecret, LLM_CHAT_MODEL } from '../shared/config.mjs'

const ENDPOINT = 'https://opencode.ai/inference/go/openai/v1/chat/completions'
// 凭据文件：DSH_HOME/.credentials.yaml（默认 ~/.dsh/.credentials.yaml），可用 WINNOW_CREDENTIALS_FILE 直指
const DSH_HOME = env('DSH_HOME') || path.join(os.homedir(), '.dsh')
const CREDENTIALS = envLegacy('WINNOW_CREDENTIALS_FILE', 'IM_CREDENTIALS_FILE') || path.join(DSH_HOME, '.credentials.yaml')
const SESSION = randomUUID()

function apiKey () {
  // 顺序：环境变量 → .secrets/opencode-go.key → DSH 凭据文件
  const direct = readSecret('OPENCODE_GO_API_KEY', 'opencode-go.key')
  if (direct) return direct
  if (!existsSync(CREDENTIALS)) throw new Error(`OPENCODE_GO_API_KEY not set and ${CREDENTIALS} not found`)
  const m = readFileSync(CREDENTIALS, 'utf8').match(/^\s*OPENCODE_GO_API_KEY:\s*(\S+)\s*$/m)
  if (!m) throw new Error('OPENCODE_GO_API_KEY not found in credentials file')
  return m[1]
}

// 惰性取 key：模块导入本身不触发凭据读取（便于离线测试与 CI）
let cachedKey = null
function key () { return (cachedKey ??= apiKey()) }

// 只有这些错误值得重试：限流、上游过载/网关、超时与网络中断。
// 400/401/403/404/422 之类重试也不会成功，只会白白等上十几秒（6 次 × 递增退避）。
export function isRetryable (err) {
  const msg = String(err?.message ?? err)
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true
  if (/HTTP (408|409|425|429|5\d\d)\b/.test(msg)) return true
  if (/overloaded|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|Unexpected end of JSON/i.test(msg)) return true
  return false
}

let usageSink = null
/** 装上账单 sink（shared/db.mjs 在 openDb 时安装；测试里不装就不会写库）。 */
export function setUsageSink (fn) { usageSink = fn }

export async function chat ({ messages, model = LLM_CHAT_MODEL, maxTokens = 6000, json = false, temperature = 0, timeoutMs = 180000, retries = Number(process.env.LLM_RETRIES || 6), task = 'chat' }) {
  const body = { model, messages, max_tokens: maxTokens, temperature }
  if (json) body.response_format = { type: 'json_object' }
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const started = performance.now()
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key()}`,
          'Content-Type': 'application/json',
          'x-opencode-session': SESSION
        },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      const ms = Math.round(performance.now() - started)
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      const data = JSON.parse(text)
      const choice = data.choices?.[0]
      const usage = data.usage || {}
      // 账单诚实：每次成功调用都过一遍 sink（shared/db 装上后写 token_ledger）。
      // 以前 usage 只是返回给调用方，没人落库，/audit 的"Token 账本"永远是空的。
      if (usageSink) {
        try {
          usageSink({
            task,
            model: data.model || model,
            latencyMs: ms,
            prompt: usage.prompt_tokens ?? 0,
            completion: usage.completion_tokens ?? 0,
            total: usage.total_tokens ?? 0,
            cost: usage.cost ?? data.opencode?.list_cost ?? 0
          })
        } catch {}
      }
      return {
        content: choice?.message?.content ?? '',
        reasoning: choice?.message?.reasoning_content ?? '',
        finish: choice?.finish_reason,
        usage: {
          prompt: usage.prompt_tokens ?? 0,
          completion: usage.completion_tokens ?? 0,
          total: usage.total_tokens ?? 0,
          cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
          cost: usage.cost ?? data.opencode?.list_cost ?? 0
        },
        latencyMs: ms,
        model: data.model || model
      }
    } catch (e) {
      lastErr = e
      if (!isRetryable(e)) break
      if (attempt < retries) {
        const backoff = /HTTP 429|overloaded/.test(String(e.message)) ? 3000 : 1000
        await new Promise(r => setTimeout(r, Math.min(20000, backoff * attempt)))
      }
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`chat failed: ${lastErr?.message}`)
}

// 从可能带 ```json 包裹/前后废话的输出里取出第一个完整 JSON 对象
export function extractJson (text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)) } catch { return null } } }
  }
  return null
}
