// 列表页与统计页的查询（首页 / 主题 / 搜索页 / 数据质量 / 审计 / 立场 / 简报）。

import { all, one, statement, inList, TS, clampInt, STREAM_LIMIT_DEFAULT, STREAM_LIMIT_MAX, CARD_CLAIMS, STORY_CLAIMS_MAX, ENTITY_CLAIMS_MAX } from '../db.mjs'
import { decorateClaim, attachEntities, parseJsonSafe, placeholders, NOW } from '../shared.mjs'
import { search } from './search.mjs'
import { num, toTs, kindMeta, confPct, confLabel, statusLabel, typeLabel, relLabel, dateLabel, timeRangeLabel, viewLabel, durationLabel, frameUrl, mmss } from '../views/fmt.mjs'

// ── /api/stats ──────────────────────────────────────────────────────────
export function getStats() {
  const row = one(`SELECT
      (SELECT COUNT(*) FROM item)         AS items,
      (SELECT COUNT(*) FROM story)        AS stories,
      (SELECT COUNT(*) FROM claim)        AS claims,
      (SELECT COUNT(*) FROM entity)       AS entities,
      (SELECT COUNT(*) FROM item_segment) AS segments,
      (SELECT COUNT(*) FROM frame)        AS frames`)
  return {
    items: Number(row?.items ?? 0),
    stories: Number(row?.stories ?? 0),
    claims: Number(row?.claims ?? 0),
    entities: Number(row?.entities ?? 0),
    segments: Number(row?.segments ?? 0),
    frames: Number(row?.frames ?? 0)
  }
}

// ── /api/stream ─────────────────────────────────────────────────────────
const STORY_ROW_SQL = `
  SELECT s.id, s.title, s.status, s.story_kind, s.merged_into, s.category, s.item_count, s.first_seen_ts, s.last_update_ts,
         s.anchor, s.validated,
         (SELECT score FROM story_qa WHERE story_id = s.id) AS qa_score,
         COALESCE(
           ${TS('s.last_update_ts')},
           (SELECT MAX(${TS('i.published_ts')}) FROM story_item si JOIN item i ON i.id = si.item_id
             WHERE si.story_id = s.id),
           0
         ) AS sort_ts,
         COALESCE(
           ${TS('s.first_seen_ts')},
           (SELECT MIN(${TS('i.published_ts')}) FROM story_item si JOIN item i ON i.id = si.item_id
             WHERE si.story_id = s.id),
           0
         ) AS first_ts,
         (SELECT COUNT(*) FROM claim c WHERE c.story_id = s.id AND c.is_meta = 0) AS claim_count,
         (SELECT COUNT(*) FROM story_update u WHERE u.story_id = s.id AND u.at > COALESCE(
            (SELECT frontier_at FROM knowledge_state ks WHERE ks.scope='story' AND ks.ref_id=s.id),
            '1970-01-01T00:00:00.000Z')) AS pending_updates
  FROM story s
  WHERE (s.status IS NULL OR s.status != 'duplicate')
    AND (s.story_kind IS NULL OR s.story_kind = 'story')`

