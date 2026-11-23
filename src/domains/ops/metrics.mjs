// ops/metrics.mjs — 系统度量：追平率 / 信噪比 / 冗余率 / 覆盖 / 简报选择率
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../shared/db.mjs'

export function computeMetrics (db) {
  const num = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c ?? 0)
  const active = num("SELECT COUNT(*) c FROM story WHERE (status IS NULL OR status!='duplicate') AND (story_kind IS NULL OR story_kind='story')")
  const withBody = num('SELECT COUNT(*) c FROM story WHERE body_md IS NOT NULL AND length(body_md)>0')
  const tracked = num(`SELECT COUNT(*) c FROM story s WHERE (s.status IS NULL OR s.status!='duplicate')
    AND EXISTS (SELECT 1 FROM knowledge_state ks WHERE ks.scope='story' AND ks.ref_id=s.id)`)
  const caughtUp = num(`SELECT COUNT(*) c FROM story s WHERE (s.status IS NULL OR s.status!='duplicate')
    AND EXISTS (SELECT 1 FROM knowledge_state ks WHERE ks.scope='story' AND ks.ref_id=s.id)
    AND s.id NOT IN (SELECT u2.story_id FROM story_update u2 WHERE u2.at > COALESCE((SELECT ks2.frontier_at FROM knowledge_state ks2 WHERE ks2.scope='story' AND ks2.ref_id=s.id),'1970-01-01T00:00:00.000Z'))`)
  const claims = num('SELECT COUNT(*) c FROM claim')
  const facts = num('SELECT COUNT(*) c FROM fact')
  const dupSlice = num('SELECT COUNT(*) c FROM claim_dup')
  const annTotal = num('SELECT COUNT(*) c FROM annotation')
  const annKnown = num("SELECT COUNT(*) c FROM annotation WHERE kind IN ('known','read')")
  const annWrong = num("SELECT COUNT(*) c FROM annotation WHERE kind='wrong'")
  const qa = db.prepare('SELECT COUNT(*) c, AVG(score) avg FROM story_qa').get()
  const brief = db.prepare('SELECT items_json FROM briefing ORDER BY generated_at DESC LIMIT 1').get()
  let briefPicked = 0, briefCandidates = 0
  if (brief) { try { const items = JSON.parse(brief.items_json || '[]'); briefPicked = items.length } catch {} }
  const pendingStories = num(`SELECT COUNT(DISTINCT u.story_id) c FROM story_update u
    WHERE u.at > COALESCE((SELECT ks.frontier_at FROM knowledge_state ks WHERE ks.scope='story' AND ks.ref_id=u.story_id),'1970-01-01T00:00:00.000Z')`)
  return {
    at: nowIso(),
    stories: { active, with_body: withBody, tracked, caught_up: caughtUp, catch_up_rate: tracked ? Math.min(1, Math.round(caughtUp / tracked * 100) / 100) : 0 },
    claims: { total: claims, facts, fact_redundancy: claims ? Math.round((1 - facts / claims) * 100) / 100 : 0, dup_flagged: dupSlice },
    qa: { stories: Number(qa.c), avg: Math.round((qa.avg || 0) * 10) / 10 },
    annotations: { total: annTotal, known: annKnown, wrong: annWrong, wrong_rate: annTotal ? Math.round(annWrong / annTotal * 100) / 100 : 0 },
    briefing: { latest_picked: briefPicked, pending_stories: pendingStories, selection_rate: pendingStories ? Math.round(briefPicked / pendingStories * 100) / 100 : 0 }
  }
}

export function saveMetrics (db) {
  const m = computeMetrics(db)
  const id = 'm:' + randomUUID().slice(0, 10)
  db.prepare('INSERT INTO metric_snapshot(id,at,metrics_json) VALUES (?,?,?)').run(id, m.at, JSON.stringify(m))
  return { id, ...m }
}

export function latestMetrics (db) {
  const row = db.prepare('SELECT * FROM metric_snapshot ORDER BY at DESC LIMIT 1').get()
  if (!row) return null
  try { return { id: row.id, ...JSON.parse(row.metrics_json || '{}') } } catch { return null }
}
