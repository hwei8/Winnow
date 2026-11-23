// cli/extract-facts.mjs — 为补抓的条目抽 claim，并归入既有 fact 或新建 fact
import { randomUUID } from 'node:crypto'
import { openDb, nowIso } from '../shared/db.mjs'
import { chat, extractJson } from '../providers/llm.mjs'
import { locate } from '../domains/ingest/feed.mjs'
import { runPool } from '../shared/pool.mjs'
import { decide } from '../providers/jev.mjs'

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
    insClaim.run(cid, null, it.id, t, 'fact', '', '', '', Number.isFinite(c.confidence) ? c.confidence : 0.5, 'llm:deepseek-v4.1-flash', nowIso(), null, 0, 'active', null, 2)
    insEv.run(cid, it.id, 'supports', pos[0], pos[1], null, null, null, q.slice(0, 500), 1)
    n++
  }
  return n
}), { concurrency: 8, label: 'extract' })
const newClaims = db.prepare("SELECT COUNT(*) c FROM claim WHERE fact_id IS NULL AND status!='meta'").get().c
console.log('new claims:', newClaims)

// 2) embedding（bge-m3）
const KEY = (await import('node:fs')).readFileSync(new URL('./.secrets/openrouter.key', import.meta.url), 'utf8').trim()
const todo = db.prepare("SELECT id,text FROM claim WHERE embedding IS NULL AND status!='meta'").all()
console.log('claims to embed:', todo.length)
for (let i = 0; i < todo.length; i += 32) {
  const batch = todo.slice(i, i + 32)
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'baai/bge-m3', input: batch.map(c => c.text.slice(0, 600)) }) })
  const d = await res.json()
  if (!d.data) throw new Error(JSON.stringify(d).slice(0, 120))
  db.exec('BEGIN')
  try { d.data.forEach((x, k) => db.prepare('UPDATE claim SET embedding=? WHERE id=?').run(Buffer.from(new Float32Array(x.embedding).buffer), batch[k].id)); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK') }
}

// 3) 归入事实：cosine top3 + Jev 判定；不匹配则新建 fact
const factReps = db.prepare(`SELECT f.id, f.support_count, c.embedding FROM fact f JOIN fact_claim fc ON fc.fact_id=f.id JOIN claim c ON c.id=fc.claim_id WHERE c.embedding IS NOT NULL GROUP BY f.id`).all()
  .map(r => ({ id: r.id, vec: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) }))
console.log('fact reps:', factReps.length)
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d }
const pending = db.prepare("SELECT id,text,embedding FROM claim WHERE fact_id IS NULL AND status!='meta' AND embedding IS NOT NULL").all()
let nextNum = Number((db.prepare("SELECT MAX(CAST(SUBSTR(id,2) AS INTEGER)) m FROM fact").get().m || 5455)) + 1
const insF = db.prepare(`INSERT INTO fact(id,canonical_text,subject,predicate,object_text,temporal_kind,validity_mode,confidence,first_seen,last_updated,superseded_by,support_count,category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insFC = db.prepare('INSERT OR REPLACE INTO fact_claim(fact_id,claim_id,stance,observed_at) VALUES (?,?,?,?)')
const updC = db.prepare('UPDATE claim SET fact_id=? WHERE id=?')
let assigned = 0, created = 0
for (let i = 0; i < pending.length; i += 20) {
  const batch = pending.slice(i, i + 20)
  const cands = batch.map(c => {
    const v = new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4)
    return { c, top: factReps.map(f => ({ id: f.id, cos: cos(v, f.vec) })).sort((a, b) => b.cos - a.cos).slice(0, 3).filter(x => x.cos >= 0.55) }
  })
  const questions = {}
  const pairs = []
  cands.forEach(({ c, top }, k) => top.forEach((t, j) => { pairs.push({ c, factId: t.id, k, j }); questions[`q${k}_${j}`] = { type: 'noul', instructions: `Claim: "${c.text.slice(0, 160)}" states the same core fact as fact ${t.id}.`, criteria: { true: 'Same subject, attribute and value; wording may differ.', false: 'Different fact or materially different information.' } } }))
  let answers = {}
  if (pairs.length) { try { const r = await decide({ state: {}, questions }); answers = r.answers || {} } catch {} }
  db.exec('BEGIN')
  try {
    for (const { c, top, k } of cands) {
      let best = null
      top.forEach((t, j) => { const p = answers[`q${k}_${j}`]?.noul ?? 0; if (p >= 0.6 && (!best || p > best.p)) best = { id: t.id, p } })
      if (best) {
        insFC.run(best.id, c.id, 'supports', nowIso()); updC.run(best.id, c.id)
        db.prepare('UPDATE fact SET support_count = support_count + 1 WHERE id=?').run(best.id)
        assigned++
      } else {
        const fid = 'F' + String(nextNum++).padStart(5, '0')
        insF.run(fid, c.text, null, null, null, null, null, 0.8, nowIso(), nowIso(), null, 1, null)
        insFC.run(fid, c.id, 'supports', nowIso()); updC.run(fid, c.id)
        created++
      }
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); console.error(e.message.slice(0, 60)) }
}
console.log(JSON.stringify({ new_claims: newClaims, assigned_to_existing: assigned, created_new_facts: created, facts_total: db.prepare('SELECT COUNT(*) c FROM fact').get().c }, null, 1))
db.close()