export function getStream({ offset = 0, limit = STREAM_LIMIT_DEFAULT, sort = 'recent', filter = 'all' } = {}) {
  const lim = clampInt(limit, 1, STREAM_LIMIT_MAX, STREAM_LIMIT_DEFAULT)
  const off = clampInt(offset, 0, 1e9, 0)
  const normalizedSort = sort === 'claims' ? 'claims' : 'recent'
  const unseenOnly = filter === 'unseen'
  const orderBy = normalizedSort === 'claims'
    ? 'claim_count DESC, sort_ts DESC, s.id ASC'
    : 'sort_ts DESC, claim_count DESC, s.id ASC'

  const countSql = `SELECT COUNT(*) AS c FROM story s WHERE (s.status IS NULL OR s.status != 'duplicate') AND (s.story_kind IS NULL OR s.story_kind = 'story') AND (s.id IN (SELECT story_id FROM story_update u2 WHERE u2.at > COALESCE((SELECT frontier_at FROM knowledge_state ks WHERE ks.scope='story' AND ks.ref_id=s.id), '1970-01-01T00:00:00.000Z')))`
  const total = Number(one("SELECT COUNT(*) AS c FROM story WHERE (status IS NULL OR status != 'duplicate') AND (story_kind IS NULL OR story_kind = 'story')")?.c ?? 0)
  const rows = unseenOnly
    ? all(`${STORY_ROW_SQL} AND s.id IN (SELECT u2.story_id FROM story_update u2 WHERE u2.at > COALESCE((SELECT ks.frontier_at FROM knowledge_state ks WHERE ks.scope='story' AND ks.ref_id=s.id), '1970-01-01T00:00:00.000Z')) ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [lim, off])
    : all(`${STORY_ROW_SQL} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [lim, off])

  const ids = rows.map((r) => r.id)
  const claimMap = new Map()
  const topicMap = new Map()
  const itemMap = new Map()

  if (ids.length) {
    const ph = placeholders(ids)

    // 每张卡 5 条最有代表性的 claim：confidence 优先，同分时事实类优先
    const claimRows = all(
      `SELECT * FROM (
         SELECT c.story_id, c.id, c.text, c.kind, c.confidence,
                ROW_NUMBER() OVER (
                  PARTITION BY c.story_id
                  ORDER BY c.confidence DESC, (c.kind = 'fact') DESC, c.id
                ) AS rn
         FROM claim c
         WHERE c.is_meta = 0 AND c.story_id IN (${ph})
       ) WHERE rn <= ? ORDER BY story_id, rn`,
      [...ids, CARD_CLAIMS]
    )
    for (const row of claimRows) {
      const list = claimMap.get(row.story_id) ?? []
      list.push({
        id: row.id,
        text: row.text ?? '',
        kind: row.kind ?? null,
        kind_label: kindMeta(row.kind).label,
        kind_cls: kindMeta(row.kind).cls,
        confidence: num(row.confidence),
        confidence_pct: confPct(row.confidence)
      })
      claimMap.set(row.story_id, list)
    }

    // 涉及的 B 站标签（每卡最多 6 个）
    const topicRows = all(
      `SELECT si.story_id AS story_id, t.name AS name, COUNT(*) AS c
       FROM story_item si
       JOIN item_topic it ON it.item_id = si.item_id
       JOIN topic t ON t.id = it.topic_id
       WHERE si.story_id IN (${ph})
       GROUP BY si.story_id, t.id
       ORDER BY si.story_id, c DESC, t.name`,
      ids
    )
    for (const row of topicRows) {
      const list = topicMap.get(row.story_id) ?? []
      if (list.length < 6 && !list.includes(row.name)) list.push(row.name)
      topicMap.set(row.story_id, list)
    }

    // 卡片副标题：最早/最多 2 个条目，便于识别 "未识别BVxxx" 这类泛标题
    const itemRows = all(
      `SELECT * FROM (
         SELECT si.story_id AS story_id, i.id, i.title, i.author, i.published_ts,
                ROW_NUMBER() OVER (
                  PARTITION BY si.story_id
                  ORDER BY (i.published_ts IS NULL), i.published_ts ASC, i.id ASC
                ) AS rn
         FROM story_item si JOIN item i ON i.id = si.item_id
         WHERE si.story_id IN (${ph})
       ) WHERE rn <= 2 ORDER BY story_id, rn`,
      ids
    )
    for (const row of itemRows) {
      const list = itemMap.get(row.story_id) ?? []
      list.push({
        id: row.id,
        title: row.title || '未命名条目',
        author: row.author || '',
        published_label: row.published_ts ? dateLabel(row.published_ts) : ''
      })
      itemMap.set(row.story_id, list)
    }
  }

  const stories = rows.map((row) => ({
    id: row.id,
    title: row.title || '未命名事件',
    status: row.status ?? null,
    status_label: statusLabel(row.status),
    anchor: row.anchor || '',
    validated: Number(row.validated ?? 0) === 1,
    item_count: Number(row.item_count ?? 0),
    claim_count: Number(row.claim_count ?? 0),
    pending_updates: Number(row.pending_updates ?? 0),
    first_ts: toTs(row.first_ts) || null,
    last_ts: toTs(row.sort_ts) || null,
    first_label: dateLabel(row.first_ts),
    last_label: dateLabel(row.sort_ts),
    updated_label: relLabel(row.sort_ts, NOW()),
    claims: claimMap.get(row.id) ?? [],
    topics: topicMap.get(row.id) ?? [],
    items: itemMap.get(row.id) ?? [],
    bucket: (() => {
      const pd = Number(row.pending_updates ?? 0)
      if (pd > 0) return 'unseen'
      const ts = toTs(row.sort_ts)
      if (!ts) return 'older'
      const age = (Date.now() / 1000 - ts) / 86400
      return age <= 1 ? 'today' : age <= 7 ? 'week' : 'older'
    })(),
    url: `/story/${encodeURIComponent(row.id)}`
  }))

  return {
    offset: off,
    limit: lim,
    total,
    sort: normalizedSort,
    filter: unseenOnly ? 'unseen' : 'all',
    total_unseen: unseenOnly ? stories.length + off : undefined,
    has_more: off + stories.length < total,
    stories
  }
}


