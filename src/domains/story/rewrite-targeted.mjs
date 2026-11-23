// story/rewrite-targeted.mjs — 定向重写：只重写受影响的小节（+开头），其余保留，避免信息丢失
import { chat, extractJson } from '../../providers/llm.mjs'
import { decide } from '../../providers/jev.mjs'
import { snapshot, restore } from './rewrite.mjs'
import { sectionId } from './store.mjs'

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '')
const tri = (s) => { const x = norm(s); const t = new Set(); for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3)); return t }
const jac = (a, b) => { const A = tri(a), B = tri(b); if (!A.size || !B.size) return 0; let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n) }

export async function rewriteTargeted ({ db, storyId, newFactIds = [], note = '' }) {
  const story = db.prepare('SELECT id,title,body_md,category FROM story WHERE id=?').get(storyId)
  if (!story) return { error: 'story-not-found' }
  const sections = db.prepare('SELECT id,order_idx,heading,body_md,char_start,char_end FROM story_section WHERE story_id=? ORDER BY order_idx').all(storyId)
  if (!sections.length) return { error: 'no-sections' }
  const newFacts = db.prepare(`SELECT id,canonical_text FROM fact WHERE id IN (${newFactIds.map(() => '?').join(',')})`).all(...newFactIds)
  if (!newFacts.length) return { error: 'no-new-facts' }

  // 受影响小节：与任一新增事实的 trigram 相似度 ≥ 0.18；第一个小节（Lede）始终重写
  const affected = new Set()
  sections.forEach((s, i) => {
    if (i === 0) { affected.add(i); return }
    const sim = Math.max(...newFacts.map(f => jac(f.canonical_text, s.body_md)))
    if (sim >= 0.18) affected.add(i)
  })
  if (affected.size > Math.max(2, Math.floor(sections.length * 0.4))) {
    return { skipped: true, reason: 'too-many-affected-sections', affected: affected.size, total: sections.length }
  }
  const snap = snapshot(db, storyId, note)

  // 逐节重写
  const newSectionMd = new Map()
  for (const idx of [...affected].sort((a, b) => a - b)) {
    const sec = sections[idx]
    const secFacts = db.prepare(`SELECT DISTINCT f.id,f.canonical_text FROM story_fact sf JOIN fact f ON f.id=sf.fact_id
      WHERE sf.story_id=? AND sf.char_start>=? AND sf.char_end<=?`).all(storyId, sec.char_start, sec.char_end)
    const allFacts = [...new Map([...secFacts, ...newFacts].map(f => [f.id, f])).values()]
    const fl = allFacts.map(f => `${f.id}: ${f.canonical_text}`).join('\n')
    let segs = null
    for (let t = 1; t <= 2 && !segs; t++) {
      try {
        const r = await chat({ json: true, maxTokens: 6000, messages: [{ role: 'user', content: `重写「${story.title}」的「${sec.heading}」这一节，把最新事实融入，保留原有重要事实。\n\n原文：\n${sec.body_md.slice(0, 1500)}\n\n事实：\n${fl}\n\n2–4 段、每段 2–4 句；每句标注 fact_id；禁止把编号写进正文。只输出 JSON：{"segments":[{"text":"...","facts":["F00001"]}]}` }] })
        const p = extractJson(r.content)
        if (p && Array.isArray(p.segments) && p.segments.length) segs = p.segments
      } catch {}
    }
    if (!segs) { newSectionMd.set(idx, null); continue }
    const valid = new Set(allFacts.map(f => f.id))
    const parts = segs.map(s => {
      let text = String(s.text || '')
      const leak = new Set((s.facts || []).filter(id => valid.has(id)))
      text = text.replace(/[（(]\s*(F\d{5,}(?:\s*[、,，]\s*F\d{5,})*)\s*[）)]/g, (m, ids) => { ids.split(/[、,，]/).forEach(id => { if (valid.has(id.trim())) leak.add(id.trim()) }); return '' })
      text = text.replace(/\bF\d{5,}\b/g, (m) => { if (valid.has(m)) leak.add(m); return '' })
      return { text: text.trim(), facts: [...leak] }
    }).filter(s => s.text.length > 8)
    if (parts.length) {
      const used = new Set(parts.flatMap(p => p.facts))
      const secCoverage = allFacts.length ? allFacts.filter(f => used.has(f.id)).length / allFacts.length : 1
      if (secCoverage < 0.85) {
        // 覆盖率不足：重试一次
        try {
          const r2 = await chat({ json: true, maxTokens: 6000, messages: [{ role: 'user', content: `重写「${story.title}」的「${sec.heading}」这一节。必须覆盖下面全部 ${allFacts.length} 条事实，不要遗漏。\n\n原文：\n${sec.body_md.slice(0, 1500)}\n\n事实：\n${fl}\n\n2–4 段；每句标注 fact_id；禁止把编号写进正文。只输出 JSON：{"segments":[{"text":"...","facts":["F00001"]}]}` }] })
          const p2 = extractJson(r2.content)
          if (p2 && Array.isArray(p2.segments) && p2.segments.length) {
            const parts2 = p2.segments.map(sg => {
              let text = String(sg.text || '')
              const leak = new Set((sg.facts || []).filter(id => valid.has(id)))
              text = text.replace(/[（(]\s*(F\d{5,}(?:\s*[、,，]\s*F\d{5,})*)\s*[）)]/g, (m, ids) => { ids.split(/[、,，]/).forEach(id => { if (valid.has(id.trim())) leak.add(id.trim()) }); return '' })
              text = text.replace(/\bF\d{5,}\b/g, (m) => { if (valid.has(m)) leak.add(m); return '' })
              return { text: text.trim(), facts: [...leak] }
            }).filter(sg => sg.text.length > 8)
            const used2 = new Set(parts2.flatMap(x => x.facts))
            const cov2 = allFacts.length ? allFacts.filter(f => used2.has(f.id)).length / allFacts.length : 1
            if (parts2.length && cov2 > secCoverage) { newSectionMd.set(idx, parts2); continue }
          }
        } catch {}
        newSectionMd.set(idx, null) // 仍不达标 → 保留原节
        continue
      }
      newSectionMd.set(idx, parts)
    } else newSectionMd.set(idx, null)
  }

  // 重组正文
  let body = ''
  const outSections = []
  const anchors = []
  let order = 0
  sections.forEach((sec, i) => {
    const start = body.length
    body += `## ${sec.heading}\n\n`
    if (affected.has(i) && newSectionMd.get(i)) {
      for (const part of newSectionMd.get(i)) {
        const a = body.length; body += part.text; const b = body.length
        for (const fid of new Set(part.facts)) anchors.push({ fid, a, b }); body += '\n\n'
      }
    } else {
      // 保留原节正文，按原锚点相对位置迁移
      const secLocal = sec.body_md
      body += secLocal + '\n\n'
      const oldAnchors = db.prepare('SELECT fact_id,char_start,char_end FROM story_fact WHERE story_id=? AND char_start>=? AND char_end<=?').all(storyId, sec.char_start, sec.char_end)
      for (const an of oldAnchors) {
        const rel = an.char_start - sec.char_start
        const relEnd = an.char_end - sec.char_start
        anchors.push({ fid: an.fact_id, a: start + rel, b: start + relEnd })
      }
    }
    outSections.push({ id: sectionId(storyId, i + 1), heading: sec.heading, body_md: body.slice(start, body.length).replace(/^## .*\n\n/, '').trim(), char_start: start, char_end: body.length })
  })

  // QA 闸门
  const used = new Set(anchors.map(a => a.fid))
  const totalFacts = db.prepare('SELECT DISTINCT fact_id FROM story_fact WHERE story_id=?').all(storyId).length + newFacts.length
  const coverage = totalFacts ? used.size / totalFacts : 0
  if (coverage < 0.85 || body.length < story.body_md.length * 0.85) {
    restore(db, storyId, snap.version)
    return { rolled_back: true, coverage: +coverage.toFixed(2), chars: body.length, oldChars: story.body_md.length, affected: affected.size }
  }
  const dupOf = (txt) => { const ss = txt.split(/[。！？\n]+/).map(x => x.trim()).filter(x => x.length >= 12); let d = 0; for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) if (jac(ss[i], ss[j]) >= 0.82) d++; return ss.length ? d / ss.length : 0 }
  const dupBefore = dupOf(story.body_md), dupAfter = dupOf(body)
  if (dupAfter > 0.20 || dupAfter > dupBefore + 0.10) {
    restore(db, storyId, snap.version)
    return { rolled_back: true, reason: 'dup-gate', dupBefore: +dupBefore.toFixed(2), dupAfter: +dupAfter.toFixed(2) }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE story SET body_md=?, last_update_ts=? WHERE id=?').run(body, Math.floor(Date.now() / 1000), storyId)
    db.prepare('DELETE FROM story_section WHERE story_id=?').run(storyId)
    db.prepare('DELETE FROM story_fact WHERE story_id=?').run(storyId)
    const insSec = db.prepare('INSERT OR REPLACE INTO story_section(id,story_id,order_idx,heading,body_md,char_start,char_end) VALUES (?,?,?,?,?,?,?)')
    outSections.forEach((s, i) => insSec.run(s.id, storyId, i, s.heading, s.body_md, s.char_start, s.char_end))
    const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    for (const a of anchors) insSf.run(storyId, a.fid, null, a.a, a.b, 'asserts', order++)
    // 缺口事实确保入册
    const have = new Set(anchors.map(a => a.fid))
    for (const f of newFacts) if (!have.has(f.id)) insSf.run(storyId, f.id, null, 0, 0, 'update', order++)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); return { error: 'write-failed' } }
  return { ok: true, targeted: true, affectedSections: affected.size, totalSections: sections.length, chars: body.length, oldChars: story.body_md.length, coverage: +coverage.toFixed(2), anchors: anchors.length, version: snap?.version }
}
