// ops/source-quality.mjs — 源质量评分：证据验证率 / 争议率 / 被纠错率
import { nowIso } from '../../shared/db.mjs'

export function recomputeSourceQuality (db, { top = 30 } = {}) {
  const rows = db.prepare(`
    SELECT i.source_id,
      COUNT(DISTINCT i.id) items,
      COUNT(DISTINCT c.id) claims,
      COUNT(DISTINCT CASE WHEN c.status='contested' THEN c.id END) contested,
      COUNT(DISTINCT CASE WHEN e.verified=1 THEN e.claim_id END) verified
    FROM item i
    LEFT JOIN claim c ON c.item_id=i.id AND c.is_meta=0
    LEFT JOIN claim_evidence e ON e.claim_id=c.id
    GROUP BY i.source_id ORDER BY items DESC`).all()
  const wrongHits = db.prepare(`SELECT i.source_id, COUNT(DISTINCT a.id) n FROM annotation a
    JOIN claim c ON c.id=a.target_id JOIN item i ON i.id=c.item_id
    WHERE a.kind='wrong' GROUP BY i.source_id`).all()
  const wrongMap = new Map(wrongHits.map(r => [r.source_id, r.n]))
  const ins = db.prepare(`INSERT OR REPLACE INTO source_quality(source_id,items,claims,contested,verified_rate,wrong_hits,score,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
  for (const r of rows) {
    const claims = r.claims || 0
    const verifiedRate = claims ? (r.verified || 0) / claims : 0
    const wrong = wrongMap.get(r.source_id) || 0
    // 分数：证据验证 60% + 争议 -30% + 被纠错 -10%
    const score = Math.round((verifiedRate * 60 - (claims ? (r.contested / claims) * 30 : 0) - (claims ? (wrong / claims) * 40 : 0)) * 10) / 10
    ins.run(r.source_id, r.items || 0, claims, r.contested || 0, Math.round(verifiedRate * 1000) / 1000, wrong, score, nowIso())
  }
  return db.prepare(`SELECT sq.*, s.name FROM source_quality sq LEFT JOIN source s ON s.id=sq.source_id
    ORDER BY sq.score DESC LIMIT ?`).all(top)
}

export function listSourceQuality (db, { limit = 30 } = {}) {
  return db.prepare(`SELECT sq.*, s.name FROM source_quality sq LEFT JOIN source s ON s.id=sq.source_id
    ORDER BY sq.score DESC LIMIT ?`).all(limit)
}
