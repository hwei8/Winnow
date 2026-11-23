// web/write.mjs — Web 端写入层（capture / knowledge_state），与只读查询层分离
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { DB_PATH } from '../shared/config.mjs'

let db = null
function conn () {
  if (!db) {
    db = new DatabaseSync(DB_PATH, { readOnly: false })
    db.exec('PRAGMA busy_timeout = 4000')
    db.exec('PRAGMA journal_mode = WAL')
  }
  return db
}
const now = () => new Date().toISOString()

export function createCapture ({ kind = 'idea', content, intent = null, reviewAt = null, targetType = null, targetId = null }) {
  if (!content || !String(content).trim()) throw new Error('content required')
  const c = conn()
  const id = 'cap:' + randomUUID().slice(0, 10)
  c.prepare(`INSERT INTO capture(id,kind,content,intent,review_at,target_type,target_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, kind, String(content).trim(), intent, reviewAt, targetType, targetId, 'inbox', now(), now())
  if (targetType && targetId) c.prepare('INSERT OR IGNORE INTO capture_link(capture_id,target_type,target_id,relation) VALUES (?,?,?,?)').run(id, targetType, targetId, 'about')
  return c.prepare('SELECT * FROM capture WHERE id=?').get(id)
}

export function setKnowledgeState ({ scope = 'story', refId, level = 'seen', frontierAt = null }) {
  if (!refId) throw new Error('refId required')
  const c = conn()
  const at = frontierAt || now()
  c.prepare(`INSERT INTO knowledge_state(scope, ref_id, level, frontier_at, updated_at, source) VALUES (?,?,?,?,?,?)
    ON CONFLICT(scope, ref_id) DO UPDATE SET level=excluded.level,
      frontier_at=COALESCE(excluded.frontier_at, knowledge_state.frontier_at),
      updated_at=excluded.updated_at, source=excluded.source`)
    .run(scope, refId, level, at, now(), 'user')
  return c.prepare('SELECT * FROM knowledge_state WHERE scope=? AND ref_id=?').get(scope, refId)
}

import { applyAnnotation } from '../domains/memory/annotation.mjs'
import { getOrCreateResearch } from '../domains/memory/depth.mjs'
import { enqueue } from '../domains/ingest/queue.mjs'

export function addAnnotation ({ targetType, targetId, kind, comment = null }) {
  if (!targetType || !targetId || !kind) throw new Error('targetType/targetId/kind required')
  return applyAnnotation(conn(), { targetType, targetId, kind, comment })
}

export async function createResearch ({ storyId, force = false, kind = 'deep' }) {
  if (!storyId) throw new Error('storyId required')
  return await getOrCreateResearch(conn(), storyId, { force, kind })
}

export function toggleInterest ({ topic, weight = 1 }) {
  if (!topic) throw new Error('topic required')
  const c = conn()
  const existing = c.prepare('SELECT * FROM interest WHERE topic=?').get(topic)
  if (existing) {
    c.prepare('DELETE FROM interest WHERE topic=?').run(topic)
    return { topic, interested: false }
  }
  c.prepare('INSERT OR REPLACE INTO interest(topic,weight,created_at) VALUES (?,?,?)').run(topic, weight, now())
  return { topic, interested: true }
}

export function enqueueIngest (url) {
  return enqueue(conn(), url, 'beat')
}

export async function runBeat () {
  const { beatReport } = await import('../domains/insights/beat.mjs')
  return await beatReport(conn())
}

export function listCaptures ({ status = null, limit = 20 } = {}) {
  const c = conn()
  const where = status ? 'WHERE status=?' : ''
  return c.prepare(`SELECT * FROM capture ${where} ORDER BY created_at DESC LIMIT ?`).all(...(status ? [status, limit] : [limit]))
}
