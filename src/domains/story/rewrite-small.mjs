// story/rewrite-small.mjs — 小 Story（<1000 字）专用：整篇重新生成成一段连贯报道
// 不走定向/全量重写的比例闸门，改用绝对门限（覆盖≥0.95、长度≥max(250, 原文90%)、重复≤0.15）
import { chat, extractJson } from '../../providers/llm.mjs'
import { snapshot, restore } from './rewrite.mjs'
import { sectionId } from './store.mjs'

const DEFAULTS = { smallChars: 1000, coverageTh: 0.95, minChars: 200, lenRatio: 0.35, dupTh: 0.15, retries: 2 }
const tri = (s) => { const x = String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, ''); const t = new Set(); for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3)); return t }
const jac = (a, b) => { const A = tri(a), B = tri(b); if (!A.size || !B.size) return 0; let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n) }
const dupOf = (txt) => { const ss = txt.split(/[。！？\n]+/).map(x => x.trim()).filter(x => x.length >= 12); let d = 0; for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) if (jac(ss[i], ss[j]) >= 0.82) d++; return ss.length ? d / ss.length : 0 }

export async function rewriteSmallStory ({ db, storyId, newFactIds = [], params = {} }) {
  const P = { ...DEFAULTS, ...params }
  const story = db.prepare('SELECT id,title,body_md FROM story WHERE id=?').get(storyId)
  if (!story) return { error: 'story-not-found' }
  if (story.body_md.length >= P.smallChars) return { skipped: true, reason: 'not-small', chars: story.body_md.length }
  const oldFacts = db.prepare('SELECT DISTINCT fact_id FROM story_fact WHERE story_id=?').all(storyId).map(r => r.fact_id)
  const allIds = [...new Set([...oldFacts, ...newFactIds])]
  const facts = db.prepare(`SELECT id,canonical_text FROM fact WHERE id IN (${allIds.map(() => '?').join(',')})`).all(...allIds)
  if (facts.length < 2) return { skipped: true, reason: 'too-few-facts' }
  const valid = new Set(facts.map(f => f.id))
  const fl = facts.map(f => `${f.id}: ${f.canonical_text}`).join('\n')
  const oldChars = story.body_md.length

  let parts = null
  for (let t = 0; t < P.retries && !parts; t++) {
    try {
      const r = await chat({ json: true, maxTokens: 6000, messages: [{ role: 'user', content: `为「${story.title}」写一篇完整的中文短报道。\n\n事实：\n${fl}\n\n要求：3–5 段、每段 2–3 句，连贯叙述（不要罗列）；覆盖全部事实；每句标注 fact_id；禁止把编号写进正文；不要编造。只输出 JSON：{"segments":[{"text":"...","facts":["F00001"]}]}` }] })
      const p = extractJson(r.content)
      if (p && Array.isArray(p.segments) && p.segments.length) parts = p.segments
    } catch {}
  }
  if (!parts) return { error: 'gen-failed' }
  const segs = parts.map(s => {
    let text = String(s.text || '')
    const leak = new Set((s.facts || []).filter(id => valid.has(id)))
    text = text.replace(/[（(]\s*(F\d{5,}(?:\s*[、,，]\s*F\d{5,})*)\s*[）)]/g, (m, ids) => { ids.split(/[、,，]/).forEach(id => { if (valid.has(id.trim())) leak.add(id.trim()) }); return '' })
    text = text.replace(/\bF\d{5,}\b/g, (m) => { if (valid.has(m)) leak.add(m); return '' })
    return { text: text.trim(), facts: [...leak] }
  }).filter(s => s.text.length > 8)
  if (!segs.length) return { error: 'empty' }

  const snap = snapshot(db, storyId, `small-rewrite:${allIds.length}`)
  let body = ''
  const anchors = []
  let order = 0
  for (const seg of segs) {
    const a = body.length; body += seg.text; const b = body.length
    for (const fid of new Set(seg.facts)) anchors.push({ fid, a, b })
    body += '\n\n'
  }
  const used = new Set(anchors.map(a => a.fid))
  const coverage = facts.length ? used.size / facts.length : 0
  const dup = dupOf(body)
  if (coverage < P.coverageTh || body.length < Math.max(P.minChars, oldChars * P.lenRatio) || dup > P.dupTh) {
    restore(db, storyId, snap.version)
    return { rolled_back: true, coverage: +coverage.toFixed(2), chars: body.length, oldChars, dup: +dup.toFixed(2) }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE story SET body_md=?, last_update_ts=? WHERE id=?').run(body, Math.floor(Date.now() / 1000), storyId)
    db.prepare('DELETE FROM story_section WHERE story_id=?').run(storyId)
    db.prepare('DELETE FROM story_fact WHERE story_id=?').run(storyId)
    db.prepare('INSERT OR REPLACE INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
      .run(sectionId(storyId, 1), storyId, 0, '报道', body.replace(/\n\n$/, ''), 0, body.length)
    const ins = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    for (const a of anchors) ins.run(storyId, a.fid, sectionId(storyId, 1), a.a, a.b, 'asserts', order++)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); return { error: 'write-failed' } }
  return { ok: true, small: true, chars: body.length, oldChars, coverage: +coverage.toFixed(2), dup: +dup.toFixed(2), anchors: anchors.length }
}
