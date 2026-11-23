// web/write.mjs — Web 端写入层（capture / knowledge_state / 标注…），与只读查询层分离
//
// 输入来自浏览器：在这里做白名单与长度校验，非法值直接抛错（server 返回 400）。
import { randomUUID } from 'node:crypto'
import { openDb } from '../shared/db.mjs'

let db = null
function conn () {
  if (!db) db = openDb() // 与 CLI 写进程同一套 PRAGMA（WAL + busy_timeout）
  return db
}
export function closeWriteDb () {
  try { db?.close() } finally { db = null }
}
const now = () => new Date().toISOString()

const CAPTURE_KINDS = new Set(['idea', 'todo', 'decision', 'reference', 'life'])
const STATE_SCOPES = new Set(['story', 'entity', 'topic'])
const STATE_LEVELS = new Set(['seen', 'known', 'unknown'])
const TARGET_TYPES = new Set(['story', 'entity', 'claim', 'fact', 'topic', 'item'])
const MAX_TEXT = 20000
const MAX_ID = 200

function str (v, name, { max = MAX_ID, required = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw new Error(`${name} required`)
    return null
  }
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  if (v.length > max) throw new Error(`${name} too long`)
  return v
}
function oneOf (v, set, name, fallback) {
  if (v === null || v === undefined || v === '') return fallback
  if (!set.has(v)) throw new Error(`invalid ${name}: ${String(v).slice(0, 40)}`)
  return v
}
function isoOrNull (v, name) {
  const s = str(v, name, { max: 40 })
  if (s === null) return null
  if (Number.isNaN(Date.parse(s))) throw new Error(`${name} must be an ISO date`)
  return new Date(s).toISOString()
}

export function createCapture ({ kind = 'idea', content, intent = null, reviewAt = null, targetType = null, targetId = null } = {}) {
  content = str(content, 'content', { max: MAX_TEXT, required: true })
  if (!content.trim()) throw new Error('content required')
  kind = oneOf(kind, CAPTURE_KINDS, 'kind', 'idea')
  intent = str(intent, 'intent', { max: 2000 })
  reviewAt = isoOrNull(reviewAt, 'reviewAt')
  targetType = oneOf(targetType, TARGET_TYPES, 'targetType', null)
  targetId = str(targetId, 'targetId')
  const c = conn()
  const id = 'cap:' + randomUUID().slice(0, 10)
  c.prepare(`INSERT INTO capture(id,kind,content,intent,review_at,target_type,target_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, kind, String(content).trim(), intent, reviewAt, targetType, targetId, 'inbox', now(), now())
  if (targetType && targetId) c.prepare('INSERT OR IGNORE INTO capture_link(capture_id,target_type,target_id,relation) VALUES (?,?,?,?)').run(id, targetType, targetId, 'about')
  return c.prepare('SELECT * FROM capture WHERE id=?').get(id)
}

export function setKnowledgeState ({ scope = 'story', refId, level = 'seen', frontierAt = null } = {}) {
  refId = str(refId, 'refId', { required: true })
  scope = oneOf(scope, STATE_SCOPES, 'scope', 'story')
  level = oneOf(level, STATE_LEVELS, 'level', 'seen')
  frontierAt = isoOrNull(frontierAt, 'frontierAt')
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

export function addAnnotation ({ targetType, targetId, kind, comment = null } = {}) {
  targetType = oneOf(str(targetType, 'targetType', { required: true }), TARGET_TYPES, 'targetType')
  targetId = str(targetId, 'targetId', { required: true })
  kind = str(kind, 'kind', { required: true, max: 20 }) // 合法值由 applyAnnotation 校验
  comment = str(comment, 'comment', { max: 4000 })
  return applyAnnotation(conn(), { targetType, targetId, kind, comment })
}

export async function createResearch ({ storyId, force = false, kind = 'deep' } = {}) {
  storyId = str(storyId, 'storyId', { required: true })
  return await getOrCreateResearch(conn(), storyId, { force, kind })
}

export function toggleInterest ({ topic, weight = 1 } = {}) {
  topic = str(topic, 'topic', { required: true })
  weight = Number.isFinite(weight) ? Math.min(10, Math.max(0, weight)) : 1
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
