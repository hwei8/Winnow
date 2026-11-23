// ingest/queue.mjs — 待入库队列（Beat 发现的文章一键入库）
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../shared/db.mjs'

export function enqueue (db, url, source = 'beat') {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('invalid url')
  const exists = db.prepare("SELECT id,status FROM ingest_queue WHERE url=? ORDER BY created_at DESC LIMIT 1").get(url)
  if (exists && exists.status !== 'failed') return { id: exists.id, url, status: exists.status, reused: true }
  const id = 'q:' + randomUUID().slice(0, 10)
  db.prepare('INSERT INTO ingest_queue(id,url,source,status,created_at) VALUES (?,?,?,?,?)').run(id, url, source, 'queued', nowIso())
  return { id, url, status: 'queued', reused: false }
}

export function listQueue (db, { status = null, limit = 20 } = {}) {
  const where = status ? 'WHERE status=?' : ''
  return db.prepare(`SELECT * FROM ingest_queue ${where} ORDER BY created_at DESC LIMIT ?`).all(...(status ? [status, limit] : [limit]))
}

export function claimQueued (db, { limit = 5 } = {}) {
  const rows = db.prepare("SELECT * FROM ingest_queue WHERE status='queued' ORDER BY created_at ASC LIMIT ?").all(limit)
  const upd = db.prepare("UPDATE ingest_queue SET status='running', started_at=? WHERE id=?")
  for (const r of rows) upd.run(nowIso(), r.id)
  return rows
}

export function finishQueued (db, id, { ok, result = null }) {
  db.prepare("UPDATE ingest_queue SET status=?, finished_at=?, result=? WHERE id=?").run(ok ? 'done' : 'failed', nowIso(), result ? JSON.stringify(result).slice(0, 2000) : null, id)
}
