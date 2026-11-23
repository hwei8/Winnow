// memory/state.mjs — 知识状态（known 水位/看过）+ capture
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../shared/db.mjs'

export function getState (db, scope, refId) {
  return db.prepare('SELECT scope, ref_id, level, frontier_at, updated_at, source FROM knowledge_state WHERE scope=? AND ref_id=?').get(scope, refId) || null
}

export function setState (db, { scope, refId, level, frontierAt, source = 'user' }) {
  const at = frontierAt || nowIso()
  db.prepare(`INSERT INTO knowledge_state(scope, ref_id, level, frontier_at, updated_at, source)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(scope, ref_id) DO UPDATE SET level=excluded.level,
      frontier_at=COALESCE(excluded.frontier_at, knowledge_state.frontier_at),
      updated_at=excluded.updated_at, source=excluded.source`)
    .run(scope, refId, level, at, nowIso(), source)
  return getState(db, scope, refId)
}

// Story 自上次阅读以来的更新
export function pendingUpdates (db, storyId) {
  const st = getState(db, 'story', storyId)
  const frontier = st?.frontier_at || st?.updated_at || '1970-01-01T00:00:00.000Z'
  const rows = db.prepare(`SELECT id, at, change_type, detail_json, severity, action FROM story_update WHERE story_id=? AND at > ? ORDER BY at ASC`).all(storyId, frontier)
  return { frontier, count: rows.length, updates: rows.map(r => ({ id: r.id, at: r.at, type: r.change_type, severity: r.severity, action: r.action })) }
}

export function createCapture (db, { kind = 'idea', content, intent = null, reviewAt = null, targetType = null, targetId = null }) {
  if (!content || !String(content).trim()) throw new Error('content required')
  const id = 'cap:' + randomUUID().slice(0, 10)
  db.prepare(`INSERT INTO capture(id,kind,content,intent,review_at,target_type,target_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, kind, String(content).trim(), intent, reviewAt, targetType, targetId, 'inbox', nowIso(), nowIso())
  if (targetType && targetId) db.prepare('INSERT OR IGNORE INTO capture_link(capture_id,target_type,target_id,relation) VALUES (?,?,?,?)').run(id, targetType, targetId, 'about')
  return db.prepare('SELECT * FROM capture WHERE id=?').get(id)
}

export function listCaptures (db, { status = null, limit = 50 } = {}) {
  const where = status ? 'WHERE status=?' : ''
  return db.prepare(`SELECT * FROM capture ${where} ORDER BY created_at DESC LIMIT ?`).all(...(status ? [status, limit] : [limit]))
}

export function dueCaptures (db, { limit = 20 } = {}) {
  return db.prepare(`SELECT * FROM capture WHERE review_at IS NOT NULL AND review_at <= ? AND status != 'archived' ORDER BY review_at ASC LIMIT ?`).all(nowIso(), limit)
}
