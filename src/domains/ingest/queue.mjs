// ingest/queue.mjs — 待入库队列（Beat 发现的文章一键入库）
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../shared/db.mjs'
import { checkUrlSyntax } from '../../shared/net.mjs'

// running 超过这么久视为崩溃遗留，重新排队
const STALE_MS = 30 * 60 * 1000

export function enqueue (db, url, source = 'beat') {
  url = checkUrlSyntax(url).toString() // 协议 / 凭据 / 字面量内网地址在入队时就拒绝；DNS 级检查在抓取时做
  const exists = db.prepare("SELECT id,status FROM ingest_queue WHERE url=? ORDER BY created_at DESC LIMIT 1").get(url)
  if (exists && exists.status !== 'failed') return { id: exists.id, url, status: exists.status, reused: true }
  const id = 'q:' + randomUUID().slice(0, 10)
  db.prepare('INSERT INTO ingest_queue(id,url,source,status,created_at) VALUES (?,?,?,?,?)').run(id, url, source, 'queued', nowIso())
  return { id, url, status: 'queued', reused: false }
}

/** 批量场景用：URL 被拒（非法 / 内网）时记一条警告并返回 null，不中断整批。 */
export function tryEnqueue (db, url, source = 'beat') {
  try { return enqueue(db, url, source) } catch (e) {
    console.error(`[queue] rejected ${String(url).slice(0, 120)}: ${e.message}`)
    return null
  }
}

export function listQueue (db, { status = null, limit = 20 } = {}) {
  const where = status ? 'WHERE status=?' : ''
  return db.prepare(`SELECT * FROM ingest_queue ${where} ORDER BY created_at DESC LIMIT ?`).all(...(status ? [status, limit] : [limit]))
}

/** 把崩溃遗留的 running 任务放回队列。 */
export function requeueStale (db, { staleMs = STALE_MS } = {}) {
  const cutoff = new Date(Date.now() - staleMs).toISOString()
  return db.prepare("UPDATE ingest_queue SET status='queued', started_at=NULL WHERE status='running' AND (started_at IS NULL OR started_at < ?)").run(cutoff).changes
}

/** 原子领取：单条 UPDATE … RETURNING，多个 worker 并发也不会领到同一条。 */
export function claimQueued (db, { limit = 5 } = {}) {
  requeueStale(db)
  return db.prepare(`UPDATE ingest_queue SET status='running', started_at=?
    WHERE status='queued' AND id IN (SELECT id FROM ingest_queue WHERE status='queued' ORDER BY created_at ASC LIMIT ?)
    RETURNING *`).all(nowIso(), limit)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

export function finishQueued (db, id, { ok, result = null }) {
  db.prepare("UPDATE ingest_queue SET status=?, finished_at=?, result=? WHERE id=?").run(ok ? 'done' : 'failed', nowIso(), result ? JSON.stringify(result).slice(0, 2000) : null, id)
}

/** 从 cli/ingest.mjs 输出里取 `REPORT_JSON <json>` 行。 */
export function parseReport (stdout) {
  const line = String(stdout).split('\n').reverse().find(l => l.startsWith('REPORT_JSON '))
  if (!line) return null
  try { return JSON.parse(line.slice('REPORT_JSON '.length)) } catch { return null }
}
