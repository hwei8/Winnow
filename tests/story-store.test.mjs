import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshDb } from '../src/shared/db.mjs'
import { sectionId, upsertStory, repairSectionIds } from '../src/domains/story/store.mjs'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'winnow-story-'))
test.after(() => rmSync(tmpDir, { recursive: true, force: true }))

test('sectionId has exactly one format', () => {
  assert.equal(sectionId('story:pipe:abc', 1), 'story:pipe:abc:sec1')
})

test('upsertStory keeps columns it was not given and never resurrects duplicates', () => {
  const db = freshDb(path.join(tmpDir, 'upsert.db'))
  db.prepare("INSERT INTO story(id,title,status,merged_into,title_original,story_kind) VALUES ('s1','旧标题','duplicate','s0','Original','story')").run()
  upsertStory(db, { id: 's1', title: '新标题', status: 'active', body_md: '正文' })
  const row = db.prepare("SELECT * FROM story WHERE id='s1'").get()
  assert.equal(row.title, '新标题')
  assert.equal(row.body_md, '正文')
  assert.equal(row.status, 'duplicate', 'duplicate status must survive regeneration')
  assert.equal(row.merged_into, 's0')
  assert.equal(row.title_original, 'Original')

  upsertStory(db, { id: 's2', title: '新的', status: 'active' })
  assert.equal(db.prepare("SELECT status FROM story WHERE id='s2'").get().status, 'active')
  assert.throws(() => upsertStory(db, { id: 's3', title: 'x', bogus: 1 }), /unknown column/)
  db.close()
})

test('repairSectionIds fixes bare secN ids and is idempotent', () => {
  const db = freshDb(path.join(tmpDir, 'repair.db'))
  const sid = 'story:x'
  db.prepare("INSERT INTO story(id,title) VALUES (?, 't')").run(sid)
  db.prepare('INSERT INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)').run(sectionId(sid, 1), sid, 0, 'h', 'b', 0, 10)
  const insSf = db.prepare('INSERT INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
  insSf.run(sid, 'F00001', 'sec1', 0, 5, 'asserts', 0) // 历史坏数据
  insSf.run(sid, 'F00002', sectionId(sid, 1), 5, 9, 'asserts', 1) // 已经正确
  insSf.run(sid, 'F00003', 'sec9', 0, 1, 'asserts', 2) // 找不到对应章节：不动

  assert.equal(repairSectionIds(db), 1)
  assert.equal(repairSectionIds(db), 0)
  const ids = db.prepare('SELECT fact_id, section_id FROM story_fact ORDER BY fact_id').all().map(r => r.section_id)
  assert.deepEqual(ids, [sectionId(sid, 1), sectionId(sid, 1), 'sec9'])
  db.close()
})
