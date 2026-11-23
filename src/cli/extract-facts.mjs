// cli/extract-facts.mjs — 为补抓的条目抽 claim，并归入既有 fact 或新建 fact
import { randomUUID } from 'node:crypto'
import { openDb, nowIso } from '../shared/db.mjs'
import { chat, extractJson } from '../providers/llm.mjs'
import { locate } from '../domains/ingest/feed.mjs'
import { runPool } from '../shared/pool.mjs'
import { assignClaimsToFacts } from '../domains/knowledge/facts.mjs'
import { LLM_CHAT_MODEL } from '../shared/config.mjs'

const db = openDb()
// 1) 抽取新 claim（有正文但无 claim 的条目）
const items = db.prepare(`SELECT DISTINCT i.id, i.title FROM story s JOIN story_item si ON si.story_id=s.id JOIN item i ON i.id=si.item_id
  WHERE (s.body_md IS NULL OR s.body_md='') AND NOT EXISTS (SELECT 1 FROM claim c WHERE c.item_id=i.id)`).all()
  .filter(it => db.prepare('SELECT COUNT(*) c FROM item_block WHERE item_id=?').get(it.id).c > 0)
console.log('items to extract:', items.length)
const blocksOf = db.prepare('SELECT text FROM item_block WHERE item_id=? ORDER BY idx')
const insClaim = db.prepare(`INSERT OR REPLACE INTO claim(id,story_id,item_id,text,kind,subject,predicate,object_text,confidence,extractor,created_at,object_value_json,is_meta,status,asserted_at,source_tier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insEv = db.prepare(`INSERT OR REPLACE INTO claim_evidence(claim_id,item_id,stance,segment_from,segment_to,time_start,time_end,frame_id,excerpt,verified) VALUES (?,?,?,?,?,?,?,?,?,?)`)
const run = await runPool(items.map(it => async () => {
  const blocks = blocksOf.all(it.id).map(r => r.text)
  const full = blocks.join('\n')
  const r = await chat({ json: true, maxTokens: 10000, messages: [{ role: 'user', content: `从下面内容抽取最多 15 条原子事实，每条给逐字 quote（≥10 字），text 用简体中文。只输出 JSON：{"claims":[{"text":"...","quote":"...","confidence":0.8}]}\n\n${full.slice(0, 7000)}` }] })
  const p = extractJson(r.content)
  let n = 0
  for (const c of (p?.claims || [])) {
    const t = String(c.text || '').trim(), q = String(c.quote || '').trim()
    if (t.length < 8 || q.length < 8) continue
    const pos = locate(full, q)
    if (!pos) continue
    const cid = 'claim:' + it.id + ':' + randomUUID().slice(0, 8)
    insClaim.run(cid, null, it.id, t, 'fact', '', '', '', Number.isFinite(c.confidence) ? c.confidence : 0.5, `llm:${LLM_CHAT_MODEL}`, nowIso(), null, 0, 'active', null, 2)
    insEv.run(cid, it.id, 'supports', pos[0], pos[1], null, null, null, q.slice(0, 500), 1)
    n++
  }
  return n
}), { concurrency: 8, label: 'extract' })
const newClaims = db.prepare("SELECT COUNT(*) c FROM claim WHERE fact_id IS NULL AND COALESCE(status,'') != 'meta'").get().c
console.log('new claims:', newClaims)

// 2) 向量 + 归入事实：统一走 knowledge/facts（召回 + Jev 判定 + 同批去重 + 事务内编号）
const pendingIds = db.prepare("SELECT id FROM claim WHERE fact_id IS NULL AND COALESCE(status,'') != 'meta'").all().map(r => r.id)
console.log('claims to assign:', pendingIds.length)
const { assigned, created } = await assignClaimsToFacts(db, pendingIds)
console.log(JSON.stringify({ new_claims: newClaims, assigned_to_existing: assigned, created_new_facts: created, facts_total: db.prepare('SELECT COUNT(*) c FROM fact').get().c }, null, 1))
db.close()
