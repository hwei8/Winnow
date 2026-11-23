// knowledge/facts.mjs — 把新 claim 归入既有 fact（embedding 召回 + Jev 判定），否则新建
//
// 不变量
//   * 同一次运行里新建的 fact 立刻加入候选集：同一篇文章里两条说同一件事的 claim 不会变成两个 fact。
//   * Jev 不可用时抛错，而不是把每条 claim 都当成新 fact（那会悄悄制造大量重复）。
//     未处理的 claim 保持 fact_id IS NULL，下次运行会重试。
//   * fact 编号在 BEGIN IMMEDIATE 事务里分配：并发写进程不会撞主键。
import { decide } from '../../providers/jev.mjs'
import { embedBatch } from '../../providers/embed.mjs'

export async function embedTexts (texts) { return embedBatch(texts) }

export const cos = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s }
export const toVec = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
const toBlob = (vec) => Buffer.from(new Float32Array(vec).buffer)

const RECALL_TH = 0.55 // 召回候选的最低余弦
const SAME_TH = 0.6 // Jev noul ≥ 此值视为同一事实
const NEAR_DUP_TH = 0.92 // 同批新建事实之间：余弦极高直接视为同一事实（无 Jev 判定）

/** 下一个 fact 编号（F00001 起，位数随增长自然扩展）。须在写事务内调用。 */
export function nextFactNumber (db) {
  const m = db.prepare("SELECT MAX(CAST(SUBSTR(id,2) AS INTEGER)) m FROM fact WHERE id GLOB 'F[0-9]*'").get().m
  return Number(m || 0) + 1
}

export async function assignClaimsToFacts (db, claimIds, { decideFn = decide, embedFn = embedBatch, batchSize = 12 } = {}) {
  if (!claimIds.length) return { assigned: 0, created: 0 }
  const claims = db.prepare(`SELECT id, text, embedding FROM claim WHERE fact_id IS NULL AND id IN (${claimIds.map(() => '?').join(',')})`).all(...claimIds)
  if (!claims.length) return { assigned: 0, created: 0 }

  // 1) 只给缺向量的 claim 算 embedding
  const missing = claims.filter(c => !c.embedding)
  if (missing.length) {
    const vecs = await embedFn(missing.map(c => c.text.slice(0, 600)))
    if (vecs.length !== missing.length) throw new Error(`embedding count mismatch: ${vecs.length} != ${missing.length}`)
    const upd = db.prepare('UPDATE claim SET embedding=? WHERE id=?')
    db.exec('BEGIN IMMEDIATE')
    try {
      missing.forEach((c, i) => { c.embedding = toBlob(vecs[i]); upd.run(c.embedding, c.id) })
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  for (const c of claims) c.vec = toVec(c.embedding)

  // 2) 候选事实：每个 fact 取一条有向量的 claim 作代表
  const factReps = db.prepare(`SELECT f.id, f.canonical_text, c.embedding FROM fact f
    JOIN fact_claim fc ON fc.fact_id=f.id JOIN claim c ON c.id=fc.claim_id
    WHERE c.embedding IS NOT NULL GROUP BY f.id`).all().map(r => ({ id: r.id, text: r.canonical_text, vec: toVec(r.embedding) }))

  const insF = db.prepare(`INSERT INTO fact(id,canonical_text,subject,predicate,object_text,temporal_kind,validity_mode,confidence,first_seen,last_updated,superseded_by,support_count,source_count,category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  // 独立源数：同一篇文章里的两条 claim 只能算一个源。support_count 是 claim 数，两者不能混用。
  const countSources = db.prepare(`SELECT COUNT(DISTINCT i.source_id) c FROM fact_claim fc
    JOIN claim c ON c.id = fc.claim_id JOIN item i ON i.id = c.item_id WHERE fc.fact_id = ?`)
  const setSources = db.prepare('UPDATE fact SET source_count = ? WHERE id = ?')
  const insFC = db.prepare('INSERT OR REPLACE INTO fact_claim(fact_id,claim_id,stance,observed_at) VALUES (?,?,?,?)')
  const updC = db.prepare('UPDATE claim SET fact_id=? WHERE id=?')
  const bump = db.prepare('UPDATE fact SET support_count = support_count + 1, last_updated = ? WHERE id=?')
  let assigned = 0, created = 0

  for (let i = 0; i < claims.length; i += batchSize) {
    const batch = claims.slice(i, i + batchSize)
    const cands = batch.map(c => ({
      c,
      top: factReps.map(f => ({ f, cos: cos(c.vec, f.vec) })).sort((a, b) => b.cos - a.cos).slice(0, 3).filter(x => x.cos >= RECALL_TH)
    }))
    const state = { pairs: [] }
    const questions = {}
    cands.forEach(({ c, top }, k) => top.forEach((t, j) => {
      const idx = state.pairs.length
      state.pairs.push({ n: idx, claim: c.text.slice(0, 170), fact: t.f.text.slice(0, 170) })
      questions[`q${k}_${j}`] = { type: 'noul', instructions: `Pair ${idx}: the claim and the fact state the same core fact.`, criteria: { true: 'Same subject, attribute and value; wording may differ.', false: 'Different fact or materially different information.' } }
    }))
    // 不吞错：Jev 挂了就停，剩余 claim 留待下次（fact_id 仍为 NULL）
    const answers = state.pairs.length ? ((await decideFn({ state, questions, timeoutMs: 90000 })).answers || {}) : {}

    const now = new Date().toISOString()
    const createdHere = []
    db.exec('BEGIN IMMEDIATE')
    try {
      let nextNum = nextFactNumber(db)
      cands.forEach(({ c, top }, k) => {
        let best = null
        top.forEach((t, j) => { const p = answers[`q${k}_${j}`]?.noul ?? 0; if (p >= SAME_TH && (!best || p > best.p)) best = { id: t.f.id, p } })
        if (!best) {
          // 同批刚建的事实不在 Jev 题目里：余弦极高则直接并入
          const twin = createdHere.map(f => ({ f, s: cos(c.vec, f.vec) })).sort((a, b) => b.s - a.s)[0]
          if (twin && twin.s >= NEAR_DUP_TH) best = { id: twin.f.id }
        }
        if (best) {
          insFC.run(best.id, c.id, 'supports', now); updC.run(best.id, c.id); bump.run(now, best.id); assigned++
        } else {
          const fid = 'F' + String(nextNum++).padStart(5, '0')
          insF.run(fid, c.text, null, null, null, null, null, 0.8, now, now, null, 1, 1, null)
          insFC.run(fid, c.id, 'supports', now); updC.run(fid, c.id); created++
          createdHere.push({ id: fid, text: c.text, vec: c.vec })
        }
      })
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    // 本批触碰过的事实重算独立源数（新建时为 1，并入后可能变成 2+）
    const touched = new Set(createdHere.map(f => f.id))
    cands.forEach(({ c }) => { const fid = db.prepare('SELECT fact_id FROM claim WHERE id=?').get(c.id)?.fact_id; if (fid) touched.add(fid) })
    for (const fid of touched) setSources.run(countSources.get(fid).c, fid)
    factReps.push(...createdHere) // 后续批次也能召回本次新建的事实
  }
  return { assigned, created }
}
