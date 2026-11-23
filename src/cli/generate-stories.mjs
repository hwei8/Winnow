// cli/generate-stories.mjs — 批量成稿（快线）：每篇一次调用写完，十路并发
import { writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT, nowIso } from '../shared/db.mjs'
import { chat, extractJson } from '../providers/llm.mjs'
import { decide } from '../providers/jev.mjs'

const db = openDb()
const LIMIT = Number(process.env.LIMIT || 0)
const CONC = Number(process.env.CONC || 10)
const CATS = { tech: '科技', politics: '政治', entertainment: '娱乐', history: '历史', business: '商业', society: '社会', world: '国际', science: '科学' }

const stories = db.prepare(`
  SELECT s.id, s.title,
    (SELECT COUNT(*) FROM story_item si JOIN claim c ON c.item_id=si.item_id WHERE si.story_id=s.id) claims
  FROM story s
  WHERE s.item_count > 0 AND (s.body_md IS NULL OR s.body_md='')
    AND s.id NOT LIKE 'story:gen:%' AND s.id NOT LIKE 'story:pilot:%'
  ORDER BY claims DESC`).all()
const queue = LIMIT ? stories.slice(0, LIMIT) : stories
console.log('stories to generate:', queue.length)
const log = (o) => appendFileSync(path.join(ROOT, 'out', 'batch-fast.log'), JSON.stringify(o) + '\n')