// ── /topics：覆盖地图 + /topic/:name 详情 ───────────────────────────────
export function getTopics () {
  const rows = all(`
    SELECT t.id, t.name, COUNT(DISTINCT si.story_id) stories, COUNT(DISTINCT c.id) claims,
      COUNT(DISTINCT i.source_id) sources, MAX(i.published_ts) last_ts
    FROM topic t JOIN item_topic it ON it.topic_id=t.id JOIN item i ON i.id=it.item_id
    LEFT JOIN story_item si ON si.item_id=i.id LEFT JOIN claim c ON c.item_id=i.id AND c.is_meta=0
    GROUP BY t.id ORDER BY stories DESC, claims DESC LIMIT 100`)
  const interestSet = new Set(all('SELECT topic FROM interest').map(r => r.topic))
  return rows.map(r => {
    const age = r.last_ts ? Math.round((Date.now() / 1000 - r.last_ts) / 86400) : null
    let gap = null
    if (r.stories === 0) gap = 'no-story'
    else if (r.sources <= 1) gap = 'single-source'
    else if (r.claims < 10) gap = 'thin'
    else if (age != null && age > 14) gap = 'stale'
    return { ...r, last_days: age, gap, interested: interestSet.has(r.name) }
  })
}
export function getTopicPage (name) {
  const t = one('SELECT id,name FROM topic WHERE name=?', [name])
  if (!t) return null
  const stories = all(`SELECT DISTINCT s.id,s.title,s.category,s.last_update_ts FROM story_item si
    JOIN item_topic it ON it.item_id=si.item_id JOIN story s ON s.id=si.story_id
    WHERE it.topic_id=? ORDER BY s.last_update_ts DESC LIMIT 30`, [t.id])
  const sources = all(`SELECT s.name, COUNT(DISTINCT i.id) n FROM item i JOIN item_topic it ON it.item_id=i.id
    JOIN source s ON s.id=i.source_id WHERE it.topic_id=? GROUP BY s.id ORDER BY n DESC LIMIT 10`, [t.id])
  const interest = one('SELECT * FROM interest WHERE topic=?', [name])
  return { topic: t, stories, sources, interest }
}
export function getLatestBeat () {
  const row = one('SELECT * FROM beat_report ORDER BY generated_at DESC LIMIT 1')
  if (!row) return null
  let findings = []
  try { findings = JSON.parse(row.findings_json || '[]') } catch {}
  return { id: row.id, generated_at: row.generated_at, findings }
}

