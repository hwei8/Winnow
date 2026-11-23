// delivery/brief.mjs — IM 简报：从 story_update + knowledge_state 生成 12 条三通道简报
import { randomUUID } from 'node:crypto'
import { openDb, nowIso } from '../../shared/db.mjs'
import { chat, extractJson } from '../../providers/llm.mjs'
import { localDate, PUBLIC_URL } from '../../shared/config.mjs'

const CHANNELS = { must: '必看', interest: '兴趣', explore: '探索' }

// 1) 收集候选：窗口内或"自上次阅读以来"的 story 更新
export function collectCandidates (db, { hours = 24, limit = 120 } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  const rows = db.prepare(`
    SELECT u.id AS update_id, u.story_id, u.at, u.change_type, u.severity, u.action, u.detail_json,
           s.title, s.category, s.body_md,
           (SELECT COUNT(DISTINCT f.id) FROM story_fact sf JOIN fact f ON f.id=sf.fact_id WHERE sf.story_id=s.id) AS facts,
           (SELECT COUNT(*) FROM story_update u2 WHERE u2.story_id=s.id AND u2.at > ?) AS pending,
           ks.level AS known_level, ks.frontier_at
    FROM story_update u
    JOIN story s ON s.id = u.story_id
    LEFT JOIN knowledge_state ks ON ks.scope='story' AND ks.ref_id=s.id
    WHERE u.at >= ? AND (s.status IS NULL OR s.status!='duplicate')
    ORDER BY u.at DESC LIMIT ?`).all('1970-01-01T00:00:00.000Z', since, limit)
  // 新出现的故事（窗口内首次入库，且没有窗口内 update）——简报要能报"新面孔"
  const freshRows = db.prepare(`
    SELECT s.id AS story_id, s.first_seen_ts, s.title, s.category, s.body_md,
           (SELECT COUNT(DISTINCT f.id) FROM story_fact sf JOIN fact f ON f.id=sf.fact_id WHERE sf.story_id=s.id) AS facts,
           ks.level AS known_level, ks.frontier_at
    FROM story s
    LEFT JOIN knowledge_state ks ON ks.scope='story' AND ks.ref_id=s.id
    WHERE s.first_seen_ts >= ? AND (s.status IS NULL OR s.status!='duplicate')
      AND NOT EXISTS (SELECT 1 FROM story_update u2 WHERE u2.story_id=s.id AND u2.at >= ?)
    ORDER BY s.first_seen_ts DESC LIMIT ?`).all(Math.floor(new Date(since).getTime() / 1000), since, limit)
    .map(r => ({
      update_id: 'new:' + r.story_id, story_id: r.story_id, at: new Date(r.first_seen_ts * 1000).toISOString(),
      change_type: 'new_story', severity: null, action: null, detail_json: null,
      title: r.title, category: r.category, body_md: r.body_md, facts: r.facts, pending: 0,
      known_level: r.known_level, frontier_at: r.frontier_at
    }))
  rows.push(...freshRows)

  // 同一 story 可能多条 update：聚合
  const byStory = new Map()
  for (const r of rows) {
    const cur = byStory.get(r.story_id) || { ...r, updates: [] }
    cur.updates.push({ id: r.update_id, at: r.at, type: r.change_type, severity: r.severity, action: r.action })
    byStory.set(r.story_id, cur)
  }
  return [...byStory.values()]
}

