import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshDb } from '../src/shared/db.mjs'
import { assignClaimsToFacts, nextFactNumber } from '../src/domains/knowledge/facts.mjs'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'winnow-facts-'))
test.after(() => rmSync(tmpDir, { recursive: true, force: true }))

// 确定性的假 embedding：同一文本同一向量；不同"主题词"正交
const unit = (i, dims = 8) => Array.from({ length: dims }, (_, k) => (k === i ? 1 : 0))
const fakeEmbed = async (texts) => texts.map(t => unit(t.includes('芯片') ? 0 : t.includes('选举') ? 1 : 2))

function setup (name) {
  const db = freshDb(path.join(tmpDir, name + '.db'))
  db.prepare("INSERT INTO source(id,adapter_id,name) VALUES ('src:t','t','t')").run()
  db.prepare("INSERT INTO item(id,source_id,url,title) VALUES ('item:1','src:t','https://e.test/1','t')").run()
  const addClaim = (id, text) => db.prepare("INSERT INTO claim(id,item_id,text,status) VALUES (?,?,?, 'active')").run(id, 'item:1', text)
  return { db, addClaim }
}

test('claims stating the same fact in one batch become one fact', async () => {
  const { db, addClaim } = setup('dedupe')
  addClaim('c1', 'A 公司发布新芯片')
  addClaim('c2', 'A 公司发布了新款芯片')
  addClaim('c3', '选举结果公布')
  const decideFn = async () => { throw new Error('should not be called: no existing facts') }
  const r = await assignClaimsToFacts(db, ['c1', 'c2', 'c3'], { embedFn: fakeEmbed, decideFn })
  assert.deepEqual(r, { assigned: 1, created: 2 })
  const rows = db.prepare('SELECT id, fact_id FROM claim ORDER BY id').all()
  assert.equal(rows[0].fact_id, rows[1].fact_id, 'near-identical claims must share a fact')
  assert.notEqual(rows[0].fact_id, rows[2].fact_id)
  assert.equal(db.prepare("SELECT support_count FROM fact WHERE id=?").get(rows[0].fact_id).support_count, 2)
  db.close()
})

test('facts created in an earlier batch are recalled by later batches', async () => {
  const { db, addClaim } = setup('cross-batch')
  addClaim('c1', 'A 公司发布新芯片')
  addClaim('c2', 'A 公司发布了新款芯片')
  let asked = 0
  const decideFn = async ({ questions }) => { asked++; return { answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0.95 }])) } }
  const r = await assignClaimsToFacts(db, ['c1', 'c2'], { embedFn: fakeEmbed, decideFn, batchSize: 1 })
  assert.deepEqual(r, { assigned: 1, created: 1 })
  assert.equal(asked, 1, 'second batch should ask Jev about the fact created by the first batch')
  db.close()
})

test('a Jev outage fails loudly instead of minting duplicate facts', async () => {
  const { db, addClaim } = setup('outage')
  addClaim('c0', 'A 公司发布新芯片')
  await assignClaimsToFacts(db, ['c0'], { embedFn: fakeEmbed, decideFn: async () => ({ answers: {} }) })
  const before = db.prepare('SELECT COUNT(*) n FROM fact').get().n
  addClaim('c1', 'A 公司发布了新款芯片')
  await assert.rejects(assignClaimsToFacts(db, ['c1'], { embedFn: fakeEmbed, decideFn: async () => { throw new Error('Jev down') } }), /Jev down/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fact').get().n, before, 'no fact may be created when Jev is down')
  assert.equal(db.prepare("SELECT fact_id FROM claim WHERE id='c1'").get().fact_id, null, 'claim stays pending for retry')
  db.close()
})

test('fact ids are allocated sequentially from the current maximum', () => {
  const { db } = setup('ids')
  assert.equal(nextFactNumber(db), 1)
  db.prepare("INSERT INTO fact(id,canonical_text,support_count) VALUES ('F00041','x',1)").run()
  db.prepare("INSERT INTO fact(id,canonical_text,support_count) VALUES ('F100000','y',1)").run()
  assert.equal(nextFactNumber(db), 100001)
  db.close()
})