// ── /search：搜索页 ────────────────────────────────────────────────────
export function getSearchPage (q) {
  const data = search(q, 30)
  return { q, ...data }
}

// ── /claims：数据质量页（有争议/被取代/低置信/缺证据）──────────────────
export function getClaimIssues ({ limit = 40 } = {}) {
  const contested = all(`SELECT c.id,c.text,c.confidence,c.status,i.title AS item_title,s2.title AS story_title
    FROM claim c LEFT JOIN item i ON i.id=c.item_id LEFT JOIN story s2 ON s2.id=c.story_id
    WHERE c.status='contested' ORDER BY c.confidence ASC LIMIT ?`, [limit])
  const superseded = all(`SELECT f.id,f.canonical_text,f.superseded_by,f.support_count FROM fact f
    WHERE f.superseded_by IS NOT NULL ORDER BY f.last_updated DESC LIMIT ?`, [limit])
  const lowConf = all(`SELECT c.id,c.text,c.confidence,i.title AS item_title,s2.title AS story_title
    FROM claim c LEFT JOIN item i ON i.id=c.item_id LEFT JOIN story s2 ON s2.id=c.story_id
    WHERE c.confidence < 0.5 AND c.is_meta=0 ORDER BY c.confidence ASC LIMIT ?`, [limit])
  const noEvidence = Number(one(`SELECT COUNT(*) c FROM claim c WHERE c.is_meta=0 AND NOT EXISTS (SELECT 1 FROM claim_evidence e WHERE e.claim_id=c.id)`)?.c ?? 0)
  const totals = {
    claims: Number(one('SELECT COUNT(*) c FROM claim')?.c ?? 0),
    contested: Number(one("SELECT COUNT(*) c FROM claim WHERE status='contested'")?.c ?? 0),
    superseded: Number(one('SELECT COUNT(*) c FROM fact WHERE superseded_by IS NOT NULL')?.c ?? 0),
    lowConf: Number(one("SELECT COUNT(*) c FROM claim WHERE confidence < 0.5 AND is_meta=0")?.c ?? 0),
    needsRecheck: Number(one("SELECT COUNT(*) c FROM claim WHERE status='needs_recheck'")?.c ?? 0),
    noEvidence
  }
  return { contested, superseded, lowConf, totals }
}