// 2) 评分与通道分配
export function scoreCandidates (db, candidates) {
  const interests = db.prepare('SELECT topic, weight FROM interest').all()
  const interestSet = new Set(interests.map(i => i.topic))
  const knownCats = db.prepare(`SELECT s.category, COUNT(*) n FROM knowledge_state ks JOIN story s ON s.id=ks.ref_id
    WHERE ks.scope='story' AND ks.level IN ('seen','known') AND s.category IS NOT NULL GROUP BY s.category ORDER BY n DESC`).all()
  const topCats = new Set(knownCats.slice(0, 3).map(x => x.category))
  // 源质量：低质量源的故事降权，高质量源升权（±15 分内）
  const storyQuality = (storyId) => {
    const r = db.prepare(`SELECT AVG(sq.score) avg_score, COUNT(DISTINCT sq.source_id) n
      FROM story_item si JOIN item i ON i.id=si.item_id JOIN source_quality sq ON sq.source_id=i.source_id
      WHERE si.story_id=?`).get(storyId)
    return r && r.n ? r.avg_score : null
  }
  const scored = candidates.map(c => {
    let score = 0
    const sev = c.updates.map(u => u.severity).filter(Boolean)
    if (sev.includes('P0')) score += 100
    if (sev.includes('P1')) score += 60
    if (sev.includes('P2')) score += 25
    if (c.updates.some(u => u.type === 'new_story')) score += 18
    score += Math.min(20, (c.pending || 1) * 4)
    score += Math.min(10, (c.facts || 0) / 20)
    if (c.known_level === 'known') score -= 40
    if (c.known_level === 'seen') score -= 10
    if (c.category && interestSet.has(c.category)) score += 15
    if (c.category && topCats.has(c.category)) score += 8
    const q = storyQuality(c.story_id)
    if (q != null) score += Math.max(-15, Math.min(15, (q - 50) * 0.4))
    c.source_quality = q
    const recent = Date.now() - new Date(c.at).getTime()
    score += Math.max(0, 12 - recent / 3600000)
    return { ...c, score }
  }).sort((a, b) => b.score - a.score)

  // 三通道：必看 = P0/P1（不足 2 条用最高分补位）；兴趣 = 高分；探索 = 未知领域且未被占用
  const picked = new Set()
  const mustSeen = scored.filter(s => s.updates.some(u => u.severity === 'P0' || u.severity === 'P1')).slice(0, 3)
  mustSeen.forEach(s => picked.add(s.story_id))
  if (mustSeen.length < 2) {
    for (const s of scored) {
      if (mustSeen.length >= 2) break
      if (!picked.has(s.story_id) && s.pending > 0) { mustSeen.push({ ...s, fallbackMust: true }); picked.add(s.story_id) }
    }
  }
  const rest = scored.filter(s => !picked.has(s.story_id))
  const interest = []
  for (const s of rest) {
    if (interest.length >= 6) break
    if (picked.has(s.story_id)) continue
    interest.push(s); picked.add(s.story_id)
  }
  const explore = []
  for (const s of scored) {
    if (explore.length >= 2) break
    if (picked.has(s.story_id)) continue
    if (s.category && !topCats.has(s.category)) { explore.push(s); picked.add(s.story_id) }
  }
  for (const s of scored) {
    if (explore.length >= 2) break
    if (!picked.has(s.story_id)) { explore.push(s); picked.add(s.story_id) }
  }
  return { must: mustSeen, interest, explore, all: scored }
}

