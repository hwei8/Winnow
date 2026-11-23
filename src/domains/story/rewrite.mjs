// story/rewrite.mjs — Story 重写：快照 → 全量重生成 → QA 闸门 → 必要时回滚
import { chat, extractJson } from '../../providers/llm.mjs'
import { decide } from '../../providers/jev.mjs'
import { sectionId } from './store.mjs'

const TH = { coverage: 0.0, align: 0.0 }

function tri (s) { const x = String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, ''); const t = new Set(); for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3)); return t }
const jac = (a, b) => { const A = tri(a), B = tri(b); if (!A.size || !B.size) return 0; let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n) }

export function snapshot (db, storyId, note = '') {
  const story = db.prepare('SELECT id,title,body_md,category FROM story WHERE id=?').get(storyId)
  if (!story) return null
  const sections = db.prepare('SELECT id,order_idx,heading,body_md,char_start,char_end FROM story_section WHERE story_id=? ORDER BY order_idx').all(storyId)
  const facts = db.prepare('SELECT fact_id,section_id,char_start,char_end,role,order_idx FROM story_fact WHERE story_id=?').all(storyId)
  const version = Number(db.prepare('SELECT MAX(version) v FROM story_version WHERE story_id=?').get(storyId)?.v || 0) + 1
  db.prepare('INSERT OR REPLACE INTO story_version(story_id,version,body_md,sections_json,facts_json,category,created_at,note) VALUES (?,?,?,?,?,?,?,?)')
    .run(storyId, version, story.body_md, JSON.stringify(sections), JSON.stringify(facts), story.category, new Date().toISOString(), note)
  return { version, body_md: story.body_md, sections, facts, category: story.category }
}

export function restore (db, storyId, version) {
  const v = db.prepare('SELECT * FROM story_version WHERE story_id=? AND version=?').get(storyId, version)
  if (!v) return false
  const sections = JSON.parse(v.sections_json || '[]')
  const facts = JSON.parse(v.facts_json || '[]')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE story SET body_md=?, category=? WHERE id=?').run(v.body_md, v.category, storyId)
    db.prepare('DELETE FROM story_section WHERE story_id=?').run(storyId)
    db.prepare('DELETE FROM story_fact WHERE story_id=?').run(storyId)
    const insSec = db.prepare('INSERT OR REPLACE INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
    for (const s of sections) insSec.run(s.id, storyId, s.order_idx, s.heading, s.body_md, s.char_start, s.char_end)
    const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    for (const f of facts) insSf.run(storyId, f.fact_id, f.section_id, f.char_start, f.char_end, f.role, f.order_idx)
    db.exec('COMMIT')
    return true
  } catch (e) { db.exec('ROLLBACK'); return false }
}

