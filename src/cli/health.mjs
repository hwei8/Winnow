// cli/health.mjs — 依赖健康检查（DB / embedding / Jev / Telegram）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT } from '../shared/db.mjs'
import { embedBatch, embedInfo } from '../providers/embed.mjs'

const results = []
const check = async (name, fn) => {
  const t0 = Date.now()
  try { const r = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, detail: r || 'ok' }) }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message).slice(0, 120) }) }
}

await check('db', async () => { const db = openDb(); const n = db.prepare('SELECT COUNT(*) c FROM story').get().c; db.close(); return `stories=${n}` })
const emb = embedInfo()
await check(`embed-${emb.provider}`, async () => {
  const v = await embedBatch(['健康检查'])
  return `dims=${v[0].length} model=${emb.model} fallback=${emb.fallback}`
})
await check('jev', async () => {
  const { noulBatch } = await import('../providers/jev.mjs')
  const r = await noulBatch({ items: ['A 公司发布新芯片', 'A 公司推出新款处理器'] }, ['这两句是否同一事件？'])
  return `model=${r.model || '?'} noul=${JSON.stringify(r.probabilities)}`
})
await check('telegram', async () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, '.secrets', 'telegram.json'), 'utf8'))
  const r = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/getMe`, { signal: AbortSignal.timeout(10000) })
  const d = await r.json(); return d.ok ? `@${d.result.username}` : 'bad'
})
console.log(JSON.stringify(results, null, 1))
if (results.some(r => !r.ok)) process.exitCode = 1
