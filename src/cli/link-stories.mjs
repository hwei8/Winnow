// cli/link-stories.mjs — Story 级语义链接（正文 embedding + 事实级缺口分析）
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT, nowIso } from '../shared/db.mjs'
import { decide } from '../providers/jev.mjs'

const db = openDb()
const DRY = process.env.DRY !== '0'
const CONC = Number(process.env.CONC || 6)
const KEY = readFileSync(path.join(ROOT, '.secrets', 'openrouter.key'), 'utf8').trim()
const CAND_TH = Number(process.env.CAND_TH || 0.62)
const covTh = 0.85, gapTh = 0.70

const stories = db.prepare("SELECT id,title,body_md,category FROM story WHERE body_md IS NOT NULL AND body_md != ''").all()
const cacheFile = path.join(ROOT, 'out', 'story-vectors.json')
let cache = {}
try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')) } catch {}
async function embed (texts) {
  const out = []
  for (let i = 0; i < texts.length; i += 32) {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'baai/bge-m3', input: texts.slice(i, i + 32) }) })
    const d = await res.json()
    if (!d.data) throw new Error(JSON.stringify(d).slice(0, 120))
    out.push(...d.data.map(x => x.embedding))
  }
  return out
}
const need = stories.filter(s => !cache[s.id])
if (need.length) {
  const vecs = await embed(need.map(s => s.body_md.slice(0, 2000)))
  need.forEach((s, i) => { cache[s.id] = vecs[i] })
  writeFileSync(cacheFile, JSON.stringify(cache))
}
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d }
const data = stories.map(s => ({ ...s, vec: new Float32Array(cache[s.id]), facts: db.prepare('SELECT DISTINCT f.id,f.canonical_text FROM story_fact sf JOIN fact f ON f.id=sf.fact_id WHERE sf.story_id=?').all(s.id) }))

// 候选对：top-5 近邻
const cands = []
for (let i = 0; i < data.length; i++) {
  const near = []
  for (let j = 0; j < data.length; j++) if (i !== j) near.push({ j, cos: cos(data[i].vec, data[j].vec) })
  near.sort((a, b) => b.cos - a.cos)
  for (const n of near.slice(0, 5)) if (n.cos >= CAND_TH && i < n.j) cands.push({ i, j: n.j, cos: +n.cos.toFixed(3) })
}
console.log('candidates:', cands.length)