function scoreBody (body, facts, title, align) {
  const sents = body.split(/[。！？\n]+/).map(s => s.replace(/^#+\s*/, '').trim()).filter(s => s.length >= 12)
  let dup = 0
  for (let i = 0; i < sents.length; i++) for (let j = i + 1; j < sents.length; j++) if (jac(sents[i], sents[j]) >= 0.82) dup++
  const dupRate = sents.length ? dup / sents.length : 0
  const cov = facts.length ? new Set(facts).size / facts.length : 0
  return +(cov * 40 + (1 - Math.min(1, dupRate * 4)) * 30 + align * 30).toFixed(2)
}

export async function rewriteStory ({ db, storyId, newFactIds = [], note = '' }) {
  const story = db.prepare('SELECT id,title,body_md,category FROM story WHERE id=?').get(storyId)
  if (!story) return { error: 'story-not-found' }
  const oldFacts = db.prepare('SELECT DISTINCT fact_id FROM story_fact WHERE story_id=?').all(storyId).map(r => r.fact_id)
  const superseded = new Set(db.prepare('SELECT id FROM fact WHERE superseded_by IS NOT NULL AND id IN (' + [...oldFacts, ...newFactIds].map(() => '?').join(',') + ')').all(...oldFacts, ...newFactIds).map(r => r.id))
  const allFactIds = [...new Set([...oldFacts, ...newFactIds])].filter(id => !superseded.has(id))
  const facts = db.prepare(`SELECT id,canonical_text FROM fact WHERE id IN (${allFactIds.map(() => '?').join(',')})`).all(...allFactIds)
  if (facts.length < 3) return { error: 'too-few-facts' }
  const snap = snapshot(db, storyId, note)
  const fl = facts.map(f => `${f.id}: ${f.canonical_text}`).join('\n')
  let parsed = null
  for (let t = 1; t <= 3 && !parsed; t++) {
    try {
      const r = await chat({ json: true, maxTokens: 16000, messages: [{ role: 'user', content: `为「${story.title}」重写一篇完整的中文报道，融入最新事实。

事实（编号: 内容）：
${fl}

要求：
- 5–8 个小节，叙事顺序（概览 → 背景/原理 → 细节 → 争议/影响 → 结论）。
- 每节 2–4 段，每段 2–4 句；句子连贯，不要罗列。
- 每个句子标注它使用的 fact_id（只能从上面选，不要编造）。
- 严禁把 fact_id 写进正文。
只输出 JSON：{"sections":[{"heading":"...","segments":[{"text":"...","facts":["F00001"]}]}]}` }] })
      const p = extractJson(r.content)
      if (p && Array.isArray(p.sections) && p.sections.length >= 3) parsed = p
    } catch {}
  }
  if (!parsed) { return { error: 'gen-failed', restored: false } }
  const valid = new Set(facts.map(f => f.id))
  let body = ''
  const sections = []
  const anchors = []
  let order = 0
  for (const sec of parsed.sections) {
    const segs = (sec.segments || []).map(s => {
      let text = String(s.text || '')
      const leak = new Set((s.facts || []).filter(id => valid.has(id)))
      text = text.replace(/[（(]\s*(F\d{5,}(?:\s*[、,，]\s*F\d{5,})*)\s*[）)]/g, (m, ids) => { ids.split(/[、,，]/).forEach(id => { if (valid.has(id.trim())) leak.add(id.trim()) }); return '' })
      text = text.replace(/\bF\d{5,}\b/g, (m) => { if (valid.has(m)) leak.add(m); return '' })
      return { text: text.trim(), facts: [...leak] }
    }).filter(s => s.text.length > 8)
    if (!segs.length) continue
    const start = body.length
    body += `## ${sec.heading}\n\n`
    for (const seg of segs) {
      const a = body.length; body += seg.text; const b = body.length
      for (const fid of new Set(seg.facts)) anchors.push({ fid, a, b })
      body += '\n\n'
    }
    sections.push({ id: sectionId(storyId, sections.length + 1), heading: sec.heading, body_md: body.slice(start, body.length).replace(/^## .*\n\n/, '').trim(), char_start: start, char_end: body.length })
  }
  if (body.length < 300) { return { error: 'empty-body' } }
  // 保护：事实覆盖率优先，长度作为次要约束
  const oldChars = (snap?.body_md || '').length
  const usedIds = new Set(anchors.map(a => a.fid))
  const coverage = facts.length ? usedIds.size / facts.length : 0
  if (oldChars > 800 && (coverage < 0.90 || body.length < oldChars * 0.80)) {
    try {
      const r2 = await chat({ json: true, maxTokens: 16000, messages: [{ role: 'user', content: `为「${story.title}」重写一篇完整中文报道。事实：\n${fl}\n\n要求：5–8 节，正文不少于 ${Math.round(oldChars * 0.9)} 字，保留原文所有重要事实；每句标注 fact_id；禁止把编号写进正文。只输出 JSON：{"sections":[{"heading":"...","segments":[{"text":"...","facts":["F00001"]}]}]}` }] })
      const p2 = extractJson(r2.content)
      if (p2 && Array.isArray(p2.sections) && p2.sections.length >= 3) {
        let body2 = ''
        const sections2 = [], anchors2 = []
        for (const sec of p2.sections) {
          const segs = (sec.segments || []).map(sg => {
            let text = String(sg.text || '')
            const leak = new Set((sg.facts || []).filter(id => valid.has(id)))
            text = text.replace(/[（(]\s*(F\d{5,}(?:\s*[、,，]\s*F\d{5,})*)\s*[）)]/g, (m, ids) => { ids.split(/[、,，]/).forEach(id => { if (valid.has(id.trim())) leak.add(id.trim()) }); return '' })
            text = text.replace(/\bF\d{5,}\b/g, (m) => { if (valid.has(m)) leak.add(m); return '' })
            return { text: text.trim(), facts: [...leak] }
          }).filter(s => s.text.length > 8)
          if (!segs.length) continue
          const st = body2.length
          body2 += `## ${sec.heading}\n\n`
          for (const sg of segs) { const a = body2.length; body2 += sg.text; const b = body2.length; for (const fid of new Set(sg.facts)) anchors2.push({ fid, a, b }); body2 += '\n\n' }
          sections2.push({ id: sectionId(storyId, sections2.length + 1), heading: sec.heading, body_md: body2.slice(st, body2.length).replace(/^## .*\n\n/, '').trim(), char_start: st, char_end: body2.length })
        }
        if (body2.length >= oldChars * 0.80) { body = body2; sections.splice(0, sections.length, ...sections2); anchors.splice(0, anchors.length, ...anchors2) }
      }
    } catch {}
    const usedIds2 = new Set(anchors.map(a => a.fid))
    const cov2 = facts.length ? usedIds2.size / facts.length : 0
    if (cov2 < 0.90 || body.length < oldChars * 0.80) { restore(db, storyId, snap.version); return { rolled_back: true, reason: 'quality-gate', oldChars, newChars: body.length, coverage: +cov2.toFixed(2) } }
  }

  // QA 闸门：新旧对比（标题一致性 + 覆盖率 + 重复率）
  const bodyBefore = snap?.body_md || ''
  const oldFactIds = db.prepare('SELECT DISTINCT fact_id FROM story_fact WHERE story_id=?').all(storyId).map(r => r.fact_id)
  const scoreBefore = scoreBody(bodyBefore, oldFactIds, story.title, 0.8)
  let align = 0.8
  try {
    const r = await decide({ state: { title: story.title, body: body.slice(0, 3500) }, questions: { q: { type: 'noul', instructions: 'The body is consistent with the title (delivers what the title promises).', criteria: { true: 'Consistent.', false: 'Mismatch.' } } } })
    align = r.answers.q?.noul ?? 0.8
  } catch {}
  const scoreAfter = scoreBody(body, anchors.map(a => a.fid), story.title, align)
  if (scoreAfter + 5 < scoreBefore) {
    restore(db, storyId, snap.version)
    return { rolled_back: true, scoreBefore, scoreAfter }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE story SET body_md=?, last_update_ts=? WHERE id=?').run(body, Math.floor(Date.now() / 1000), storyId)
    db.prepare('DELETE FROM story_section WHERE story_id=?').run(storyId)
    db.prepare('DELETE FROM story_fact WHERE story_id=?').run(storyId)
    const insSec = db.prepare('INSERT OR REPLACE INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
    sections.forEach((s, i) => insSec.run(s.id, storyId, i, s.heading, s.body_md, s.char_start, s.char_end))
    const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    for (const a of anchors) insSf.run(storyId, a.fid, null, a.a, a.b, 'asserts', order++)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); return { error: 'write-failed' } }
  return { ok: true, version: snap?.version, chars: body.length, sections: sections.length, anchors: anchors.length, align: +align.toFixed(2), scoreBefore, scoreAfter, snapshot: !!snap }
}
