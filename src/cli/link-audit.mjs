// cli/link-audit.mjs — 审计：Story 间事实重叠、过短 Story、可合并对
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT } from '../shared/db.mjs'

const db = openDb()
const stories = db.prepare(`SELECT id,title,body_md,item_count,category,status FROM story WHERE body_md IS NOT NULL AND body_md != ''`).all()
const factSets = new Map()
const factToStories = new Map()
for (const s of stories) {
  const fs = new Set(db.prepare('SELECT DISTINCT fact_id FROM story_fact WHERE story_id=?').all(s.id).map(r => r.fact_id))
  factSets.set(s.id, fs)
  for (const f of fs) { if (!factToStories.has(f)) factToStories.set(f, []); factToStories.get(f).push(s.id) }
}
// 过短判定
const snippet = stories.filter(s => (factSets.get(s.id).size < 3) || s.body_md.length < 200)
// 候选对：共享 ≥2 个事实
const pairs = []
const seen = new Set()
for (const [f, ids] of factToStories) {
  if (ids.length < 2 || ids.length > 40) continue
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const key = ids[i] < ids[j] ? ids[i] + '|' + ids[j] : ids[j] + '|' + ids[i]
    if (seen.has(key)) continue
    seen.add(key)
    const A = factSets.get(ids[i]), B = factSets.get(ids[j])
    let inter = 0; for (const x of A) if (B.has(x)) inter++
    if (inter < 2) continue
    const jac = inter / (A.size + B.size - inter)
    const containment = inter / Math.min(A.size, B.size)
    pairs.push({ a: ids[i], b: ids[j], inter, jac: +jac.toFixed(3), containment: +containment.toFixed(3) })
  }
}
pairs.sort((x, y) => y.containment - x.containment || y.inter - x.inter)
const dupes = pairs.filter(p => p.containment >= 0.8 && p.inter >= 3)
const related = pairs.filter(p => p.containment >= 0.4 && p.containment < 0.8)
const out = {
  stories: stories.length,
  snippet_stories: snippet.length,
  snippet_examples: snippet.slice(0, 8).map(s => ({ id: s.id, title: s.title.slice(0, 40), facts: factSets.get(s.id).size, chars: s.body_md.length })),
  duplicate_pairs: dupes.length,
  duplicate_examples: dupes.slice(0, 10).map(p => ({ a: p.a, at: stories.find(s => s.id === p.a)?.title.slice(0, 34), b: p.b, bt: stories.find(s => s.id === p.b)?.title.slice(0, 34), containment: p.containment, inter: p.inter })),
  related_pairs: related.length,
  max_pairs: pairs.length
}
writeFileSync(path.join(ROOT, 'out', 'story-link-audit.json'), JSON.stringify({ ...out, duplicate_pairs_detail: dupes, related_pairs_detail: related }, null, 1))
console.log(JSON.stringify(out, null, 1))
db.close()
