// knowledge/link.mjs — 新内容 → 已有 Story 的链接与缺口分析（供未来入库流水线调用）
//
// 用法：
//   const r = await linkIncoming({ title, body, factIds, excludeStoryId })
//   r = { parent, same_event, gap: [{id,text}], overlap, action: 'duplicate'|'update'|'new' }
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT } from '../../shared/db.mjs'
import { decide } from '../../providers/jev.mjs'
import { embedBatch } from '../../providers/embed.mjs'
import { outPath, outFile } from '../../shared/config.mjs'

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

export async function linkIncoming ({ title, body, factIds = [], excludeStoryId = null, candTh = 0.55 }) {
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
      // 缺口：输入事实中，父 Story 没有覆盖的
      const gap = []
      const bests = []
      for (const f of inFacts) {
        let best = 0
        const v = inVecById.get(f.id)
        for (const pf of parentFacts) {
          const pv = getVec(pf.id)
          if (!pv) continue
          const s = cos(v, pv)
          if (s > best) best = s
        }
        bests.push(best)
        if (best < 0.85) gap.push({ id: f.id, text: f.canonical_text.slice(0, 120), best: +best.toFixed(2) })
      }
      // 事实亲和度：平均值 + 高相似度占比（用于纠正正文 embedding 的偶发低分）
      const factAffinity = bests.length ? bests.reduce((a, b) => a + b, 0) / bests.length : 0
      const affinityRatio = bests.length ? bests.filter(b => b >= 0.75).length / bests.length : 0
      const state = { a: { title, body: (body || '').slice(0, 1500) }, b: { title: c.title, body: (db.prepare('SELECT body_md FROM story WHERE id=?').get(c.id)?.body_md || '').slice(0, 1500) } }
      let same = c.cos
      try {
        const r = await decide({ state, questions: { q: { type: 'noul', instructions: 'Story A and Story B report the same specific event/topic.', criteria: { true: 'Same subject and same specific event/topic.', false: 'Different events or unrelated topics.' } } } })
        same = r.answers.q?.noul ?? c.cos
      } catch {}
      // 事实亲和度足够高时，视作同一事件（正文 embedding 对短文会失真）
      let sameFinal = same
      if ((factAffinity >= 0.72 || affinityRatio >= 0.4) && c.cos >= 0.50) sameFinal = Math.max(same, 0.8)
      results.push({ id: c.id, title: c.title, cos: +c.cos.toFixed(3), same_event: +sameFinal.toFixed(2), fact_affinity: +factAffinity.toFixed(3), affinity_ratio: +affinityRatio.toFixed(2), gap, facts: parentFacts.length })
    }
    if (!results.length) return { parent: null, action: 'new', reason: 'no-candidate-after-judge', top: cands.slice(0, 3) }
    results.sort((a, b) => b.same_event - a.same_event || b.cos - a.cos)
    // 主 Story 优先：在同一事件概率≥0.65 的候选里，并入事实最多的 Story（避免并入小碎片）
    const topScore = results[0].same_event
    const near = results.filter(r => r.same_event >= Math.max(0.65, topScore - 0.15))
    let best = near.length ? near.sort((a, b) => b.facts - a.facts || b.same_event - a.same_event)[0] : results[0]
    // 规范化：并入被合并的主 Story；小碎片跟随链接找到更大的主 Story
    let guard = 0
    while (best && guard++ < 5) {
      const row = db.prepare('SELECT merged_into FROM story WHERE id=?').get(best.id)
      if (row?.merged_into) { const m = results.find(x => x.id === row.merged_into); if (m) { best = m; continue } }
      if (best.facts >= 20) break
      const linked = db.prepare(`SELECT CASE WHEN story_id=? THEN related_story_id ELSE story_id END AS other
        FROM story_link WHERE (story_id=? OR related_story_id=?) AND relation IN ('duplicate','update','overlap','related')`).all(best.id, best.id, best.id)
      let bigger = null
      for (const l of linked) {
        if (l.other === best.id) continue
        const cnt = db.prepare('SELECT COUNT(*) c FROM story_fact WHERE story_id=?').get(l.other).c
        if (cnt > (bigger?.facts || best.facts * 2)) bigger = { id: l.other, facts: cnt }
      }
      if (!bigger) break
      const alt = results.find(x => x.id === bigger.id)
      if (alt) best = alt
      else {
        const t = db.prepare('SELECT title FROM story WHERE id=?').get(bigger.id)
        if (!t) break
        best = { ...best, id: bigger.id, title: t.title, facts: bigger.facts }
      }
    }
    let action = 'new'
    if (best.same_event >= 0.7 && best.gap.length === 0) action = 'duplicate'
    else if (best.same_event >= 0.7 && best.gap.length > 0) action = 'update'
    return { parent: best, alternatives: results.slice(1, 3), action }
  } finally {
    db.close()
  }
}

export function recordLink (db, { storyId, parentId, action, sameEvent, gapIds }) {
  db.prepare('INSERT OR REPLACE INTO story_link(story_id,related_story_id,relation,same_event_prob,overlap,gap_count,gap_facts_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(storyId, parentId, action, sameEvent, 0, gapIds.length, JSON.stringify(gapIds), new Date().toISOString())
}
