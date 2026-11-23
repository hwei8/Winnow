import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshDb, openDb } from '../src/shared/db.mjs'
import { applySchema, SCHEMA_VERSION } from '../src/shared/schema.mjs'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'winnow-schema-'))
const dbPath = path.join(tmpDir, 'test.db')

test.after(() => rmSync(tmpDir, { recursive: true, force: true }))

test('fresh db has the full domain schema', () => {
  const db = freshDb(dbPath)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
  for (const required of ['item', 'story', 'claim', 'fact', 'entity', 'story_update', 'story_qa', 'capture', 'annotation', 'knowledge_state', 'briefing', 'ingest_queue', 'hot_entry']) {
    assert.ok(tables.includes(required), `missing table ${required}`)
  }
  assert.ok(tables.length >= 40, `expected >= 40 tables, got ${tables.length}`)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
  db.close()
})

test('applySchema is idempotent', () => {
  const db = openDb(dbPath)
  applySchema(db)
  applySchema(db)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  db.close()
})

test('core write path works on a fresh db', () => {
  const db = openDb(dbPath)
  db.prepare(`INSERT INTO source(id, adapter_id, name) VALUES (?,?,?)`).run('src:test', 'test', '测试源')
  db.prepare(`INSERT INTO item(id, source_id, url, title, published_ts, char_count)
              VALUES (?,?,?,?,?,?)`).run('item:test', 'src:test', 'https://e.test/a', '标题', 1, 2)
  const row = db.prepare('SELECT title FROM item WHERE id = ?').get('item:test')
  assert.equal(row.title, '标题')
  db.close()
})
