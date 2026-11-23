// memory/depth.mjs — 三轴下探：时间线（回溯）/ 证据层级 / L4 深研（按需生成并缓存）
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../shared/db.mjs'
import { chat } from '../../providers/llm.mjs'

export function getTimeline (db, storyId, { limit = 40 } = {}) {
  const updates = db.prepare(`SELECT id, at, change_type, severity, action, detail_json FROM story_update WHERE story_id=? ORDER BY at DESC LIMIT ?`).all(storyId, limit)
  const items = db.prepare(`SELECT i.id, i.title, i.published_at, i.published_ts, i.url, si.role FROM story_item si JOIN item i ON i.id=si.item_id WHERE si.story_id=? ORDER BY (i.published_ts IS NULL), i.published_ts ASC`).all(storyId)
  return {
    updates: updates.map(u => ({ id: u.id, at: u.at, type: u.change_type, severity: u.severity, action: u.action })),
    sources: items
  }
}

export function getEvidence (db, storyId, { limit = 30 } = {}) {
  const claims = db.prepare(`
    SELECT c.id, c.text, c.kind, c.confidence, c.status, i.title AS item_title, i.url AS item_url,
           e.excerpt, e.verified
    FROM claim c LEFT JOIN item i ON i.id=c.item_id
    LEFT JOIN claim_evidence e ON e.rowid=(SELECT x.rowid FROM claim_evidence x WHERE x.claim_id=c.id ORDER BY x.verified DESC, x.segment_from ASC LIMIT 1)
    WHERE c.story_id=? AND c.is_meta=0 ORDER BY c.confidence DESC, c.id LIMIT ?`).all(storyId, limit)
  return claims
}

export async function getOrCreateResearch (db, storyId, { force = false, kind = 'deep' } = {}) {
  if (!force) {
    const cached = db.prepare("SELECT * FROM research WHERE story_id=? AND kind=? ORDER BY created_at DESC LIMIT 1").get(storyId, kind)
    if (cached) return { cached: true, ...cached }
  }
  const story = db.prepare('SELECT id,title,body_md,category FROM story WHERE id=?').get(storyId)
  if (!story) throw new Error('story not found')
  const timeline = getTimeline(db, storyId)
  const claims = getEvidence(db, storyId, { limit: 12 })
  const facts = db.prepare(`SELECT f.canonical_text FROM story_fact sf JOIN fact f ON f.id=sf.fact_id WHERE sf.story_id=? LIMIT 30`).all(storyId).map(r => r.canonical_text)
  const material = JSON.stringify({
    timeline: timeline.updates.slice(0, 15),
    sources: timeline.sources.map(s => ({ title: s.title, source: s.role })),
    claims: claims.map(c => ({ text: c.text, confidence: c.confidence, status: c.status })),
    facts
  }, null, 1)
  const prompt = kind === 'contrast'
    ? `你是多源对照编辑。基于以下素材，为「${story.title}」写一份 500–800 字的对照简报，结构：
## 一手信源说了什么
## 分析/评论怎么说
## 反方或质疑观点
## 三方之间不一致之处（具体到数字/表述）
## 值得继续追的线索（3 条）
要求：只依据素材，不编造；标注每条来自哪类源；用简体中文。

素材：
${material}`
    : `你是深度研究员。基于以下素材，为「${story.title}」写一份 600–900 字的深度简报，结构：
## 一句话结论
## 时间线（按时间排序的关键节点）
## 已知事实与证据强度
## 争议与未解问题
## 值得继续追的线索（3 条）
要求：只依据素材，不编造；数字照抄；用简体中文。

素材：
${material}`
  const r = await chat({ json: false, maxTokens: 4000, messages: [{ role: 'user', content: prompt }] })
  // 注意：上面 prompt 已按 kind 选择（contrast/deep）
  const id = 'res:' + randomUUID().slice(0, 10)
  const content = r.content || ''
  db.prepare('INSERT INTO research(id,story_id,kind,content,created_at) VALUES (?,?,?,?,?)').run(id, storyId, kind, content, nowIso())
  return { cached: false, id, story_id: storyId, kind, content, created_at: nowIso() }
}
