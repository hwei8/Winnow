// cli/apply-policy.mjs — 对待处理的 Update 做重写分级并执行
import { openDb, nowIso } from '../shared/db.mjs'
import { classifyUpdate } from '../domains/story/policy.mjs'
import { rewriteStory } from '../domains/story/rewrite.mjs'
import { rewriteTargeted } from '../domains/story/rewrite-targeted.mjs'
import { consolidateSections } from '../domains/story/consolidate.mjs'
import { rewriteSmallStory } from '../domains/story/rewrite-small.mjs'

const db = openDb()
const ONLY = process.env.STORY_ID || null
const rows = db.prepare(`SELECT id, story_id, change_type, detail_json, at FROM story_update
  WHERE (severity IS NULL OR severity='') ORDER BY at DESC LIMIT 200`).all()
  .filter(r => !ONLY || r.story_id === ONLY)
console.log('pending update rows:', rows.length)
// 按 Story 合并：同一 Story 的多条 update 只判定/重写一次
const groups = new Map()
for (const r of rows) {
  let d = {}
  try { d = JSON.parse(r.detail_json || '{}') } catch {}
  const g = groups.get(r.story_id) || { storyId: r.story_id, rows: [], facts: new Set() }
  g.rows.push(r)
  const fl = Array.isArray(d.facts) ? d.facts : (typeof d.facts === 'string' ? (() => { try { return JSON.parse(d.facts) } catch { return [] } })() : [])
  fl.forEach(f => g.facts.add(f))
  groups.set(r.story_id, g)
}
console.log('stories with pending updates:', groups.size)
const report = []
for (const g of groups.values()) {
  const r = g.rows[0]
  const factIds = [...g.facts]
  if (!factIds.length) { for (const rr of g.rows) db.prepare('UPDATE story_update SET severity=?,action=?,reason=? WHERE id=?').run('P4', 'none', 'no-facts', rr.id); continue }
  const cls = await classifyUpdate({ db, parentId: g.storyId, newFactIds: factIds })
  if (cls.degraded) {
    // Jev 挂了：分级不可信，不执行任何重写；severity 留空，下次运行重新判定
    report.push({ story: g.storyId, rows: g.rows.length, skipped: 'jev-unavailable', reasons: cls.reasons })
    continue
  }
  let result = { severity: cls.severity, action: cls.action, reasons: cls.reasons }
  if (cls.action === 'rewrite') {
    // 小 Story（<1000 字）走专用整篇重写（绝对门限）
    const parentChars = db.prepare('SELECT length(body_md) n FROM story WHERE id=?').get(g.storyId)?.n || 0
    if (parentChars < 1000) {
      const small = await rewriteSmallStory({ db, storyId: g.storyId, newFactIds: factIds })
      if (small.ok) {
        result.rewrite = small
        for (const rr of g.rows) db.prepare('UPDATE story_update SET severity=?,action=?,reason=? WHERE id=?').run(cls.severity, 'rewrite_small', JSON.stringify(cls.reasons), rr.id)
        report.push({ story: g.storyId, rows: g.rows.length, ...result })
        continue
      }
      result.smallAttempt = small
    }
    // 所有级别都优先定向重写（保留原有信息），失败再全量重写
    let rw = await rewriteTargeted({ db, storyId: g.storyId, newFactIds: factIds, note: `policy:${r.id}` })
    if (!rw.ok) rw = { targeted: rw, fallback: await rewriteStory({ db, storyId: g.storyId, newFactIds: factIds, note: `policy:${r.id}` }) }
    result.rewrite = rw
    // 重写失败（闸门回滚）→ 退回追加，保证信息不丢
    if (!rw.ok) {
      const parent = db.prepare('SELECT id,title,body_md FROM story WHERE id=?').get(g.storyId)
      if (parent?.body_md) {
        const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
        db.exec('BEGIN IMMEDIATE')
        try { for (const fid of factIds) insSf.run(parent.id, fid, null, 0, 0, 'update', 0); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
        result.fallbackAppend = factIds.length
      }
    }
    // supersede 标记
    for (const s of cls.supersedes || []) db.prepare('UPDATE fact SET superseded_by=? WHERE id=?').run(s.new, s.old)
  } else if (cls.action === 'consolidate') {
    // 小 Story 的追加堆积直接整篇重写（合并成一段即可）
    const parentChars2 = db.prepare('SELECT length(body_md) n FROM story WHERE id=?').get(g.storyId)?.n || 0
    if (parentChars2 < 1000) {
      const small = await rewriteSmallStory({ db, storyId: g.storyId, newFactIds: factIds })
      if (small.ok) {
        result.rewrite = small
        for (const rr of g.rows) db.prepare('UPDATE story_update SET severity=?,action=?,reason=? WHERE id=?').run(cls.severity, 'rewrite_small', JSON.stringify(cls.reasons), rr.id)
        report.push({ story: g.storyId, rows: g.rows.length, ...result })
        continue
      }
      result.smallAttempt = small
    }
    const cs = await consolidateSections({ db, storyId: g.storyId })
    result.consolidate = cs
    if (!cs.ok) {
      // 合并失败 → 追加兜底
      const parent = db.prepare('SELECT id,body_md FROM story WHERE id=?').get(g.storyId)
      if (parent?.body_md) {
        const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
        db.exec('BEGIN IMMEDIATE')
        try { for (const fid of factIds) insSf.run(g.storyId, fid, null, 0, 0, 'update', 0); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
        result.fallbackAppend = factIds.length
      }
    }
  } else if (cls.action === 'split') {
    // 拆分是把这一坨事实搬到新 Story，不是往正文后面贴。以前跟 append 写在同一分支，
    // 判决是 split 也照 append 执行，等于把"该拆"悄悄降级成"越写越长"。
    result.splitPending = factIds.length
  } else if (cls.action === 'append') {
    const parent = db.prepare('SELECT id,title,body_md FROM story WHERE id=?').get(g.storyId)
    if (parent?.body_md) {
      const gapFacts = db.prepare(`SELECT id,canonical_text FROM fact WHERE id IN (${factIds.map(() => '?').join(',')})`).all(...factIds)
      const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
      db.exec('BEGIN IMMEDIATE')
      try { for (const f of gapFacts) insSf.run(parent.id, f.id, null, 0, 0, 'update', 0); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
      result.appended = gapFacts.length
    }
  }
  const applied = cls.action === 'split' ? 'split_pending' : cls.action
  for (const rr of g.rows) db.prepare('UPDATE story_update SET severity=?,action=?,reason=? WHERE id=?').run(cls.severity, applied, JSON.stringify(cls.reasons), rr.id)
  report.push({ story: g.storyId, rows: g.rows.length, ...result, cls: { gap: cls.gapCount, retraction: cls.retraction, lede: cls.lede, split: cls.split, sections: cls.updateSections, dupRisk: cls.dupRisk } })
}
for (const x of report) {
  const t = db.prepare('SELECT title FROM story WHERE id=?').get(x.story)
  console.log(`\n${x.severity} ${x.action.padEnd(7)} | ${(t?.title || x.story).slice(0, 40)}`)
  console.log('  reasons:', JSON.stringify(x.reasons))
  if (x.rewrite) console.log('  rewrite:', JSON.stringify(x.rewrite))
  if (x.appended) console.log('  appended facts:', x.appended)
}
db.close()
