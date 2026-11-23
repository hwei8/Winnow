import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { freshDb } from '../src/shared/db.mjs'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'im-base-web-'))
const dbPath = path.join(tmpDir, 'web.db')
test.after(() => rmSync(tmpDir, { recursive: true, force: true }))

function run (code) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, IM_DB: dbPath, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 60000
  }).trim()
}

test('web query layer reads an empty database', () => {
  freshDb(dbPath)
  const out = run(`
    const q = await import('${process.cwd()}/src/web/queries.mjs');
    console.log(JSON.stringify({
      stats: q.getStats(),
      stream: q.getStream({ limit: 5 }).stories.length,
      topics: q.getTopics().length,
      claims: Object.keys(q.getClaimIssues()).length,
      search: q.search('nothing').results.length
    }));`)
  const data = JSON.parse(out)
  assert.equal(data.stream, 0)
  assert.equal(data.topics, 0)
  assert.equal(data.search, 0)
  assert.ok(data.stats && typeof data.stats.stories === 'number')
})
