// cli/worker.mjs — 消费 ingest_queue：逐条跑 83 抽取入库（单实例）
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { openDb } from '../shared/db.mjs'
import { claimQueued, finishQueued } from '../domains/ingest/queue.mjs'

const HERE = import.meta.dirname
const db = openDb()
const rows = claimQueued(db, { limit: 10 })
if (!rows.length) { console.log('queue empty'); process.exit(0) }
for (const r of rows) {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, '..', 'domains', 'ingest', 'pipeline.mjs')], {
      cwd: HERE, encoding: 'utf8', timeout: 10 * 60 * 1000,
      env: { ...process.env, URLS: r.url }, stdio: ['ignore', 'pipe', 'pipe']
    })
    // 83 对抓取失败仍以 exit 0 结束：解析报告，全部失败才标记 failed
    let allFailed = false
    try {
      const i = out.lastIndexOf('[')
      const report = i >= 0 ? JSON.parse(out.slice(i)) : []
      allFailed = report.length > 0 && report.every(x => x.error)
    } catch {}
    finishQueued(db, r.id, { ok: !allFailed, result: { stdout: out.slice(-800) } })
    console.log('done:', r.url)
  } catch (e) {
    finishQueued(db, r.id, { ok: false, result: { error: String(e.stderr || e.message).slice(-800) } })
    console.log('failed:', r.url, String(e.message).slice(0, 80))
  }
}
console.log(JSON.stringify({ processed: rows.length }))
db.close()