// 3) 生成每条简报的三行解释
export async function composeItems (db, picked) {
  const out = []
  for (const ch of ['must', 'interest', 'explore']) {
    for (const c of picked[ch] || []) {
      const roleFacts = db.prepare(`SELECT f.canonical_text FROM story_fact sf JOIN fact f ON f.id=sf.fact_id
        WHERE sf.story_id=? AND sf.role='update' LIMIT 6`).all(c.story_id).map(r => r.canonical_text)
      const detailFacts = []
      for (const u of c.updates) {
        try { const d = JSON.parse(u.detail_json || '{}'); for (const fid of d.facts || []) { const f = db.prepare('SELECT canonical_text FROM fact WHERE id=?').get(fid); if (f) detailFacts.push(f.canonical_text) } } catch {}
      }
      const latestFacts = db.prepare(`SELECT f.canonical_text FROM story_fact sf JOIN fact f ON f.id=sf.fact_id
        WHERE sf.story_id=? ORDER BY sf.order_idx DESC LIMIT 4`).all(c.story_id).map(r => r.canonical_text)
      const gapFacts = [...new Set([...roleFacts, ...detailFacts])].slice(0, 6)
      const factsForPrompt = gapFacts.length ? gapFacts : latestFacts
      const state = {
        story: c.title,
        category: c.category || '',
        channel: CHANNELS[ch],
        kind: c.updates.some(u => u.type === 'new_story') ? 'new_story' : 'update',
        updates: c.updates.slice(0, 5).map(u => ({ at: u.at, type: u.type, severity: u.severity })),
        new_facts: factsForPrompt,
        fallback_must: !!c.fallbackMust,
        known_level: c.known_level || 'unknown',
        pending: c.pending
      }
      let parsed = null
      for (let t = 1; t <= 2 && !parsed; t++) {
        try {
          const r = await chat({ json: true, maxTokens: 2000, messages: [{ role: 'user', content: `你在为一位读者写每日简报。根据下面的数据结构化输出三行：
1) what：这件事发生了什么（一句话，≤40 字）
2) what_new：相比他上次看到，新在哪（一句话，≤40 字；必须具体到新增事实/数字/阶段）。若数据 kind=new_story（他此前没见过这条线），改为说明"它补上了哪块信息/为什么现在值得认识"，不得假装有更新。
3) why_you：为什么推给他（一句话，≤40 字；必看通道说明重要性，探索通道说明这是不同视角/你不知道的领域）
不要编造，只能基于数据。只输出 JSON：{"what":"...","what_new":"...","why_you":"..."}

数据：
${JSON.stringify(state, null, 1)}` }] })
          const p = extractJson(r.content)
          if (p && p.what && p.what_new && p.why_you) parsed = p
        } catch {}
      }
      out.push({
        channel: ch, channel_label: CHANNELS[ch], story_id: c.story_id, title: c.title,
        category: c.category || '', severity: c.updates.map(u => u.severity).filter(Boolean).slice(-1)[0] || null,
        pending: c.pending, facts: c.facts,
        what: parsed?.what || '', what_new: parsed?.what_new || '', why_you: parsed?.why_you || '',
        at: c.at
      })
    }
  }
  return out
}

// 4) 渲染 Markdown（IM 风格）
export function renderBriefing ({ items, stats, date }) {
  const byCh = { must: items.filter(i => i.channel === 'must'), interest: items.filter(i => i.channel === 'interest'), explore: items.filter(i => i.channel === 'explore') }
  const lines = [`# 今日简报 ${date}`, '',
    `> 候选 ${stats?.candidates ?? items.length} 条 · 选出 ${items.length} 条（必看 ${byCh.must.length} · 兴趣 ${byCh.interest.length} · 探索 ${byCh.explore.length}）`, '']
  for (const [ch, label] of [['must', '■ 必看（不可被兴趣挤掉）'], ['interest', '■ 兴趣'], ['explore', '■ 探索（今天的分歧视角）']]) {
    if (!byCh[ch].length) continue
    lines.push(label, '')
    byCh[ch].forEach((it, i) => {
      lines.push(`${i + 1}. [${it.category || '事件'}] ${it.title}`)
      if (it.what) lines.push(`   发生了什么：${it.what}`)
      if (it.what_new) lines.push(`   新在哪：${it.what_new}`)
      if (it.why_you) lines.push(`   为什么推你：${it.why_you}`)
      lines.push(`   来源：${PUBLIC_URL}/story/${encodeURIComponent(it.story_id)}`)
      lines.push('')
    })
  }
  return lines.join('\n')
}

// 5) 生成并落库
export async function generateBriefing (db, { hours = 24, count = 12 } = {}) {
  const cands = collectCandidates(db, { hours })
  const picked = scoreCandidates(db, cands)
  const items = await composeItems(db, picked)
  const date = localDate()
  const id = 'brief:' + randomUUID().slice(0, 10)
  const stats = { candidates: cands.length, must: items.filter(i => i.channel === 'must').length, interest: items.filter(i => i.channel === 'interest').length, explore: items.filter(i => i.channel === 'explore').length }
  db.prepare('INSERT OR REPLACE INTO briefing(id,date,generated_at,window_hours,items_json,stats_json) VALUES (?,?,?,?,?,?)')
    .run(id, date, nowIso(), hours, JSON.stringify(items), JSON.stringify(stats))
  return { id, date, items, stats, markdown: renderBriefing({ items, stats, date }) }
}
