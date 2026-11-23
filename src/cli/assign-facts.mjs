// cli/assign-facts.mjs — 把未归簇的 claim 归入既有 fact（cosine top3 + Jev），否则新建
import { openDb, nowIso } from '../shared/db.mjs'
import { decide } from '../providers/jev.mjs'

const db = openDb()
const factReps = db.prepare(`SELECT f.id, f.canonical_text, c.embedding FROM fact f
  JOIN fact_claim fc ON fc.fact_id=f.id JOIN claim c ON c.id=fc.claim_id
  WHERE c.embedding IS NOT NULL GROUP BY f.id`).all()
  .map(r => ({ id: r.id, text: r.canonical_text, vec: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) }))
console.log('fact reps:', factReps.length)
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d }
const pending = db.prepare("SELECT id,text,embedding FROM claim WHERE fact_id IS NULL AND status!='meta' AND embedding IS NOT NULL").all()
console.log('claims to assign:', pending.length)
let nextNum = Number((db.prepare("SELECT MAX(CAST(SUBSTR(id,2) AS INTEGER)) m FROM fact").get().m || 5455)) + 1
const insF = db.prepare(`INSERT INTO fact(id,canonical_text,subject,predicate,object_text,temporal_kind,validity_mode,confidence,first_seen,last_updated,superseded_by,support_count,category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insFC = db.prepare('INSERT OR REPLACE INTO fact_claim(fact_id,claim_id,stance,observed_at) VALUES (?,?,?,?)')
const updC = db.prepare('UPDATE claim SET fact_id=? WHERE id=?')
let assigned = 0, created = 0, failed = 0
const B = 12
for (let i = 0; i < pending.length; i += B) {
  const batch = pending.slice(i, i + B)
  const cands = batch.map(c => {
    const v = new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4)
    const top = factReps.map(f => ({ f, cos: cos(v, f.vec) })).sort((a, b) => b.cos - a.cos).slice(0, 3).filter(x => x.cos >= 0.55)
    return { c, top }
  })
  const state = { pairs: [] }
  const questions = {}
  cands.forEach(({ c, top }, k) => {
    top.forEach((t, j) => {
      const idx = state.pairs.length
      state.pairs.push({ n: idx, claim: c.text.slice(0, 170), fact: t.f.text.slice(0, 170) })
      questions[`q${k}_${j}`] = {
        type: 'noul',
        instructions: `Pair ${idx}: the claim and the fact state the same core fact.`,
        criteria: { true: 'Same subject, attribute and value; wording may differ.', false: 'Different fact or materially different information (number/date/role/outcome).' }
      }
    })
  })
  let answers = {}
  if (state.pairs.length) { try { const r = await decide({ state, questions, timeoutMs: 90000 }); answers = r.answers || {} } catch { failed++ } }
  db.exec('BEGIN')
  try {
    for (const { c, top } of cands) {
      const k = cands.findIndex(x => x.c.id === c.id)
      let best = null
      top.forEach((t, j) => { const p = answers[`q${k}_${j}`]?.noul ?? 0; if (p >= 0.6 && (!best || p > best.p)) best = { id: t.f.id, p } })
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
console.log(JSON.stringify({ assigned_to_existing: assigned, created_new_facts: created, jev_failed_batches: failed, facts_total: db.prepare('SELECT COUNT(*) c FROM fact').get().c, claims_mapped: db.prepare("SELECT COUNT(*) c FROM claim WHERE fact_id IS NOT NULL").get().c }, null, 1))
db.close()
