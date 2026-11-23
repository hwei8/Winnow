// providers/jev.mjs — Jev 决策模型客户端（OpenCode Zen 免费优先，OpenRouter 兜底）
// 主通道：OpenCode Zen System One（jev-1.13-free，免费、~200ms、实测 24 并发无 429）
// 兜底：OpenRouter Decisions API（~typesafe/jev-latest = 1.14，$0.042/1M 输入）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from '../shared/db.mjs'

const ZEN_URL = process.env.JEV_ZEN_URL || 'https://opencode.ai/zen/v1/systemone'
const OR_URL = process.env.JEV_OR_URL || 'https://openrouter.ai/api/alpha/decisions'

function readKey (envName, file) {
  if (process.env[envName]) return process.env[envName].trim()
  try { return readFileSync(path.join(ROOT, file), 'utf8').trim() } catch { return null }
}
const ZEN_KEY = readKey('ZEN_API_KEY', '.secrets/zen.key')
const OR_KEY = readKey('OPENROUTER_API_KEY', '.secrets/openrouter.key')
const PROVIDER = process.env.JEV_PROVIDER || (ZEN_KEY ? 'zen' : (OR_KEY ? 'openrouter' : 'zen'))
const FALLBACK = process.env.JEV_FALLBACK !== '0'

// 本地 decision（llama.cpp glide，/v1/systemone，无鉴权）——只用于离线批任务与审计第二意见。
// 必须显式设置 JEV_LOCAL_URL 才会启用：没有默认地址，避免仓库里出现某个人的内网 IP。
// 注意：本地 noul 分布偏低（same_event 最优阈值 ≈0.4，云端 ≈0.7），不要与云端阈值混用。
export async function decideLocal ({ state, questions, timeoutMs = 600000 }) {
  const LOCAL_URL = process.env.JEV_LOCAL_URL
  if (!LOCAL_URL) throw new Error('未配置 JEV_LOCAL_URL：本地 decision 通道未启用')
  const res = await fetch(LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.JEV_LOCAL_MODEL || 'glide', state, questions }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`local decision HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
  return res.json()
}

export function jevProviderInfo () {
  return { provider: PROVIDER, hasZen: !!ZEN_KEY, hasOpenRouter: !!OR_KEY, fallback: FALLBACK }
}

async function callZen (body, timeoutMs) {
  const res = await fetch(ZEN_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ZEN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, model: process.env.JEV_ZEN_MODEL || 'jev-1.13-free' }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Zen HTTP ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

async function callOpenRouter (body, timeoutMs) {
  const res = await fetch(OR_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, model: process.env.JEV_OR_MODEL || '~typesafe/jev-latest' }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

export async function decide ({ state, questions, model, timeoutMs = 120000 }) {
  const body = { state, questions }
  const raw = JSON.stringify(body)
  const estimatedTokens = Math.ceil(raw.length / 3.2)
  if (process.env.JEV_COST_GUARD !== 'off' && estimatedTokens > 60000) {
    throw new Error(`请求过大（约 ${estimatedTokens} tokens），请拆批；如确需发送设置 JEV_COST_GUARD=off`)
  }
  const attempts = []
  if (PROVIDER === 'zen') {
    attempts.push(() => callZen(body, timeoutMs))
    if (FALLBACK && OR_KEY) attempts.push(() => callOpenRouter(body, timeoutMs))
  } else {
    attempts.push(() => callOpenRouter(body, timeoutMs))
    if (FALLBACK && ZEN_KEY) attempts.push(() => callZen(body, timeoutMs))
  }
  let lastErr
  for (const fn of attempts) {
    const t0 = Date.now()
    try {
      const data = await fn()
      return {
        answers: data.answers || {},
        model: data.model,
        usage: data.usage || {},
        latencyMs: Date.now() - t0,
        cost: data.usage?.cost ?? 0
      }
    } catch (e) { lastErr = e }
  }
  throw new Error(`Jev failed on all providers: ${lastErr?.message}`)
}

// 便捷封装：一批 noul 判断题
export async function noulBatch (state, statements, { criteria, model } = {}) {
  const questions = {}
  statements.forEach((stmt, i) => {
    questions['q' + i] = {
      type: 'noul',
      instructions: stmt,
      criteria: criteria || {
        true: 'These describe the same specific event (same actor, same occasion).',
        false: 'These are different events, or merely the same topic/category.'
      }
    }
  })
  const r = await decide({ state, questions, model })
  return { ...r, probabilities: statements.map((_, i) => r.answers['q' + i]?.noul ?? null) }
}
