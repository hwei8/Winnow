// story/consolidate.mjs — 节合并：把多个"最新进展"追加节合并成一节，其余章节不动
//
// 参数（可调）：
//   minSections   触发所需的最少追加节数（默认 2）
//   maxMerge      单次最多合并的节数（默认 8）
//   lenRatio      合并后长度下限（相对各原节长度之和，默认 0.6）
//   coverageTh    事实覆盖率下限（默认 0.95）
//   dupTh         合并后重复率上限（默认 0.15）
//   retries       生成重试次数（默认 2）
import { chat, extractJson } from '../../providers/llm.mjs'
import { snapshot, restore } from './rewrite.mjs'
import { realignAnchors } from '../knowledge/align.mjs'
import { sectionId } from './store.mjs'

const DEFAULTS = { minSections: 2, maxMerge: 8, lenRatio: 0.2, absMinLen: 50, coverageTh: 0.95, dupTh: 0.15, retries: 2 }
const tri = (s) => { const x = String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, ''); const t = new Set(); for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3)); return t }
const jac = (a, b) => { const A = tri(a), B = tri(b); if (!A.size || !B.size) return 0; let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n) }
const dupOf = (txt) => { const ss = txt.split(/[。！？\n]+/).map(x => x.trim()).filter(x => x.length >= 12); let d = 0; for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) if (jac(ss[i], ss[j]) >= 0.82) d++; return ss.length ? d / ss.length : 0 }
const isUpdateHeading = (h) => /^最新进展/.test(String(h || ''))

// 兼容历史数据：早期生成器把 section_id 写成裸的 `secN`（见 story/store.mjs）。
// `db.mjs --repair` 会修正存量；这里同时按两种格式查，避免漏掉锚点后被 DELETE 掉。
const legacySectionId = (fullId) => String(fullId).split(':').pop()

