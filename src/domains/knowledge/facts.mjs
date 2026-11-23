// knowledge/facts.mjs — 把新 claim 归入既有 fact（embedding 召回 + Jev 判定），否则新建
import { decide } from '../../providers/jev.mjs'
import { embedBatch } from '../../providers/embed.mjs'

export async function embedTexts (texts) { return embedBatch(texts) }

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const toVec = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

export async function assignClaimsToFacts (db, claimIds) {
  if (!claimIds.length) return { assigned: 0, created: 0 }
  const claims = db.prepare(`SELECT id, text FROM claim WHERE fact_id IS NULL AND id IN (${claimIds.map(() => '?').join(',')})`).all(...claimIds)
  const vecs = await embedTexts(claims.map(c => c.text.slice(0, 600)))
  db.exec('BEGIN')
  try { claims.forEach((c, i) => db.prepare('UPDATE claim SET embedding=? WHERE id=?').run(Buffer.from(new Float32Array(vecs[i]).buffer), c.id)); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }

  const factReps = db.prepare(`SELECT f.id, f.canonical_text, c.embedding FROM fact f
    JOIN fact_claim fc ON fc.fact_id=f.id JOIN claim c ON c.id=fc.claim_id
    WHERE c.embedding IS NOT NULL GROUP BY f.id`).all().map(r => ({ id: r.id, text: r.canonical_text, vec: toVec(r.embedding) }))
  let nextNum = Number((db.prepare("SELECT MAX(CAST(SUBSTR(id,2) AS INTEGER)) m FROM fact").get().m || 5455)) + 1
  const insF = db.prepare(`INSERT INTO fact(id,canonical_text,subject,predicate,object_text,temporal_kind,validity_mode,confidence,first_seen,last_updated,superseded_by,support_count,category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insFC = db.prepare('INSERT OR REPLACE INTO fact_claim(fact_id,claim_id,stance,observed_at) VALUES (?,?,?,?)')
  const updC = db.prepare('UPDATE claim SET fact_id=? WHERE id=?')
  let assigned = 0, created = 0
  const B = 12
  for (let i = 0; i < claims.length; i += B) {
    const batch = claims.slice(i, i + B)
    const cands = batch.map((c, k) => {
      const v = new Float32Array(new Float32Array(vecs[i + k]).buffer, 0, 1024)
      const top = factReps.map(f => ({ f, cos: cos(v, f.vec) })).sort((a, b) => b.cos - a.cos).slice(0, 3).filter(x => x.cos >= 0.55)
      return { c, top }
    })
    const state = { pairs: [] }
    const questions = {}
    cands.forEach(({ c, top }, k) => top.forEach((t, j) => {
      const idx = state.pairs.length
      state.pairs.push({ n: idx, claim: c.text.slice(0, 170), fact: t.f.text.slice(0, 170) })
      questions[`q${k}_${j}`] = { type: 'noul', instructions: `Pair ${idx}: the claim and the fact state the same core fact.`, criteria: { true: 'Same subject, attribute and value; wording may differ.', false: 'Different fact or materially different information.' } }
    }))
    let answers = {}
    if (state.pairs.length) { try { const r = await decide({ state, questions, timeoutMs: 90000 }); answers = r.answers || {} } catch {} }
    cands.forEach(({ c, top }, k) => {
      let best = null
      top.forEach((t, j) => { const p = answers[`q${k}_${j}`]?.noul ?? 0; if (p >= 0.6 && (!best || p > best.p)) best = { id: t.f.id, p } })
      if (best) { insFC.run(best.id, c.id, 'supports', new Date().toISOString()); updC.run(best.id, c.id); db.prepare('UPDATE fact SET support_count = support_count + 1 WHERE id=?').run(best.id); assigned++ }
      else {
        const fid = 'F' + String(nextNum++).padStart(5, '0')
        insF.run(fid, c.text, null, null, null, null, null, 0.8, new Date().toISOString(), new Date().toISOString(), null, 1, null)
        insFC.run(fid, c.id, 'supports', new Date().toISOString()); updC.run(fid, c.id); created++
      }
    })
  }
  return { assigned, created }
}
