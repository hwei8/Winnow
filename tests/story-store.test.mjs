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
  insSf.run(sid, 'F00001', 'sec1', 0, 5, 'asserts', 0) // 历史坏数据：裸 secN
  insSf.run(sid, 'F00002', sectionId(sid, 1), 5, 9, 'asserts', 1) // 已经正确

  assert.equal(repairSectionIds(db), 1)
  assert.equal(repairSectionIds(db), 0)
  const ids = db.prepare('SELECT fact_id, section_id FROM story_fact ORDER BY fact_id').all().map(r => r.section_id)
  assert.deepEqual(ids, [sectionId(sid, 1), sectionId(sid, 1)])
  db.close()
})

test('repairSectionIds recovers anchors whose section_id is NULL or dangling', () => {
  const db = freshDb(path.join(tmpDir, 'orphans.db'))
  const sid = 'story:o'
  db.prepare("INSERT INTO story(id,title) VALUES (?, 't')").run(sid)
  const insSec = db.prepare('INSERT INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
  insSec.run(sectionId(sid, 1), sid, 1, '一', 'aaaa', 0, 40)
  insSec.run(sectionId(sid, 2), sid, 2, '二', 'bbbb', 40, 100)
  const insSf = db.prepare('INSERT INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
  insSf.run(sid, 'F1', null, 50, 60, 'asserts', 0)                 // NULL + 落在第二节
  insSf.run(sid, 'F2', 'story:gone:sec9', 5, 9, 'asserts', 1)       // 指向不存在的章节 + 落在第一节
  insSf.run(sid, 'F3', null, 500, 520, 'asserts', 2)                // 没有任何章节覆盖：保持原样

  assert.equal(repairSectionIds(db), 2)
  const rows = db.prepare('SELECT fact_id, section_id FROM story_fact ORDER BY fact_id').all()
  assert.deepEqual(rows.map(r => r.section_id), [sectionId(sid, 2), sectionId(sid, 1), null])
  assert.equal(repairSectionIds(db), 0)
  db.close()
})

test('repairSectionIds leaves pending update anchors alone', () => {
  const db = freshDb(path.join(tmpDir, 'pending.db'))
  const sid = 'story:p'
  db.prepare("INSERT INTO story(id,title) VALUES (?, 't')").run(sid)
  db.prepare('INSERT INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
    .run(sectionId(sid, 1), sid, 1, '一', 'aaaa', 0, 40)
  const insSf = db.prepare('INSERT INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
  insSf.run(sid, 'F1', null, 0, 0, 'update', 0)   // 待定追加：不是丢了归属，不能被钉到第 1 节
  insSf.run(sid, 'F2', null, 10, 20, 'asserts', 1) // 真孤儿：该归位
  assert.equal(repairSectionIds(db), 1)
  const rows = db.prepare('SELECT fact_id, section_id FROM story_fact ORDER BY fact_id').all()
  assert.deepEqual(rows.map(r => r.section_id), [null, sectionId(sid, 1)])
  db.close()
})
