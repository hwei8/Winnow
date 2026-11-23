// knowledge/link.mjs — 新内容 → 已有 Story 的链接与缺口分析（供未来入库流水线调用）
//
// 用法：
//   const r = await linkIncoming({ title, body, factIds, excludeStoryId })
//   r = { parent, same_event, gap: [{id,text}], overlap, action: 'duplicate'|'update'|'new' }
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT } from '../../shared/db.mjs'
import { scorePair, applyAffinityOverride } from './score.mjs'
import { embedBatch } from '../../providers/embed.mjs'
import { outPath, outFile } from '../../shared/config.mjs'
import { th } from '../../shared/thresholds.mjs'

const VEC_CACHE_FILE = outPath('story-vectors.json') // 写时才建目录：导入模块不应有副作用
function loadVecCache () { try { return JSON.parse(readFileSync(VEC_CACHE_FILE, 'utf8')) } catch { return {} } }
function saveVecCache (c) {
  try { writeFileSync(outFile('story-vectors.json'), JSON.stringify(c)) } catch (e) { console.error('[link] vector cache write failed:', String(e.message).slice(0, 120)) }
}

const embed = embedBatch
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

// 缓存：story 正文向量 / fact 向量
const storyVecCache = new Map(Object.entries(loadVecCache()))
const factVecCache = new Map()

async function loadStoryVectors (db) {
  const rows = db.prepare("SELECT id, title, body_md FROM story WHERE body_md IS NOT NULL AND body_md != '' AND (status IS NULL OR status != 'duplicate')").all()
  const missing = rows.filter(r => !storyVecCache.has(r.id))
  if (missing.length) {
    const vecs = await embed(missing.map(r => r.body_md.slice(0, 2000)))
    missing.forEach((r, i) => storyVecCache.set(r.id, vecs[i]))
    const cache = loadVecCache()
    missing.forEach((r, i) => { cache[r.id] = vecs[i] })
    saveVecCache(cache)
  }
  return rows
}
async function loadFactVectors (db, factIds) {
  const missing = factIds.filter(id => !factVecCache.has(id))
  if (missing.length) {
    const rows = db.prepare(`SELECT id, canonical_text FROM fact WHERE id IN (${missing.map(() => '?').join(',')})`).all(...missing)
    const vecs = await embed(rows.map(r => r.canonical_text))
    rows.forEach((r, i) => factVecCache.set(r.id, vecs[i]))
  }
  return (id) => factVecCache.get(id)
}
async function factsOf (db, storyId) {
  return db.prepare('SELECT DISTINCT f.id, f.canonical_text FROM story_fact sf JOIN fact f ON f.id = sf.fact_id WHERE sf.story_id = ?').all(storyId)
}

export async function linkIncoming ({ title, body, factIds = [], excludeStoryId = null, candTh = th('link.candidate_cos_min', 0.55) }) {
  const db = openDb()
  try {
    const stories = await loadStoryVectors(db)
    const incomingText = `${title}\n${(body || '').slice(0, 1800)}`
    const [inVec] = await embed([incomingText])
    // 候选：正文相似度 top-5
    const cands = []
    for (const s of stories) {
      if (s.id === excludeStoryId) continue
      const c = cos(inVec, storyVecCache.get(s.id))
      cands.push({ id: s.id, title: s.title, cos: c })
    }
    cands.sort((a, b) => b.cos - a.cos)
    const top = cands.slice(0, 5).filter(c => c.cos >= candTh)
    if (!top.length) return { parent: null, action: 'new', reason: 'no-candidate', top: cands.slice(0, 3) }

    // 输入事实向量
    const inFactVecs = await embed((await (async () => {
      const rows = factIds.length ? db.prepare(`SELECT id, canonical_text FROM fact WHERE id IN (${factIds.map(() => '?').join(',')})`).all(...factIds) : []
      return rows
    })()).map(r => r.canonical_text))
    const inFacts = factIds.length ? db.prepare(`SELECT id, canonical_text FROM fact WHERE id IN (${factIds.map(() => '?').join(',')})`).all(...factIds) : []
    const inVecById = new Map(inFacts.map((f, i) => [f.id, inFactVecs[i]]))

    const results = []
    for (const c of top) {
      const parentFacts = await factsOf(db, c.id)
      const getVec = await loadFactVectors(db, parentFacts.map(f => f.id))
      // 打分原语在 knowledge/score.mjs：bench 量的就是这一段，不再有第二份实现。
      const sc = await scorePair({
        a: { title, body },
        b: { title: c.title, body: db.prepare('SELECT body_md FROM story WHERE id=?').get(c.id)?.body_md || '' },
        vecA: inVec,
        vecB: storyVecCache.get(c.id),
        factsA: inFacts.map(f => ({ id: f.id, vec: inVecById.get(f.id) })),
        factsB: parentFacts.map(f => ({ id: f.id, vec: getVec(f.id) }))
      })
      const sameFinal = applyAffinityOverride({ ...sc, cos: sc.cos })
      results.push({
        id: c.id,
        title: c.title,
        cos: sc.cos ?? 0,
        same_event: +(sameFinal ?? 0).toFixed(2),
        judged: sc.judged,
        fact_affinity: sc.fact_affinity,
        affinity_ratio: sc.affinity_ratio,
        gap: sc.gap.map(g => ({ ...g, text: (inFacts.find(f => f.id === g.id)?.canonical_text || '').slice(0, 120) })),
        facts: parentFacts.length
      })
    }
    if (!results.length) return { parent: null, action: 'new', reason: 'no-candidate-after-judge', top: cands.slice(0, 3) }
    results.sort((a, b) => b.same_event - a.same_event || b.cos - a.cos)
    // 主 Story 优先：在同一事件概率≥0.65 的候选里，并入事实最多的 Story（避免并入小碎片）
    const topScore = results[0].same_event
    const near = results.filter(r => r.same_event >= Math.max(0.65, topScore - 0.15))
    let best = near.length ? near.sort((a, b) => b.facts - a.facts || b.same_event - a.same_event)[0] : results[0]
    // 规范化：只做 merged_into 跳转，且必须跳到"本批真的判过"的候选上。
    // 以前这里还会顺着 story_link 跳到更大的 Story，跳完只替换 id/title/facts——
    // same_event 与 gap 仍是小 Story 的，后面的 duplicate/update 判定就落在错的那篇上。
    let guard = 0
    while (best && guard++ < 5) {
      const row = db.prepare('SELECT merged_into FROM story WHERE id=?').get(best.id)
      const m = row?.merged_into ? results.find(x => x.id === row.merged_into) : null
      if (!m) break
      best = m
    }
    if (!best) return { parent: null, action: 'new', reason: 'no-candidate-after-judge', top: results.slice(0, 3) }
    if (!best.judged) return { parent: null, action: 'deferred', reason: 'jev-unavailable', top: results.slice(0, 3) }
    let action = 'new'
    const sameMin = th('link.same_event_min', 0.7)
    if (best.same_event >= sameMin && best.gap.length === 0) action = 'duplicate'
    else if (best.same_event >= sameMin && best.gap.length > 0) action = 'update'
    return { parent: best, alternatives: results.slice(1, 3), action }
  } finally {
    db.close()
  }
}

export function recordLink (db, { storyId, parentId, action, sameEvent, gapIds }) {
  db.prepare('INSERT OR REPLACE INTO story_link(story_id,related_story_id,relation,same_event_prob,overlap,gap_count,gap_facts_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(storyId, parentId, action, sameEvent, 0, gapIds.length, JSON.stringify(gapIds), new Date().toISOString())
}
