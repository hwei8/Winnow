// cli/worker.mjs — 消费 ingest_queue：逐条跑 cli/ingest.mjs 抽取入库
//
// 并发安全：claimQueued 是单条 UPDATE … RETURNING，多个 worker 同时运行也不会领到同一条；
// 崩溃遗留的 running 任务在下次领取时自动回到队列。
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { openDb, ROOT } from '../shared/db.mjs'
import { claimQueued, finishQueued, parseReport } from '../domains/ingest/queue.mjs'

const HERE = import.meta.dirname
const MAX_BUFFER = 64 * 1024 * 1024

const db = openDb()
const rows = claimQueued(db, { limit: 10 })
if (!rows.length) { console.log('queue empty'); db.close(); process.exit(0) }
for (const r of rows) {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, 'ingest.mjs')], {
      cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: MAX_BUFFER,
      env: { ...process.env, URLS: r.url }, stdio: ['ignore', 'pipe', 'pipe']
    })
    // ingest 对抓取失败仍以 exit 0 结束：看机读报告，没有报告或全部失败都算 failed
    const report = parseReport(out)
    const ok = Array.isArray(report) && report.length > 0 && !report.every(x => x.error)
    finishQueued(db, r.id, { ok, result: { report: report ?? null, stdout: out.slice(-800) } })
    console.log(ok ? 'done:' : 'failed:', r.url)
  } catch (e) {
    finishQueued(db, r.id, { ok: false, result: { error: String(e.stderr || e.message).slice(-800) } })
    console.log('failed:', r.url, String(e.message).slice(0, 80))
  }
}
console.log(JSON.stringify({ processed: rows.length }))
db.close()