// ── /audit：为什么没推 / 漏了什么 / 源健康 / token 账本 / 标注消费率 ──
export function getAudit ({ limit = 30 } = {}) {
  const adapters = all('SELECT adapter, MAX(checked_at) checked_at, ok, latency_ms, detail FROM adapter_health GROUP BY adapter ORDER BY checked_at DESC')
  const latestBrief = one('SELECT id,date,generated_at,items_json,stats_json FROM briefing ORDER BY generated_at DESC LIMIT 1')
  let briefIds = []
  if (latestBrief) { try { briefIds = JSON.parse(latestBrief.items_json || '[]').map(i => i.story_id) } catch {} }
  const pendingStories = all(`SELECT s.id,s.title,COUNT(u.id) n,MAX(u.at) last_at
    FROM story s JOIN story_update u ON u.story_id=s.id
    WHERE u.at > COALESCE((SELECT ks.frontier_at FROM knowledge_state ks WHERE ks.scope='story' AND ks.ref_id=s.id),'1970-01-01T00:00:00.000Z')
      AND (s.status IS NULL OR s.status!='duplicate')
    GROUP BY s.id ORDER BY n DESC LIMIT ?`, [limit])
  const skipped = pendingStories.filter(p => !briefIds.includes(p.id))
  const tokens = all(`SELECT task, COUNT(*) n, SUM(total_tokens) total, SUM(cost) cost FROM token_ledger GROUP BY task ORDER BY total DESC`)
  const dayTokens = all(`SELECT substr(at,1,10) d, SUM(total_tokens) total FROM token_ledger GROUP BY d ORDER BY d DESC LIMIT 7`)
  const annTotal = Number(one('SELECT COUNT(*) c FROM annotation')?.c ?? 0)
  const annByKind = all('SELECT kind, COUNT(*) n FROM annotation GROUP BY kind')
  const consumed = {
    known: Number(one("SELECT COUNT(*) c FROM annotation WHERE kind IN ('known','read')")?.c ?? 0),
    wrong: Number(one("SELECT COUNT(*) c FROM annotation WHERE kind='wrong'")?.c ?? 0),
    stance: Number(one("SELECT COUNT(*) c FROM annotation WHERE kind IN ('agree','disagree')")?.c ?? 0)
  }
  const consumedCount = Number(one(`SELECT COUNT(*) c FROM annotation a WHERE
    (a.kind IN ('known','read') AND EXISTS (SELECT 1 FROM knowledge_state ks WHERE ks.ref_id=a.target_id AND ks.source='user'))
    OR (a.kind='wrong' AND EXISTS (SELECT 1 FROM claim c WHERE c.id=a.target_id AND c.status='contested'))
    OR (a.kind IN ('agree','disagree') AND EXISTS (SELECT 1 FROM stance st WHERE st.target_id=a.target_id))`)?.c ?? 0)
  const effectsApplied = consumedCount
  const sourceQuality = all(`SELECT sq.*, s.name FROM source_quality sq LEFT JOIN source s ON s.id=sq.source_id ORDER BY sq.score DESC LIMIT 20`)
  const metricsRow = one('SELECT metrics_json, at FROM metric_snapshot ORDER BY at DESC LIMIT 1')
  let metrics = null
  if (metricsRow) { try { metrics = { at: metricsRow.at, ...JSON.parse(metricsRow.metrics_json || '{}') } } catch {} }
  const ontologyPending = all("SELECT id,kind,payload_json,created_at FROM ontology_proposal WHERE status='pending' ORDER BY created_at DESC LIMIT 15")
  const recheckCount = Number(one("SELECT COUNT(*) c FROM claim WHERE status='needs_recheck'")?.c ?? 0)
  return { adapters, latestBrief: latestBrief ? { id: latestBrief.id, date: latestBrief.date, generated_at: latestBrief.generated_at, count: briefIds.length } : null, pendingStories, skipped, tokens, dayTokens, annotations: { total: annTotal, byKind: annByKind, consumed, effectsApplied }, sourceQuality, metrics, ontologyPending, recheckCount }
}

// ── /stance：我的立场 ───────────────────────────────────────────────────
export function getStances (limit = 40) {
  const rows = all("SELECT * FROM stance ORDER BY updated_at DESC LIMIT ?", [limit])
  return rows.map(st => ({
    ...st,
    history: all('SELECT position, rationale, at FROM stance_revision WHERE stance_id=? ORDER BY at ASC', [st.id]),
    target_title: st.target_type === 'story'
      ? (one('SELECT title FROM story WHERE id=?', [st.target_id])?.title ?? '')
      : (one('SELECT name FROM entity WHERE id=?', [st.target_id])?.name ?? '')
  }))
}
export function getAnnotationStats () {
  const byKind = all('SELECT kind, COUNT(*) n FROM annotation GROUP BY kind')
  return { total: byKind.reduce((a, r) => a + r.n, 0), byKind }
}

// ── /brief：最新简报 ────────────────────────────────────────────────────
export function getLatestBriefing () {
  const row = one('SELECT * FROM briefing ORDER BY generated_at DESC LIMIT 1')
  if (!row) return null
  let items = []
  let stats = {}
  try { items = JSON.parse(row.items_json || '[]') } catch {}
  try { stats = JSON.parse(row.stats_json || '{}') } catch {}
  return { id: row.id, date: row.date, generated_at: row.generated_at, window_hours: row.window_hours, items, stats }
}

