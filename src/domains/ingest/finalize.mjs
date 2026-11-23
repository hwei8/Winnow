// ingest/finalize.mjs — 为流水线判定为 new 的条目建档并生成正文
import { openDb, nowIso } from '../../shared/db.mjs'
import { chat, extractJson } from '../../providers/llm.mjs'
import { decide } from '../../providers/jev.mjs'

const db = openDb()
const CATS = { tech: '科技', politics: '政治', entertainment: '娱乐', history: '历史', business: '商业', society: '社会', world: '国际', science: '科学' }
const items = db.prepare(`SELECT i.id,i.title,i.url,i.description FROM item i
  JOIN ingest_decision d ON d.item_id=i.id
  WHERE d.action='new'
    AND NOT EXISTS (SELECT 1 FROM story_item si WHERE si.item_id=i.id)`).all()
console.log('new items to finalize:', items.length)
for (const it of items) {
  // 证据门禁：优先使用 excerpt 可定位（verified=1）的 claim 支撑的事实
  const allFacts = db.prepare(`SELECT f.id, f.canonical_text,
      MAX(CASE WHEN e.verified=1 THEN 1 ELSE 0 END) AS verified
    FROM claim c JOIN fact f ON f.id=c.fact_id
    LEFT JOIN claim_evidence e ON e.claim_id=c.id
    WHERE c.item_id=? AND c.status!='meta'
    GROUP BY f.id`).all(it.id)
  const verifiedFacts = allFacts.filter(f => Number(f.verified) === 1)
  const facts = verifiedFacts.length >= 2 ? verifiedFacts : allFacts
  if (facts.length < 2) { console.log('skip too-few-facts', it.title.slice(0, 30)); continue }
  if (verifiedFacts.length < 2) console.log('warn: unverified facts only', it.title.slice(0, 30), verifiedFacts.length + '/' + allFacts.length)
  const fl = facts.map(f => `${f.id}: ${f.canonical_text}`).join('\n')
  let parsed = null
  for (let t = 1; t <= 3 && !parsed; t++) {
    try {
      const r = await chat({ json: true, maxTokens: 8000, messages: [{ role: 'user', content: `为「${it.title}」写一段简洁的中文摘要（4–6 句，一个段落，连贯叙述）。事实：\n${fl}\n\n每条事实最多用一次，不要重复；每句标注 facts 编号，禁止把编号写进正文；不要编造。只输出 JSON：{"segments":[{"text":"...","facts":["F00001"]}]}` }] })
      const p = extractJson(r.content)
      if (p && Array.isArray(p.segments) && p.segments.length) parsed = p.segments
    } catch {}
  }
  if (!parsed) { console.log('gen fail', it.title.slice(0, 30)); continue }
  const valid = new Set(facts.map(f => f.id))
  const segs = parsed.map(s => {
    let text = String(s.text || '')
    const leak = new Set((s.facts || []).filter(id => valid.has(id)))
    text = text.replace(/[（(]\s*(F\d{5}(?:\s*[、,，]\s*F\d{5})*)\s*[）)]/g, (m, ids) => { ids.split(/[、,，]/).forEach(id => { if (valid.has(id.trim())) leak.add(id.trim()) }); return '' })
    text = text.replace(/\bF\d{5}\b/g, (m) => { if (valid.has(m)) leak.add(m); return '' })
    return { text: text.trim(), facts: [...leak] }
  }).filter(s => s.text.length > 8)
  if (!segs.length) continue
  const storyId = 'story:pipe:' + it.id.split(':').pop()
  let body = '## 摘要\n\n'
  const anchors = []
  let order = 0
  for (const seg of segs) { const a = body.length; body += seg.text; const b = body.length; for (const fid of new Set(seg.facts)) anchors.push({ fid, a, b }) }
  body += '\n\n'
  let category = '其他', conf = null
  try {
    const cr = await decide({ state: { text: body.slice(0, 3000), title: it.title }, questions: { c: { type: 'choice', instructions: 'Which single category best describes this article?', criteria: CATS } } })
    category = CATS[cr.answers.c?.choice] || '其他'; conf = cr.answers.c?.confidence ?? null
  } catch {}
  db.exec('BEGIN')
  try {
    db.prepare(`INSERT OR REPLACE INTO story(id,title,status,item_count,first_seen_ts,last_update_ts,anchor,validated,category,category_confidence,body_md,story_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(storyId, it.title, 'active', 1, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), null, 1, category, conf, body, 'story')
    db.prepare('INSERT OR IGNORE INTO story_item(story_id,item_id,role) VALUES (?,?,?)').run(storyId, it.id, 'source')
    db.prepare('INSERT OR REPLACE INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
      .run(`${storyId}:sec1`, storyId, 0, '摘要', body.replace(/^## .*\n\n/, '').trim(), 0, body.length)
    const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    for (const a of anchors) insSf.run(storyId, a.fid, `${storyId}:sec1`, a.a, a.b, 'asserts', order++)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  console.log('created:', storyId, '|', it.title.slice(0, 40), '|', anchors.length, 'anchors')
}
db.close()
