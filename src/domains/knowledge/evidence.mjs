// knowledge/evidence.mjs — 证据校验门禁：excerpt 必须能在原文中找到
//   verified=1 表示证据可定位；无可用证据的 claim 标记 status='unverified'
import { nowIso } from '../../shared/db.mjs'

export function itemTexts (db, itemId) {
  const out = []
  const blocks = db.prepare('SELECT text FROM item_block WHERE item_id=? ORDER BY idx').all(itemId).map(r => r.text)
  if (blocks.length) out.push(blocks.join('\n'))
  const segs = db.prepare('SELECT text_raw FROM item_segment WHERE item_id=? ORDER BY idx').all(itemId).map(r => r.text_raw)
  if (segs.length) { out.push(segs.join('\n')); out.push(segs.join(' ')) }
  const row = db.prepare('SELECT description FROM item WHERE id=?').get(itemId)
  if (row?.description) out.push(row.description)
  return out
}

export function itemText (db, itemId) {
  const t = itemTexts(db, itemId)
  return t[0] || ''
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

export function reverifyEvidence (db, { limit = 0 } = {}) {
  const claims = db.prepare(`SELECT DISTINCT c.id, c.item_id FROM claim c
    JOIN claim_evidence e ON e.claim_id=c.id
    ${limit ? 'LIMIT ' + Number(limit) : ''}`).all()
  const upd = db.prepare('UPDATE claim_evidence SET verified=? WHERE rowid=(SELECT rowid FROM claim_evidence WHERE claim_id=? LIMIT 1)')
  let ok = 0, bad = 0
  for (const c of claims) {
    const texts = itemTexts(db, c.item_id).map(norm)
    const ev = db.prepare('SELECT rowid, excerpt FROM claim_evidence WHERE claim_id=? LIMIT 1').get(c.id)
    if (!ev) continue
    const excerpt = norm(ev.excerpt)
    const probe = excerpt.slice(0, Math.min(60, excerpt.length))
    const verified = probe && texts.some(t => t.includes(probe)) ? 1 : 0
    db.prepare('UPDATE claim_evidence SET verified=? WHERE rowid=?').run(verified, ev.rowid)
    verified ? ok++ : bad++
  }
  // 没有任何 verified 证据的 claim → unverified
  const unverified = db.prepare(`UPDATE claim SET status='unverified'
    WHERE is_meta=0 AND status IN ('active','ok')
    AND NOT EXISTS (SELECT 1 FROM claim_evidence e WHERE e.claim_id=claim.id AND e.verified=1)`).run()
  const total = db.prepare('SELECT COUNT(*) c FROM claim WHERE is_meta=0').get().c
  const unv = db.prepare("SELECT COUNT(*) c FROM claim WHERE status='unverified'").get().c
  return { checked: claims.length, verified: ok, mismatch: bad, unverified_claims: unv, total_claims: total, unverified_rate: total ? Math.round(unv / total * 1000) / 1000 : 0, at: nowIso() }
}
