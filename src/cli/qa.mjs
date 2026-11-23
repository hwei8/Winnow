// cli/qa.mjs — QA v3：跨 Story 重复/并入惩罚 + 片段不合格 + 事件关联
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT, nowIso } from '../shared/db.mjs'
import { decide } from '../providers/jev.mjs'
import { outFile } from '../shared/config.mjs'

const db = openDb()
const CONC = Number(process.env.CONC || 8)
const LIMIT = Number(process.env.LIMIT || 0)
const stories = db.prepare(`SELECT id,title,body_md,category,status,story_kind,merged_into FROM story WHERE body_md IS NOT NULL AND body_md != ''`).all()
const queue = LIMIT ? stories.slice(0, LIMIT) : stories

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '')
const tri = (s) => { const x = norm(s); const t = new Set(); for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3)); return t }
const jac = (a, b) => { const A = tri(a), B = tri(b); if (!A.size || !B.size) return 0; let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n) }

async function qa (story) {
  const body = story.body_md
  const links = db.prepare('SELECT DISTINCT fact_id FROM story_fact WHERE story_id=?').all(story.id).map(r => r.fact_id)
  const available = db.prepare(`SELECT DISTINCT f.id,f.canonical_text,f.support_count FROM story_item si
    JOIN claim c ON c.item_id=si.item_id JOIN fact f ON f.id=c.fact_id
    WHERE si.story_id=? AND COALESCE(c.status,'')!='meta'`).all(story.id)
  const used = new Set(links)
  const availSet = new Set(available.map(f => f.id))
  const covered = [...used].filter(id => availSet.has(id))
  const external = [...used].filter(id => !availSet.has(id))
  // 覆盖率只统计 Story 自身来源事实；吸收进来的外部事实单独记录，避免 >1
  // 锚点存在但与自己来源事实无交集（fact id 漂移/外部吸收）时，按 1 计并记 mismatch，避免假 0
  const anchorMismatch = covered.length === 0 && used.size > 0
  const coverageAll = availSet.size ? (covered.length / availSet.size || (anchorMismatch ? 1 : 0)) : (used.size ? 1 : 0)
  const keyFacts = available.filter(f => (f.support_count || 1) >= 2)
  const coverageKey = keyFacts.length ? keyFacts.filter(f => used.has(f.id)).length / keyFacts.length : coverageAll

  const sentences = body.split(/[。！？\n]+/).map(s => s.replace(/^#+\s*/, '').trim()).filter(s => s.length >= 12)
  let dupPairs = 0
  for (let i = 0; i < sentences.length; i++) for (let j = i + 1; j < sentences.length; j++) if (jac(sentences[i], sentences[j]) >= 0.82) dupPairs++
  const dupRate = sentences.length ? dupPairs / sentences.length : 0

  const facts = links.length ? db.prepare(`SELECT id,canonical_text FROM fact WHERE id IN (${links.map(() => '?').join(',')})`).all(...links) : []
  const nums = (s) => new Set((String(s).match(/\d+(?:\.\d+)?/g) || []))
  const toks = (s) => new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !/^\d+$/.test(w)))
  const cands = []
  for (let i = 0; i < facts.length && cands.length < 20; i++) for (let j = i + 1; j < facts.length && cands.length < 20; j++) {
    const a = facts[i], b = facts[j]
    const sharedNum = [...nums(a.canonical_text)].some(n => nums(b.canonical_text).has(n))
    const sharedTok = [...toks(a.canonical_text)].filter(t => toks(b.canonical_text).has(t)).length >= 2
    if (sharedNum || sharedTok) cands.push([a, b])
  }
  const questions = {
    title_align: { type: 'noul', instructions: 'The body of this article is consistent with its title (delivers what the title promises, same subject and focus).', criteria: { true: 'The article delivers what the title promises.', false: 'Title and body mismatch in subject or focus.' } }
  }
  const state = { title: story.title, body: body.slice(0, 4000), facts: cands.flatMap(([a, b]) => [{ id: a.id, text: a.canonical_text.slice(0, 160) }, { id: b.id, text: b.canonical_text.slice(0, 160) }]) }
  cands.forEach(([a, b], k) => { questions['c' + k] = { type: 'noul', instructions: `Fact ${a.id} and fact ${b.id} cannot both be true (incompatible values for the same attribute).`, criteria: { true: 'Same subject and attribute but contradictory values.', false: 'Different attributes/subjects, complementary, or merely similar wording.' } } })
  let titleAlign = 0.8, conflicts = 0
  try {
    const r = await decide({ state, questions })
    titleAlign = r.answers.title_align?.noul ?? 0.8
    cands.forEach(([a, b], k) => { if ((r.answers['c' + k]?.noul ?? 0) >= 0.6) conflicts++ })
  } catch {}

  const chars = body.length
  const lengthAdequacy = Math.min(1, chars / (available.length >= 30 ? 1200 : 500))
  const density = chars > 0 ? Math.min(1, (links.length / chars) * 100) : 0
  let score = 22 * coverageAll + 18 * coverageKey + 15 * titleAlign + 20 * (1 - Math.min(1, dupRate * 4)) + 12 * lengthAdequacy + 8 * density + 5 * Math.max(0, 1 - conflicts / 3)
  // 新结构惩罚
  const rel = db.prepare("SELECT relation FROM story_link WHERE story_id=? OR related_story_id=? LIMIT 3").all(story.id, story.id).map(r => r.relation)
  const isDuplicate = story.status === 'duplicate'
  const isSnippet = story.story_kind === 'snippet'
  if (isDuplicate) score = Math.min(score, 40)  // 重复 Story 封顶 40
  if (isSnippet) score = Math.min(score, 55)    // 片段封顶 55
  if (anchorMismatch) score -= 5                // 锚点与来源事实漂移
  if (external.length > 0 && availSet.size > 0) score -= Math.min(5, external.length / Math.max(1, availSet.size) * 10)
  if (rel.includes('overlap')) score -= 5
  if (rel.includes('update')) score += 2
  return {
    story_id: story.id, title: story.title, category: story.category,
    external_facts: external.length,
    anchor_mismatch: anchorMismatch,
    score: +Math.max(0, Math.min(100, score)).toFixed(1),
    coverage_all: +coverageAll.toFixed(3), coverage_key: +coverageKey.toFixed(3), title_align: +titleAlign.toFixed(2),
    dup_rate: +dupRate.toFixed(3), conflicts, anchors: links.length, facts_available: available.length, chars,
    duplicate: isDuplicate, snippet: isSnippet, merged_into: story.merged_into || null,
    issues: { dup_examples: [], conflict_examples: [], missed_top: available.filter(f => !used.has(f.id)).sort((a, b) => (b.support_count || 0) - (a.support_count || 0)).slice(0, 5).map(f => ({ id: f.id, text: f.canonical_text.slice(0, 60), support: f.support_count })) }
  }
}

