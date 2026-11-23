import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshDb, openDb } from '../src/shared/db.mjs'
import { enqueue, tryEnqueue, claimQueued, finishQueued, requeueStale, parseReport } from '../src/domains/ingest/queue.mjs'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'winnow-queue-'))
test.after(() => rmSync(tmpDir, { recursive: true, force: true }))

test('enqueue rejects internal and non-http urls', () => {
  const db = freshDb(path.join(tmpDir, 'q1.db'))
  for (const u of ['http://127.0.0.1/', 'http://localhost:3083/api', 'file:///etc/passwd', 'javascript:1', 'http://10.0.0.1/']) {
    assert.throws(() => enqueue(db, u), undefined, u)
  }
  assert.equal(tryEnqueue(db, 'http://192.168.1.1/'), null)
  const r = enqueue(db, 'https://example.com/a')
  assert.equal(r.status, 'queued')
  assert.equal(enqueue(db, 'https://example.com/a').reused, true)
  db.close()
})

test('claimQueued is atomic across connections and stale jobs are requeued', () => {
  const file = path.join(tmpDir, 'q2.db')
  const a = freshDb(file)
  for (let i = 0; i < 6; i++) enqueue(a, `https://example.com/${i}`)
  const b = openDb(file)
  const first = claimQueued(a, { limit: 4 })
  const second = claimQueued(b, { limit: 4 })
  assert.equal(first.length, 4)
  assert.equal(second.length, 2)
  const ids = new Set([...first, ...second].map(r => r.id))
  assert.equal(ids.size, 6, 'no job may be claimed twice')
  assert.equal(claimQueued(a).length, 0)

  finishQueued(a, first[0].id, { ok: true })
  // 模拟崩溃遗留：把一条 running 的 started_at 改成一小时前
  a.prepare("UPDATE ingest_queue SET started_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(first[1].id)
  assert.equal(requeueStale(a), 1)
  assert.deepEqual(claimQueued(b).map(r => r.id), [first[1].id])
  a.close(); b.close()
})

test('parseReport reads only the machine-readable marker line', () => {
  const out = 'URLs: 1\n[\n {"url":"x","gap_facts":["F1"]}\n]\nREPORT_JSON [{"url":"x","error":"too-short"}]\n'
  assert.deepEqual(parseReport(out), [{ url: 'x', error: 'too-short' }])
  assert.equal(parseReport('no marker'), null)
  assert.equal(parseReport('REPORT_JSON {broken'), null)
})
