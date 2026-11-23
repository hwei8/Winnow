// memory/annotation.mjs — 标注闭环：known / wrong / agree / disagree / read
//   一次标注做四件事：推进水位、修正系统、形成立场、记录评估样本
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../shared/db.mjs'

const KINDS = new Set(['known', 'wrong', 'agree', 'disagree', 'read'])

export function applyAnnotation (db, { targetType, targetId, kind, comment = null }) {
  if (!KINDS.has(kind)) throw new Error(`unknown annotation kind: ${kind}`)
  if (!targetType || !targetId) throw new Error('targetType/targetId required')
  const at = nowIso()
  const id = 'ann:' + randomUUID().slice(0, 10)
  db.prepare('INSERT INTO annotation(id,target_type,target_id,kind,comment,at,meta_json) VALUES (?,?,?,?,?,?,?)')
    .run(id, targetType, targetId, kind, comment, at, null)
  const effects = []

  // 1) 推进水位（story/entity/topic）
  if (kind === 'known' || kind === 'read') {
    const scope = targetType === 'story' ? 'story' : targetType === 'entity' ? 'entity' : 'story'
    db.prepare(`INSERT INTO knowledge_state(scope,ref_id,level,frontier_at,updated_at,source) VALUES (?,?,?,?,?,?)
      ON CONFLICT(scope,ref_id) DO UPDATE SET level=excluded.level,
        frontier_at=COALESCE(excluded.frontier_at, knowledge_state.frontier_at),
        updated_at=excluded.updated_at, source=excluded.source`)
      .run(scope, targetId, kind === 'read' ? 'seen' : 'known', at, at, 'user')
    effects.push({ effect: 'knowledge_state', scope, ref_id: targetId, level: kind === 'read' ? 'seen' : 'known' })
  }

  // 2) 修正系统：claim 标错 → 降置信度、状态 contested
  if (kind === 'wrong' && targetType === 'claim') {
    const row = db.prepare('SELECT confidence FROM claim WHERE id=?').get(targetId)
    if (row) {
      const conf = Math.max(0, Number(row.confidence ?? 0.5) - 0.2)
      db.prepare("UPDATE claim SET confidence=?, status='contested' WHERE id=?").run(conf, targetId)
      effects.push({ effect: 'claim_contested', claim_id: targetId, confidence: conf })
    }
  }

  // 3) 形成立场：agree/disagree → 更新 stance
  if (kind === 'agree' || kind === 'disagree') {
    const st = upsertStance(db, { targetType, targetId, kind, comment, annotationId: id })
    effects.push({ effect: 'stance', stance_id: st.id, position: st.position })
  }
  return { id, kind, target_type: targetType, target_id: targetId, at, effects }
}

function upsertStance (db, { targetType, targetId, kind, comment, annotationId }) {
  const at = nowIso()
  const existing = db.prepare('SELECT * FROM stance WHERE target_type=? AND target_id=? ORDER BY updated_at DESC LIMIT 1').get(targetType, targetId)
  const position = kind === 'agree' ? '同意' : '不同意'
  if (existing) {
    db.prepare('UPDATE stance SET position=?, rationale=?, updated_at=? WHERE id=?').run(position, comment || existing.rationale, at, existing.id)
    db.prepare('INSERT INTO stance_revision(id,stance_id,position,rationale,source_annotation_id,at) VALUES (?,?,?,?,?,?)')
      .run('rev:' + randomUUID().slice(0, 10), existing.id, position, comment || existing.rationale, annotationId, at)
    return db.prepare('SELECT * FROM stance WHERE id=?').get(existing.id)
  }
  const id = 'stance:' + randomUUID().slice(0, 10)
  db.prepare('INSERT INTO stance(id,target_type,target_id,position,rationale,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, targetType, targetId, position, comment, at, at)
  db.prepare('INSERT INTO stance_revision(id,stance_id,position,rationale,source_annotation_id,at) VALUES (?,?,?,?,?,?)')
    .run('rev:' + randomUUID().slice(0, 10), id, position, comment, annotationId, at)
  return db.prepare('SELECT * FROM stance WHERE id=?').get(id)
}

export function getStance (db, targetType, targetId) {
  const st = db.prepare('SELECT * FROM stance WHERE target_type=? AND target_id=? ORDER BY updated_at DESC LIMIT 1').get(targetType, targetId)
  if (!st) return null
  const history = db.prepare('SELECT position, rationale, at FROM stance_revision WHERE stance_id=? ORDER BY at ASC').all(st.id)
  return { ...st, history }
}

export function listStances (db, { limit = 30 } = {}) {
  return db.prepare('SELECT * FROM stance ORDER BY updated_at DESC LIMIT ?').all(limit)
}

export function listAnnotations (db, { targetType = null, targetId = null, limit = 30 } = {}) {
  const where = [], args = []
  if (targetType) { where.push('target_type=?'); args.push(targetType) }
  if (targetId) { where.push('target_id=?'); args.push(targetId) }
  args.push(limit)
  return db.prepare(`SELECT * FROM annotation ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`).all(...args)
}
