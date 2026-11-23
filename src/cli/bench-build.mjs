// bench-build.mjs — 造标注集：从线上库采「入站条目 × 已有 Story」候选对
//
// 目的：后面所有链接阈值都从这份标注集算出来，而不是在 3–10 个样本上调参。
// 采样刻意贴近线上分布——每条的候选是"正文余弦 top-1"，再补一条中段候选（负例来源）。
//
// 用法
//   node src/cli/bench-build.mjs --task=link --n=250 --seed=7
//   node src/cli/bench-build.mjs --task=link --n=250 --only-candidates=3   # 每条取 3 个候选
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT } from '../shared/db.mjs'
import { embedBatch } from '../providers/embed.mjs'
import { BENCH_DIR } from '../shared/config.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const s = a.replace(/^--/, '')
  const i = s.indexOf('=')
  return i < 0 ? [s, '1'] : [s.slice(0, i), s.slice(i + 1)]
}))

const TASK = args.task || 'link'
const N = Number(args.n || 250)
const SEED = Number(args.seed || 7)
const PER_ITEM = Number(args['only-candidates'] || 2)
const OUT = args.out || path.join(BENCH_DIR, `${TASK}.v1.jsonl`)

// 可复现的伪随机（mulberry32）：同一 seed 给出同一份样本，重跑不会换题
function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(SEED)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

function loadStoryVectors () {
  const p = path.join(ROOT, 'out', 'story-vectors.json')
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}

async function itemText (db, itemId) {
  const blocks = db.prepare('SELECT text FROM item_block WHERE item_id=? ORDER BY idx').all(itemId)
  return blocks.map((b) => b.text).join('\n\n')
}

async function buildLink (db) {
  const stories = db.prepare(`
    SELECT s.id, s.title, s.body_md, s.first_seen_ts FROM story s
    WHERE s.body_md IS NOT NULL AND s.body_md != '' AND (s.status IS NULL OR s.status != 'duplicate')
  `).all()
  const cache = loadStoryVectors()
  const haveVec = stories.filter((s) => Array.isArray(cache[s.id]))
  console.log(`stories ${stories.length} | 有缓存向量 ${haveVec.length}`)

  const items = db.prepare(`
    SELECT i.id, i.title, i.published_ts, COUNT(c.id) claims
    FROM item i JOIN claim c ON c.item_id = i.id
    GROUP BY i.id HAVING claims >= 4
  `).all()
  const sample = []
  const pool = [...items]
  while (sample.length < Math.min(N, pool.length)) sample.push(...pool.splice(Math.floor(rand() * pool.length), 1))

  const texts = []
  for (const it of sample) {
    const t = await itemText(db, it.id)
    // 正文太短（标题党 / 视频条目 / 只有摘要）判不了"是不是同一件事"，不进标注集
    if (t.length < 250) { it.skip = true; texts.push(`${it.title || ''}`); continue }
    texts.push(`${it.title || ''}\n${t.slice(0, 1800)}`)
    it.text = t
  }
  const vecs = await embedBatch(texts)

  const rows = []
  let seq = 0
  for (let i = 0; i < sample.length; i++) {
    const it = sample[i]
    if (it.skip) continue
    const v = vecs[i]
    const ranked = haveVec
      .map((s) => ({ s, c: cos(v, cache[s.id]) }))
      .sort((a, b) => b.c - a.c)
    const owns = new Set(db.prepare('SELECT story_id FROM story_item WHERE item_id=?').all(it.id).map((r) => r.story_id))
    // 候选取样：优先"不是自己 Story"的最高分候选（生产里真正要判的是这条），
    // 再补一条中段（rank 2–15）：cos 0.5–0.8 的候选才是阈值真正起作用的地方，
    // 随手抽 0.45 的配对只能测出"判得动无关文本"。
    const external = ranked.filter((x) => !owns.has(x.s.id))
    // 同实体但不同事件：这才是阈值真正会犯错的地方（同一家公司/同一个人，隔了几个月）
    const sharedEntityStories = new Set(db.prepare(`
      SELECT DISTINCT sf.story_id FROM claim_entity ce
      JOIN claim c ON c.id = ce.claim_id
      JOIN story_fact sf ON sf.fact_id = c.fact_id
      WHERE ce.entity_id IN (SELECT entity_id FROM claim_entity JOIN claim c2 ON c2.id = claim_id WHERE c2.item_id = ?)
    `).all(it.id).map((r) => r.story_id))
    const entityCand = external.find((x) => sharedEntityStories.has(x.s.id))
    // 分层取样，目标是"阈值真正起作用的地方"：
    //   A = 余弦最接近 0.65 的外部候选（判定边界，错并/漏并都发生在这里）
    //   B = 余弦最高的外部候选（生产里会被判成 update/duplicate 的那类）
    // 纯随机配对只能测出"判得动无关文本"，测不出阈值好坏。
    const band = [...external].sort((x, y) => Math.abs(x.c - 0.65) - Math.abs(y.c - 0.65))[0]
    const cands = []
    if (entityCand) cands.push(entityCand)
    if (band && (!entityCand || band.s.id !== entityCand.s.id)) cands.push(band)
    if (external[0] && (!band || external[0].s.id !== band.s.id)) cands.push(external[0])
    while (cands.length < PER_ITEM && external.length > cands.length) cands.push(external[cands.length])
    for (const cand of cands.slice(0, PER_ITEM)) {
      if (!cand) continue
      const s = cand.s
      const factsA = db.prepare('SELECT fact_id FROM claim WHERE item_id=? AND fact_id IS NOT NULL LIMIT 12').all(it.id).map((r) => r.fact_id)
      const factsB = db.prepare('SELECT fact_id FROM story_fact WHERE story_id=? LIMIT 12').all(s.id).map((r) => r.fact_id)
      rows.push({
        id: `link:${String(++seq).padStart(4, '0')}`,
        task: 'link',
        a: { id: it.id, title: it.title || '', text: it.text.slice(0, 2000), ts: it.published_ts || null },
        b: { id: s.id, title: s.title || '', text: s.body_md.slice(0, 2000), ts: s.first_seen_ts || null },
        features: {
          cos: +cand.c.toFixed(3),
          sharedEntity: sharedEntityStories.has(s.id),
          dtDays: it.published_ts && s.first_seen_ts ? +((it.published_ts - s.first_seen_ts) / 86400).toFixed(1) : null,
          selfItem: owns.has(s.id)
        },
        factsA,
        factsB,
        label: null,
        hard: false
      })
    }
  }
  return rows
}