// 事实向量（缓存）
const factVecCache = new Map()
async function factVecs (facts) {
  const missing = facts.filter(f => !factVecCache.has(f.id))
  if (missing.length) {
    const vs = await embed(missing.map(f => f.canonical_text))
    missing.forEach((f, k) => factVecCache.set(f.id, vs[k]))
  }
  return facts.map(f => factVecCache.get(f.id))
}
const insLink = db.prepare(`INSERT OR REPLACE INTO story_link(story_id,related_story_id,relation,same_event_prob,overlap,gap_count,gap_facts_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
const results = []
let idx = 0
async function worker () {
  while (idx < cands.length) {
    const c = cands[idx++]
    const A = data[c.i], B = data[c.j]
    const [av, bv] = await Promise.all([factVecs(A.facts), factVecs(B.facts)])
    // 缺口：B 的每个事实在 A 中的最大相似度
    const gaps = [], covered = []
    for (let bi = 0; bi < B.facts.length; bi++) {
      let best = 0
      for (let ai = 0; ai < A.facts.length; ai++) { const s = cos(bv[bi], av[ai]); if (s > best) best = s }
      if (best >= covTh) covered.push(B.facts[bi].id)
      else if (best < gapTh) gaps.push(B.facts[bi])
    }
    // 同一事件判定
    const state = { a: { title: A.title, body: A.body_md.slice(0, 2000) }, b: { title: B.title, body: B.body_md.slice(0, 2000) } }
    let same = 0.5
    try { const r = await decide({ state, questions: { q: { type: 'noul', instructions: 'Story A and Story B report the same specific event/topic.', criteria: { true: 'Same subject and same specific event/topic (different angles or update ok).', false: 'Different events or unrelated topics.' } } } }); same = r.answers.q?.noul ?? 0.5 } catch {}
    results.push({
      a: A.id, b: B.id, at: A.title.slice(0, 40), bt: B.title.slice(0, 40), cos: c.cos, same_event: +same.toFixed(2),
      gap: gaps.map(f => f.id), gap_titles: gaps.map(f => f.canonical_text.slice(0, 50)),
      overlap: A.facts.length ? +(covered.length / B.facts.length).toFixed(2) : 0,
      aFacts: A.facts.length, bFacts: B.facts.length, aChars: A.body_md.length, bChars: B.body_md.length
    })
  }
}
await Promise.all(Array.from({ length: CONC }, worker))
results.sort((x, y) => y.same_event - x.same_event || y.cos - x.cos || x.gap.length - y.gap.length)

// 包含度：B 的事实有多少比例能在 A 中找到（overlap 已按 B 计算）
const duplicates = results.filter(r => r.same_event >= 0.7 && (r.gap.length === 0 || r.overlap >= 0.8))
const updates = results.filter(r => r.same_event >= 0.7 && r.gap.length > 0 && r.gap.length <= 3 && r.overlap < 0.8)
const overlaps = results.filter(r => r.same_event >= 0.7 && r.gap.length > 3 && r.overlap < 0.8)
const related = results.filter(r => r.same_event >= 0.5 && r.same_event < 0.7)
const out = { dry_run: DRY, stories: data.length, candidates: cands.length, duplicates: duplicates.length, updates: updates.length, overlaps: overlaps.length, related: related.length, duplicate_examples: duplicates.slice(0, 15), update_examples: updates.slice(0, 10), overlap_examples: overlaps.slice(0, 6), related_examples: related.slice(0, 8) }
writeFileSync(path.join(ROOT, 'out', 'story-link.json'), JSON.stringify({ summary: out, results }, null, 1))

if (!DRY) {
  const upd = db.prepare('UPDATE story SET status=?, merged_into=?, story_kind=? WHERE id=?')
  const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
  const insUpdate = db.prepare('INSERT OR REPLACE INTO story_update(id,story_id,at,change_type,detail_json) VALUES (?,?,?,?,?)')
  const byId = new Map(data.map(x => [x.id, x]))
  for (const d of duplicates) {
    const A = byId.get(d.a), B = byId.get(d.b)
    const [keep, drop] = A.facts.length >= B.facts.length ? [A, B] : [B, A]
    upd.run('duplicate', keep.id, drop.story_kind || 'story', drop.id)
    // 缺口事实（B 有而 A 无）并入 A
    const keepFacts = new Set(keep.facts.map(f => f.id))
    for (const fid of drop.facts.map(f => f.id)) if (!keepFacts.has(fid)) insSf.run(keep.id, fid, null, 0, 0, 'absorbed', 0)
    insLink.run(drop.id, keep.id, 'duplicate', d.same_event, d.cos, 0, JSON.stringify(d.gap), nowIso())
    insUpdate.run(`upd:${drop.id}:${keep.id}`, keep.id, nowIso(), 'merged', JSON.stringify({ from_story: drop.id }))
  }
  for (const u of updates) {
    const A = byId.get(u.a), B = byId.get(u.b)
    for (const fid of u.gap) insSf.run(A.id, fid, null, 0, 0, 'update', 0)
    insLink.run(B.id, A.id, 'update', u.same_event, u.cos, u.gap.length, JSON.stringify(u.gap), nowIso())
    insUpdate.run(`upd:${B.id}:${A.id}`, A.id, nowIso(), 'new_facts', JSON.stringify({ from_story: B.id, facts: u.gap }))
  }
  for (const r of overlaps) insLink.run(r.a, r.b, 'overlap', r.same_event, r.cos, r.gap.length, JSON.stringify(r.gap), nowIso())
  for (const r of related) insLink.run(r.a, r.b, 'related', r.same_event, r.cos, r.gap.length, JSON.stringify(r.gap), nowIso())
  // 过短 → snippet
  const snippet = data.filter(s => s.facts.length < 3 || s.body_md.length < 200)
  for (const s of snippet) db.prepare("UPDATE story SET story_kind='snippet' WHERE id=? AND (status IS NULL OR status!='duplicate')").run(s.id)
  console.log('applied: duplicates', duplicates.length, '| updates', updates.length, '| overlaps', overlaps.length, '| related', related.length, '| snippets', snippet.length)
}
console.log(JSON.stringify(out, null, 1).slice(0, 4000))
db.close()