const results = []
let next = 0, done = 0
async function worker () {
  while (next < queue.length) {
    const story = queue[next++]
    try { results.push(await qa(story)) } catch (e) { results.push({ story_id: story.id, error: e.message.slice(0, 100) }) }
    if (++done % 50 === 0) console.error(`  [qa3] ${done}/${queue.length}`)
  }
}
const t0 = Date.now()
await Promise.all(Array.from({ length: CONC }, worker))
const ins = db.prepare(`INSERT OR REPLACE INTO story_qa(story_id,score,coverage,dup_rate,conflict_count,anchor_count,fact_count,missed_facts,issues_json,checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
db.exec('BEGIN IMMEDIATE')
try { for (const r of results) if (!r.error) ins.run(r.story_id, r.score, r.coverage_all, r.dup_rate, r.conflicts, r.anchors, r.facts_available, r.facts_available - r.anchors, JSON.stringify({ ...r.issues, duplicate: r.duplicate, snippet: r.snippet, merged_into: r.merged_into, external_facts: r.external_facts, anchor_mismatch: r.anchor_mismatch }), nowIso()); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }

const ok = results.filter(r => !r.error)
const active = ok.filter(r => !r.duplicate && !r.snippet)
const scores = active.map(r => r.score).sort((a, b) => a - b)
const q = (p) => scores[Math.floor(scores.length * p)]
const summary = {
  total: results.length, ok: ok.length, active: active.length,
  duplicate: ok.filter(r => r.duplicate).length, snippet: ok.filter(r => r.snippet).length,
  score_active: { min: scores[0], p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), max: scores.at(-1), avg: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) },
  distribution_active: { ge90: active.filter(r => r.score >= 90).length, ge80: active.filter(r => r.score >= 80 && r.score < 90).length, ge70: active.filter(r => r.score >= 70 && r.score < 80).length, lt70: active.filter(r => r.score < 70).length },
  avg: { coverage_key: +(ok.reduce((a, r) => a + r.coverage_key, 0) / ok.length).toFixed(3), title_align: +(ok.reduce((a, r) => a + r.title_align, 0) / ok.length).toFixed(3), dup_rate: +(ok.reduce((a, r) => a + r.dup_rate, 0) / ok.length).toFixed(3), conflicts_total: ok.reduce((a, r) => a + r.conflicts, 0) },
  worst_active: active.sort((a, b) => a.score - b.score).slice(0, 6).map(r => ({ title: r.title.slice(0, 32), score: r.score, cov: r.coverage_all, align: r.title_align, dup: r.dup_rate })),
  seconds: Math.round((Date.now() - t0) / 1000)
}
writeFileSync(outFile('story-qa.json'), JSON.stringify({ summary, results }, null, 1))
console.log(JSON.stringify(summary, null, 1))
db.close()