async function buildProductionLinked (db, limit) {
  const edges = db.prepare(`
    SELECT d.item_id, d.parent_story_id, d.action FROM ingest_decision d
    WHERE d.parent_story_id IS NOT NULL AND d.action IN ('update','duplicate')
    GROUP BY d.item_id ORDER BY MAX(d.decided_at) DESC LIMIT ?
  `).all(limit)
  const out = []
  let seq = 0
  for (const e of edges) {
    const it = db.prepare('SELECT id, title, published_ts FROM item WHERE id=?').get(e.item_id)
    const st = db.prepare('SELECT id, title, body_md, first_seen_ts FROM story WHERE id=?').get(e.parent_story_id)
    if (!it || !st || !st.body_md || st.body_md.length < 300) continue
    // 自己 Story 的配对没有判定的意义（重跑入库时必然同事件），只会把正例率虚抬
    if (db.prepare('SELECT 1 FROM story_item WHERE item_id=? AND story_id=?').get(it.id, st.id)) continue
    const text = await itemText(db, it.id)
    if (text.length < 250) continue
    out.push({
      id: `linkp:${String(++seq).padStart(4, '0')}`,
      task: 'link',
      a: { id: it.id, title: it.title || '', text: text.slice(0, 2000), ts: it.published_ts || null },
      b: { id: st.id, title: st.title || '', text: st.body_md.slice(0, 2000), ts: st.first_seen_ts || null },
      features: { cos: null, sharedEntity: null, productionPositive: true, decision: e.action },
      factsA: db.prepare('SELECT fact_id FROM claim WHERE item_id=? AND fact_id IS NOT NULL LIMIT 12').all(it.id).map((r) => r.fact_id),
      factsB: db.prepare('SELECT fact_id FROM story_fact WHERE story_id=? LIMIT 12').all(st.id).map((r) => r.fact_id),
      label: null,
      hard: false
    })
  }
  return out
}

// 共享事实的配对：两条内容陈述了同一条 fact（同一 claim 归簇），是最可靠的正例来源，
// 且与"判定器怎么看"无关——盲标时用户仍可能判 diff（事实被泛化复述）。
async function buildFactOverlap (db, limit) {
  const rowsIn = db.prepare(`
    SELECT sf.story_id, c.item_id, COUNT(*) shared
    FROM story_fact sf
    JOIN claim c ON c.fact_id = sf.fact_id
    WHERE c.item_id IS NOT NULL
    GROUP BY sf.story_id, c.item_id HAVING shared >= 2
    ORDER BY shared DESC LIMIT ?
  `).all(limit)
  const out = []
  let seq = 0
  for (const r of rowsIn) {
    const st = db.prepare('SELECT id, title, body_md, first_seen_ts FROM story WHERE id=?').get(r.story_id)
    const it = db.prepare('SELECT id, title, published_ts FROM item WHERE id=?').get(r.item_id)
    if (!st || !it || !st.body_md) continue
    if (db.prepare('SELECT 1 FROM story_item WHERE item_id=? AND story_id=?').get(it.id, st.id)) continue
    const text = await itemText(db, it.id)
    if (!text) continue
    out.push({
      id: `linkf:${String(++seq).padStart(4, '0')}`,
      task: 'link',
      a: { id: it.id, title: it.title || '', text: text.slice(0, 2000), ts: it.published_ts || null },
      b: { id: st.id, title: st.title || '', text: st.body_md.slice(0, 2000), ts: st.first_seen_ts || null },
      features: { cos: null, sharedEntity: true, sharedFacts: r.shared },
      factsA: db.prepare('SELECT fact_id FROM claim WHERE item_id=? AND fact_id IS NOT NULL LIMIT 12').all(it.id).map((x) => x.fact_id),
      factsB: db.prepare('SELECT fact_id FROM story_fact WHERE story_id=? LIMIT 12').all(st.id).map((x) => x.fact_id),
      label: null,
      hard: false
    })
  }
  return out
}

const db = openDb()
let rows
if (TASK === 'link') rows = await buildLink(db)
else throw new Error(`unknown task: ${TASK}`)
if (TASK === 'link' && args['with-factoverlap']) {
  rows = rows.concat(await buildFactOverlap(db, Number(args['with-factoverlap'])))
}
if (TASK === 'link' && args['with-production']) {
  const extra = await buildProductionLinked(db, Number(args['with-production']))
  // 这些是"线上已经判成同一事件"的配对：名义上是正例来源，但仍然盲标（它也可能是错的）
  rows = rows.concat(extra)
}
db.close()

mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
const same = rows.filter((r) => r.label === 'same').length
console.log(JSON.stringify({ task: TASK, out: OUT, rows: rows.length, labelled: same, unlabelled: rows.length - same }, null, 1))
