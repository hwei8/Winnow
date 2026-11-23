// insights/beat.mjs — Beat Reporter：覆盖地图 + 缺口发现 + 漏掉的文章
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../shared/db.mjs'
import { aliasesFor } from '../knowledge/alias.mjs'

// 1) 覆盖地图：按 topic 汇总（stories/claims/来源数/最近更新/缺口标记）
export function coverageMap (db, { limit = 60 } = {}) {
  const rows = db.prepare(`
    SELECT t.id, t.name,
      COUNT(DISTINCT si.story_id) stories,
      COUNT(DISTINCT c.id) claims,
      COUNT(DISTINCT i.source_id) sources,
      MAX(i.published_ts) last_ts
    FROM topic t
    JOIN item_topic it ON it.topic_id = t.id
    JOIN item i ON i.id = it.item_id
    LEFT JOIN story_item si ON si.item_id = i.id
    LEFT JOIN claim c ON c.item_id = i.id AND c.is_meta = 0
    GROUP BY t.id ORDER BY stories DESC, claims DESC LIMIT ?`).all(limit)
  const interests = new Set(db.prepare('SELECT topic FROM interest').all().map(r => r.topic))
  return rows.map(r => {
    const ageDays = r.last_ts ? (Date.now() / 1000 - r.last_ts) / 86400 : null
    let gap = null
    if (r.stories === 0) gap = 'no-story'
    else if (r.sources <= 1) gap = 'single-source'
    else if (r.claims < 10) gap = 'thin'
    else if (ageDays != null && ageDays > 14) gap = 'stale'
    return { ...r, last_days: ageDays != null ? Math.round(ageDays) : null, gap, interested: interests.has(r.name) }
  })
}

// 2) 单 topic 详情
export function topicDetail (db, name) {
  const t = db.prepare('SELECT id,name FROM topic WHERE name=?').get(name)
  if (!t) return null
  const stories = db.prepare(`SELECT DISTINCT s.id,s.title,s.category,s.last_update_ts,
      (SELECT COUNT(DISTINCT fact_id) FROM story_fact WHERE story_id=s.id) facts
    FROM story_item si JOIN item_topic it ON it.item_id=si.item_id JOIN story s ON s.id=si.story_id
    WHERE it.topic_id=? ORDER BY s.last_update_ts DESC LIMIT 30`).all(t.id)
  const sources = db.prepare(`SELECT s.name, COUNT(DISTINCT i.id) n FROM item i JOIN item_topic it ON it.item_id=i.id
    JOIN source s ON s.id=i.source_id WHERE it.topic_id=? GROUP BY s.id ORDER BY n DESC LIMIT 10`).all(t.id)
  const stats = {
    stories: stories.length,
    claims: Number(db.prepare(`SELECT COUNT(DISTINCT c.id) c FROM claim c JOIN item_topic it ON it.item_id=c.item_id WHERE it.topic_id=?`).get(t.id).c),
    sources: sources.length,
    interest: db.prepare('SELECT * FROM interest WHERE topic=?').get(name) || null
  }
  return { topic: t, stats, stories, sources }
}

// 3) Beat 报告：兴趣主题的覆盖缺口 + HN 上未收录的候选文章
export async function beatReport (db, { limit = 8 } = {}) {
  const interests = db.prepare('SELECT topic, weight FROM interest ORDER BY weight DESC').all()
  const topics = interests.length ? interests.map(i => i.topic) : coverageMap(db, { limit: 12 }).filter(t => t.stories > 0).slice(0, 6).map(t => t.name)
  const findings = []
  for (const topic of topics) {
    let cov = coverageMap(db, { limit: 200 }).find(t => t.name === topic)
    if (!cov || cov.stories === 0) {
      // 兴趣可能不是 topic 表里的标签：按标题模糊匹配估算覆盖
      const like = `%${topic}%`
      const rows = db.prepare(`SELECT COUNT(DISTINCT s.id) stories FROM story s WHERE s.title LIKE ?`).get(like)
      const claims = db.prepare(`SELECT COUNT(*) c FROM claim WHERE text LIKE ?`).get(like).c
      cov = { name: topic, stories: rows.stories, claims, sources: 0, last_days: null, gap: rows.stories === 0 ? 'no-coverage' : (claims < 10 ? 'thin' : null) }
    }
    const known = new Set(db.prepare('SELECT title FROM item').all().map(r => String(r.title || '').toLowerCase().slice(0, 40)))
    const missing = []
    const aliases = aliasesFor(db, topic)
    const queries = [...new Set([topic, ...aliases])].slice(0, 4)
    for (const q of queries) {
      try {
        const r = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=6`, { signal: AbortSignal.timeout(15000) })
        const d = await r.json()
        for (const h of d.hits || []) {
          if (!h.url || /twitter\.com|x\.com|youtube\.com/.test(h.url)) continue
          const key = String(h.title || '').toLowerCase().slice(0, 40)
          if (known.has(key)) continue
          if (missing.some(m => m.url === h.url)) continue
          missing.push({ title: h.title, url: h.url, at: h.created_at?.slice(0, 10), via: q })
        }
      } catch {}
    }
    findings.push({
      topic,
      coverage: { stories: cov.stories, claims: cov.claims, sources: cov.sources, last_days: cov.last_days, gap: cov.gap },
      headline_only: db.prepare(`SELECT s.id,s.title FROM story s JOIN story_item si ON si.story_id=s.id
        JOIN item_topic it ON it.item_id=si.item_id JOIN topic t ON t.id=it.topic_id
        WHERE t.name=? AND length(s.body_md)<400 LIMIT 3`).all(topic),
      missing: missing.slice(0, 4),
      suggestions: cov.gap === 'single-source' ? ['source: 补充第二来源']
        : cov.gap === 'stale' ? ['refresh: 14 天无更新，建议重扫']
        : cov.gap === 'thin' ? ['deepen: 抓正文/补 claim']
        : missing.length ? ['ingest: 有未收录文章'] : []
    })
  }
  const id = 'beat:' + randomUUID().slice(0, 10)
  db.prepare('INSERT INTO beat_report(id,generated_at,topics_json,findings_json) VALUES (?,?,?,?)').run(id, nowIso(), JSON.stringify(topics), JSON.stringify(findings))
  return { id, generated_at: nowIso(), topics, findings }
}

export function addInterest (db, topic, weight = 1.0) {
  db.prepare(`INSERT INTO interest(topic,weight,created_at) VALUES (?,?,?)
    ON CONFLICT(topic) DO UPDATE SET weight=excluded.weight`).run(topic, weight, nowIso())
  return db.prepare('SELECT * FROM interest WHERE topic=?').get(topic)
}

export function listInterests (db) {
  return db.prepare('SELECT * FROM interest ORDER BY weight DESC, created_at DESC').all()
}
