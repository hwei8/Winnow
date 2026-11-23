// domains/ingest/claims.mjs — 从正文抽 claim（分块 + 文内去重）
//
// 为什么分块：以前是「最多 15 条 + full.slice(0, 7000)」。SemiAnalysis 的 24k 字长文和
// 1.2k 字的快讯都只出 15 条，深度源的优势在第一步就被抹平了；更糟的是被切掉的正文
// 里的事实永远不会进库，后面所有机制（归簇、链接、QA）都在一个被截断的世界里工作。
//
// 现在：按段落切 ~3500 字一块，每块按长度给上限（6–12 条），块内/跨块按规范化文本去重，
// 总数上限 40（可配）。quote 仍然是逐字原文，保证 claim_evidence 能定位。

import { chat, extractJson } from '../../providers/llm.mjs'
import { locate } from './feed.mjs'
import { runPool } from '../../shared/pool.mjs'

const CHUNK_CHARS = Number(process.env.EXTRACT_CHUNK_CHARS || 3500)
const MAX_CLAIMS = Number(process.env.EXTRACT_MAX_CLAIMS || 40)
const MIN_CHUNK = 400 // 太短的尾块并进上一块，不值得一次调用

/** 按段落边界切块；单段超长时硬切。 */
export function chunkText (text, size = CHUNK_CHARS) {
  const paras = String(text || '').split(/\n{2,}/).filter(p => p.trim())
  const chunks = []
  let buf = ''
  for (const p of paras) {
    if (p.length > size) {
      if (buf) { chunks.push(buf); buf = '' }
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size))
      continue
    }
    if (buf.length + p.length + 2 > size) { chunks.push(buf); buf = p } else buf = buf ? `${buf}\n\n${p}` : p
  }
  if (buf) chunks.push(buf)
  // 尾块太短就并进前一块
  if (chunks.length > 1 && chunks[chunks.length - 1].length < MIN_CHUNK) {
    chunks[chunks.length - 2] += '\n\n' + chunks.pop()
  }
  return chunks
}

const PROMPT = (cap, body) => `从下面内容抽取最多 ${cap} 条原子事实，每条给逐字 quote（≥10 字，必须能在原文里原样找到），text 用简体中文。只输出 JSON：{"claims":[{"text":"...","quote":"...","confidence":0.8}]}\n\n${body}`

const normKey = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '')

/**
 * 分块抽取。返回 `[{ text, quote, confidence, start, end }]`，偏移是相对**整篇正文**的。
 * 去重键是"规范化后的 text"，同一件事换个说法仍然会重复——那交给 fact 归簇，不在这里硬猜。
 */
export async function extractClaimsFromText (text, { concurrency = 2 } = {}) {
  const full = String(text || '')
  const chunks = chunkText(full)
  if (!chunks.length) return []
  // 超长文章不必无限切：先按块数上限截断（默认 12 块 ≈ 42k 字），再多就该走摘要而不是抽取。
  const maxChunks = Number(process.env.EXTRACT_MAX_CHUNKS || 12)
  const used = chunks.slice(0, maxChunks)
  const { results } = await runPool(used.map((body) => async () => {
    const cap = Math.min(12, Math.max(6, Math.ceil(body.length / 450)))
    try {
      const r2 = await chat({ json: true, maxTokens: 12000, task: 'claim_extract', messages: [{ role: 'user', content: PROMPT(cap, body) }] })
      return extractJson(r2.content)?.claims || []
    } catch (e) {
      console.error('[claims] chunk failed:', String(e.message).slice(0, 80))
      return []
    }
  }), { concurrency, label: 'extract-claims' })

  const out = []
  const seen = new Set()
  for (const r of results) {
    const claims = r?.ok ? r.value : []
    for (const c of claims || []) {
      const t = String(c.text || '').trim()
      const q = String(c.quote || '').trim()
      if (t.length < 8 || q.length < 8) continue
      const key = normKey(t)
      if (!key || seen.has(key)) continue
      const pos = locate(full, q)
      if (!pos) continue // 引文对不上原文 ⇒ 幻觉，丢弃（证据红线）
      seen.add(key)
      out.push({ text: t, quote: q, confidence: Number.isFinite(c.confidence) ? c.confidence : 0.5, start: pos[0], end: pos[1] })
      if (out.length >= MAX_CLAIMS) return out
    }
  }
  return out
}

export const extractionInfo = () => ({ chunkChars: CHUNK_CHARS, maxClaims: MAX_CLAIMS })