async function generate (story) {
  const items = db.prepare('SELECT item_id FROM story_item WHERE story_id=?').all(story.id).map(r => r.item_id)
  if (!items.length) return { skipped: 'no-items' }
  const claims = db.prepare(`SELECT c.fact_id FROM claim c WHERE c.item_id IN (${items.map(() => '?').join(',')}) AND c.status!='meta' AND c.fact_id IS NOT NULL`).all(...items)
  const factIds = [...new Set(claims.map(c => c.fact_id))]
  if (factIds.length < 5) return { skipped: 'too-few-facts', facts: factIds.length }
  const factRows = db.prepare(`SELECT id,canonical_text FROM fact WHERE id IN (${factIds.map(() => '?').join(',')})`).all(...factIds)
  const validIds = new Set(factRows.map(f => f.id))
  const factList = factRows.map(f => `${f.id}: ${f.canonical_text}`).join('\n')

  let parsed = null
  for (let t = 1; t <= 3 && !parsed; t++) {
    try {
      const r = await chat({
        json: true, maxTokens: 16000,
        messages: [{ role: 'user', content: `为「${story.title}」写一篇完整的中文报道。

事实（编号: 内容）：
${factList}

要求：
- 5–8 个小节，叙事顺序（概览 → 背景/原理 → 细节 → 争议或影响 → 结论）。
- 每节 2–4 段，每段 2–4 句；句子要连贯、有逻辑，不要罗列。
- 每个句子必须基于上面的事实，并在 facts 里标注它用了哪些 fact_id（只能从上面选，不要编造）。
- 严禁把 fact_id 写进正文文本。
- 不要写"据报道"之外的空话，不要编造事实。

只输出 JSON：
{"sections":[{"heading":"...","segments":[{"text":"...","facts":["F00001"]}]}]}` }]
      })
      const p = extractJson(r.content)
      if (p && Array.isArray(p.sections) && p.sections.length >= 3) parsed = p
    } catch {}
  }
  if (!parsed) return { error: 'write-failed' }

  // 清洗 + 组装
  let body = ''
  const sections = []
  const storyFacts = []
  let order = 0
  for (const sec of parsed.sections) {
    const segs = (sec.segments || []).map(s => {
      let text = String(s.text || '')
      const leak = new Set((s.facts || []).filter(id => validIds.has(id)))
      text = text.replace(/[（(]\s*(F\d{5}(?:\s*[、,，]\s*F\d{5})*)\s*[）)]/g, (m, ids) => { ids.split(/[、,，]/).forEach(id => { const q = id.trim(); if (validIds.has(q)) leak.add(q) }); return '' })
      text = text.replace(/\bF\d{5}\b/g, (m) => { if (validIds.has(m)) leak.add(m); return '' })
      return { text: text.replace(/\s{2,}/g, ' ').trim(), facts: [...leak] }
    }).filter(s => s.text.length > 8)
    if (!segs.length) continue
    const secStart = body.length
    body += `## ${sec.heading}\n\n`
    const groups = []
    for (let i = 0; i < segs.length; i += 2) groups.push(segs.slice(i, i + 2))
    for (const g of groups) {
      for (const seg of g) {
        const segStart = body.length
        body += seg.text
        const segEnd = body.length
        for (const fid of [...new Set(seg.facts)]) storyFacts.push({ story_id: story.id, fact_id: fid, section_id: `sec${sections.length + 1}`, char_start: segStart, char_end: segEnd, order_idx: order++ })
      }
      body += '\n\n'
    }
    sections.push({ id: `sec${sections.length + 1}`, heading: sec.heading, body_md: body.slice(secStart, body.length).replace(/^## .*\n\n/, '').trim(), char_start: secStart, char_end: body.length })
  }
  if (body.length < 400 || !sections.length) return { error: 'empty-body' }

  let category = '其他', conf = null
  try {
    const cr = await decide({ state: { text: body.slice(0, 6000) }, questions: { category: { type: 'choice', instructions: 'Which single category best describes this article?', criteria: CATS } } })
    category = CATS[cr.answers.category?.choice] || '其他'; conf = cr.answers.category?.confidence ?? null
  } catch {}

  const ts = db.prepare(`SELECT MIN(published_ts) a, MAX(published_ts) b FROM item WHERE id IN (${items.map(() => '?').join(',')})`).get(...items)
  db.exec('BEGIN')
  try {
    db.prepare(`INSERT OR REPLACE INTO story(id,title,status,item_count,first_seen_ts,last_update_ts,anchor,validated,category,category_confidence,body_md) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(story.id, story.title, 'active', items.length, ts.a, ts.b, null, 1, category, conf, body)
    db.prepare('DELETE FROM story_section WHERE story_id=?').run(story.id)
    db.prepare('DELETE FROM story_fact WHERE story_id=?').run(story.id)
    const insSec = db.prepare('INSERT INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
    sections.forEach((s, i) => insSec.run(`${story.id}:sec${i + 1}`, story.id, i, s.heading, s.body_md, s.char_start, s.char_end))
    const insSf = db.prepare('INSERT INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    for (const s of storyFacts) insSf.run(s.story_id, s.fact_id, s.section_id, s.char_start, s.char_end, 'asserts', s.order_idx)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return { ok: true, chars: body.length, sections: sections.length, anchors: storyFacts.length, facts: new Set(storyFacts.map(s => s.fact_id)).size, category }
}

let next = 0, done = 0
const results = []
async function worker () {
  while (next < queue.length) {
    const story = queue[next++]
    const t0 = Date.now()
    try {
      const r = await generate(story)
      done++
      results.push({ id: story.id, title: story.title, ...r, ms: Date.now() - t0 })
      log({ at: nowIso(), id: story.id, ...r, ms: Date.now() - t0 })
      if (done % 10 === 0) console.error(`  [fast] ${done}/${queue.length} ${r.ok ? r.chars + '字' : (r.skipped || r.error)}`)
    } catch (e) {
      done++
      results.push({ id: story.id, error: String(e.message).slice(0, 100) })
      log({ at: nowIso(), id: story.id, error: String(e.message).slice(0, 100) })
    }
  }
}
const t0 = Date.now()
await Promise.all(Array.from({ length: CONC }, worker))
const ok = results.filter(r => r.ok)
const summary = {
  total: results.length, ok: ok.length, failed: results.filter(r => r.error).length,
  skipped: results.filter(r => r.skipped).length,
  avg_chars: ok.length ? Math.round(ok.reduce((a, r) => a + (r.chars || 0), 0) / ok.length) : 0,
  avg_anchors: ok.length ? Math.round(ok.reduce((a, r) => a + (r.anchors || 0), 0) / ok.length) : 0,
  seconds: Math.round((Date.now() - t0) / 1000),
  failures: results.filter(r => r.error || r.skipped).slice(0, 10)
}
writeFileSync(path.join(ROOT, 'out', 'batch-fast.json'), JSON.stringify({ summary, results }, null, 1))
console.log(JSON.stringify(summary, null, 1))
db.close()
