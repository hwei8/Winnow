// 测试：LaTeX 宏定义块识别与历史数据标记
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLatexNoise } from '../src/domains/ingest/tex.mjs'
import { markNoiseBlocks } from '../src/domains/ingest/store.mjs'
import { freshDb } from '../src/shared/db.mjs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const MACROS = [
  String.raw`\newcommand{\pdiv}[3][]{\operatorname{D}_{#1}\left(#2\:\vert\vert\:#3 \right)}`,
  String.raw`%\DeclareMathOperator* is used for defining operators that have limits typeset beneath them`,
  String.raw`\DeclarePairedDelimiters{\ceil}{\lceil}{\rceil} % requires mathtools package`,
  String.raw`\DeclareMathOperator*{\argmin}{arg\,min}`,
  String.raw`\def\foo#1{#1}`
]

const PROSE = [
  '英伟达第三季度营收 570 亿美元，同比增长 62%，数据中心业务贡献 512 亿美元。',
  'The paper studies reasoning as pathfinding: the model must choose an objective before it can plan.',
  String.raw`LaTeX 的 \LaTeX 命令本身不算噪声，正文里偶尔出现数学符号如 $x^2 + y^2 = 1$ 也正常。`
]

test('宏定义块被判为噪声', () => {
  for (const t of MACROS) assert.equal(isLatexNoise(t), true, t.slice(0, 40))
})

test('正常正文不被误判', () => {
  for (const t of PROSE) assert.equal(isLatexNoise(t), false, t.slice(0, 40))
})

test('空值与无反斜杠文本直接放行', () => {
  assert.equal(isLatexNoise(''), false)
  assert.equal(isLatexNoise(null), false)
  assert.equal(isLatexNoise('纯粹的短句，没有数学。'), false)
})

test('markNoiseBlocks 打标后 blockText 不再包含宏定义', async () => {
  const p = path.join(tmpdir(), `winnow-tex-${randomUUID()}.db`)
  const db = freshDb(p)
  db.prepare('INSERT INTO source(id,adapter_id,name,tier,lang) VALUES (?,?,?,?,?)').run('src:test', 'test', '测试源', 2, 'zh')
  db.prepare('INSERT INTO item(id,source_id,url,title,char_count) VALUES (?,?,?,?,?)').run('it1', 'src:test', 'https://e.com/a', 't', 0)
  const ins = db.prepare('INSERT INTO item_block(item_id,idx,text,char_start,char_end,kind) VALUES (?,?,?,?,?,?)')
  let off = 0
  const blocks = [MACROS[0], PROSE[0]]
  blocks.forEach((b, i) => { ins.run('it1', i, b, off, off + b.length, 'paragraph'); off += b.length + 1 })

  assert.equal(markNoiseBlocks(db), 1)
  const kinds = db.prepare('SELECT idx,kind FROM item_block ORDER BY idx').all().map((r) => r.kind)
  assert.deepEqual(kinds, ['noise', 'paragraph'])
  assert.equal(db.prepare('SELECT char_count FROM item WHERE id=?').get('it1').char_count, PROSE[0].length)
  // 幂等
  assert.equal(markNoiseBlocks(db), 0)
  db.close()
})