export async function consolidateSections ({ db, storyId, params = {} }) {
  const P = { ...DEFAULTS, ...params }
  const story = db.prepare('SELECT id,title,body_md FROM story WHERE id=?').get(storyId)
  if (!story) return { error: 'story-not-found' }
  const sections = db.prepare('SELECT id,order_idx,heading,body_md,char_start,char_end FROM story_section WHERE story_id=? ORDER BY order_idx').all(storyId)
  const updateSections = sections.filter(s => isUpdateHeading(s.heading))
  if (updateSections.length < P.minSections) return { skipped: true, reason: 'not-enough-update-sections', count: updateSections.length }
  const mergeList = updateSections.slice(0, P.maxMerge)
  const keepList = sections.filter(s => !mergeList.includes(s))

  // 收集待合并事实：这些节的锚点 + role='update' 的待并入事实
  const facts = new Map()
  for (const sec of mergeList) {
    const rows = db.prepare(`SELECT fact_id FROM story_fact WHERE story_id=? AND (
      section_id IN (?, ?) OR (char_start >= ? AND char_end <= ? AND (section_id IS NULL OR section_id='')))`).all(storyId, sec.id, legacySectionId(sec.id), sec.char_start, sec.char_end)
    for (const r of rows) facts.set(r.fact_id, null)
  }
  const pending = db.prepare("SELECT fact_id FROM story_fact WHERE story_id=? AND (role='update' AND (section_id IS NULL OR section_id=''))").all(storyId)
  for (const r of pending) facts.set(r.fact_id, null)
  const factIds = [...facts.keys()]
  if (!factIds.length) return { skipped: true, reason: 'no-facts' }
  const factRows = db.prepare(`SELECT id,canonical_text FROM fact WHERE id IN (${factIds.map(() => '?').join(',')})`).all(...factIds)
  const valid = new Set(factRows.map(f => f.id))
  const fl = factRows.map(f => `${f.id}: ${f.canonical_text}`).join('\n')
  const origChars = mergeList.reduce((a, s) => a + s.body_md.length, 0)

  let segs = null
  for (let t = 0; t < P.retries && !segs; t++) {
    try {
      const r = await chat({ json: true, maxTokens: 8000, messages: [{ role: 'user', content: `把「${story.title}」的多个"最新进展"小节合并成一节连贯叙述。\n\n原节内容：\n${mergeList.map(s => `【${s.heading}】\n${s.body_md.slice(0, 1200)}`).join('\n\n')}\n\n必须覆盖以下事实：\n${fl}\n\n要求：合并后 2–4 段、每段 2–4 句；去重；每句标注 fact_id；禁止把编号写进正文。只输出 JSON：{"segments":[{"text":"...","facts":["F00001"]}]}` }] })
      const p = extractJson(r.content)
      if (p && Array.isArray(p.segments) && p.segments.length) segs = p.segments
    } catch {}
  }
  if (!segs) return { error: 'gen-failed', sections: mergeList.length }
  const parts = segs.map(s => {
    let text = String(s.text || '')
    const leak = new Set((s.facts || []).filter(id => valid.has(id)))
    text = text.replace(/[（(]\s*(F\d{5,}(?:\s*[、,，]\s*F\d{5,})*)\s*[）)]/g, (m, ids) => { ids.split(/[、,，]/).forEach(id => { if (valid.has(id.trim())) leak.add(id.trim()) }); return '' })
    text = text.replace(/\bF\d{5,}\b/g, (m) => { if (valid.has(m)) leak.add(m); return '' })
    return { text: text.trim(), facts: [...leak] }
  }).filter(s => s.text.length > 8)
  if (!parts.length) return { error: 'empty-merged' }

  // 组装：保留章节 + 合并节（放末尾）
  const snap = snapshot(db, storyId, `consolidate:${mergeList.length}`)
  let body = ''
  const outSections = []
  const anchors = []
  let order = 0
  const pushSection = (heading, md, anchorList) => {
    const start = body.length
    body += `## ${heading}\n\n${md}\n\n`
    outSections.push({ id: sectionId(storyId, outSections.length + 1), heading, body_md: md, char_start: start, char_end: body.length })
    if (anchorList) for (const a of anchorList) anchors.push({ ...a, sectionIdx: outSections.length - 1 })
  }
  for (const sec of keepList) {
    const oldAnchors = db.prepare(`SELECT fact_id,char_start,char_end FROM story_fact WHERE story_id=? AND (
      section_id IN (?, ?) OR (char_start >= ? AND char_end <= ? AND (section_id IS NULL OR section_id='')))`).all(storyId, sec.id, legacySectionId(sec.id), sec.char_start, sec.char_end)
    pushSection(sec.heading, sec.body_md, oldAnchors.map(a => ({ fid: a.fact_id, relA: a.char_start - sec.char_start, relB: a.char_end - sec.char_start })))
  }
  // 合并节
  const mergedMd = parts.map(p => p.text).join('\n\n')
  const mergedStart = body.length
  body += `## 最新进展\n\n`
  const mergedAnchors = []
  for (const part of parts) {
    const a = body.length; body += part.text; const b = body.length
    for (const fid of new Set(part.facts)) mergedAnchors.push({ fid, a, b })
    body += '\n\n'
  }
  outSections.push({ id: sectionId(storyId, outSections.length + 1), heading: '最新进展', body_md: mergedMd, char_start: mergedStart, char_end: body.length })

  // 闸门
  const used = new Set(mergedAnchors.map(a => a.fid))
  const coverage = factIds.length ? used.size / factIds.length : 0
  const mergedDup = dupOf(mergedMd)
  if (coverage < P.coverageTh || mergedMd.length < Math.max(P.absMinLen, origChars * P.lenRatio) || mergedDup > P.dupTh) {
    restore(db, storyId, snap.version)
    return { rolled_back: true, coverage: +coverage.toFixed(2), mergedChars: mergedMd.length, origChars, dup: +mergedDup.toFixed(2) }
  }

  // 写回：重建 sections 与 anchors（含保留节的偏移迁移）
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE story SET body_md=?, last_update_ts=? WHERE id=?').run(body, Math.floor(Date.now() / 1000), storyId)
    db.prepare('DELETE FROM story_section WHERE story_id=?').run(storyId)
    db.prepare('DELETE FROM story_fact WHERE story_id=?').run(storyId)
    const insSec = db.prepare('INSERT OR REPLACE INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
    outSections.forEach((s, i) => insSec.run(s.id, storyId, i, s.heading, s.body_md, s.char_start, s.char_end))
    const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    // 保留节锚点：按节内相对偏移迁移
    const keptSecs = outSections.slice(0, keepList.length)
    for (const a of anchors) {
      const sec = keptSecs[a.sectionIdx]
      if (!sec) continue
      insSf.run(storyId, a.fid, sec.id, sec.char_start + a.relA, sec.char_start + a.relB, 'asserts', order++)
    }
    // 合并节锚点
    const mergedSec = outSections[outSections.length - 1]
    for (const a of mergedAnchors) insSf.run(storyId, a.fid, mergedSec.id, a.a, a.b, 'asserts', order++)
    db.prepare("INSERT OR REPLACE INTO story_update(id,story_id,at,change_type,detail_json) VALUES (?,?,?,?,?)")
      .run(`consolidate:${storyId}:${Date.now()}`, storyId, new Date().toISOString(), 'consolidate', JSON.stringify({ merged: mergeList.map(s => s.heading), facts: factIds.length }))
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); return { error: 'write-failed', detail: String(e.message).slice(0, 100) } }
  // 合并后自动做锚点语义重对齐（确保所有章节锚点完整）
  let align = null
  try { align = await realignAnchors(db, storyId) } catch {}
  return { ok: true, mergedSections: mergeList.length, sectionsBefore: sections.length, sectionsAfter: outSections.length, chars: body.length, oldChars: story.body_md.length, coverage: +coverage.toFixed(2), dup: +mergedDup.toFixed(2), align }
}
