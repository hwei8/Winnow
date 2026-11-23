// 详情页查询（Story / 事实 / 实体）。

import { all, one, statement, inList, TS, clampInt, STREAM_LIMIT_DEFAULT, STREAM_LIMIT_MAX, CARD_CLAIMS, STORY_CLAIMS_MAX, ENTITY_CLAIMS_MAX } from '../db.mjs'
import { decorateClaim, attachEntities, parseJsonSafe, placeholders, NOW } from '../shared.mjs'
import { num, toTs, kindMeta, confPct, confLabel, statusLabel, typeLabel, relLabel, dateLabel, timeRangeLabel, viewLabel, durationLabel, frameUrl, mmss } from '../views/fmt.mjs'

// ── /api/story/:id ──────────────────────────────────────────────────────
const CLAIM_WITH_EVIDENCE = (whereClause, extraJoin = '') => `
  SELECT c.id, c.story_id, c.item_id, c.text, c.kind, c.confidence, c.subject,
         c.predicate, c.object_text, c.object_value_json, c.is_meta, c.status,
         e.excerpt, e.time_start, e.time_end, e.frame_id, e.verified,
         e.segment_from, e.segment_to, e.stance,
         f.path AS frame_path, f.has_subtitle AS frame_has_subtitle,
         i.title AS item_title, i.author AS item_author,
         ${TS('i.published_ts')} AS item_published_ts
  FROM claim c
  LEFT JOIN claim_evidence e ON e.rowid = (
    SELECT x.rowid FROM claim_evidence x
    WHERE x.claim_id = c.id
    ORDER BY x.verified DESC, x.segment_from ASC
    LIMIT 1
  )
  LEFT JOIN frame f ON f.id = e.frame_id
  LEFT JOIN item i ON i.id = c.item_id
  ${extraJoin}
  WHERE ${whereClause}`


export function getStory(storyId) {
  if (!storyId) return null
  const storyRow = one('SELECT * FROM story WHERE id = ?', [storyId])
  if (!storyRow) return null
  const qaRow = one('SELECT score, coverage, dup_rate, conflict_count, fact_count, missed_facts, checked_at FROM story_qa WHERE story_id = ?', [storyId])
  const updateRows = all('SELECT id, at, change_type, severity, action FROM story_update WHERE story_id = ? ORDER BY at DESC LIMIT 30', [storyId])
  const stanceRow = one("SELECT * FROM stance WHERE target_type='story' AND target_id=? ORDER BY updated_at DESC LIMIT 1", [storyId])
  const stanceHistory = stanceRow ? all('SELECT position, rationale, at FROM stance_revision WHERE stance_id=? ORDER BY at ASC', [stanceRow.id]) : []
  const annotationRows = all("SELECT kind, comment, at FROM annotation WHERE target_type='story' AND target_id=? ORDER BY at DESC LIMIT 10", [storyId])
  const researchRows = all("SELECT kind, id, content, created_at FROM research WHERE story_id=? ORDER BY created_at DESC", [storyId])
  const researchByKind = {}
  for (const r of researchRows) if (!researchByKind[r.kind]) researchByKind[r.kind] = { id: r.id, content: r.content, created_at: r.created_at }
  const mergedRow = storyRow.merged_into ? one('SELECT id, title FROM story WHERE id = ?', [storyRow.merged_into]) : null
  const ksRow = one("SELECT level, frontier_at FROM knowledge_state WHERE scope='story' AND ref_id=?", [storyId])
  const frontierAt = ksRow?.frontier_at || '1970-01-01T00:00:00.000Z'
  const pendingRows = all('SELECT id, at, change_type, severity, action FROM story_update WHERE story_id=? AND at > ? ORDER BY at ASC', [storyId, frontierAt])
  const linkRows = all('SELECT story_id, related_story_id, relation, same_event_prob, gap_count FROM story_link WHERE story_id = ? OR related_story_id = ? ORDER BY same_event_prob DESC LIMIT 8', [storyId, storyId])
  const relatedStories = linkRows.map((r) => {
    const otherId = r.related_story_id === storyId ? r.story_id : r.related_story_id
    const other = one('SELECT id, title FROM story WHERE id = ?', [otherId])
    return other ? { id: other.id, title: other.title, relation: r.relation, same_event: num(r.same_event_prob), gap: num(r.gap_count) } : null
  }).filter(Boolean)

  const itemRows = all(
    `SELECT i.id, i.title, i.author, i.published_at, i.published_ts, i.duration_sec,
            i.view_count, i.like_count, i.comment_count, i.segment_count, i.frame_count,
            i.asr_quality, i.dir, i.url, i.description, si.role
     FROM story_item si JOIN item i ON i.id = si.item_id
     WHERE si.story_id = ?
     ORDER BY (${TS('i.published_ts')} IS NULL), ${TS('i.published_ts')} ASC, i.id ASC`,
    [storyId]
  )

  const claimTotal = Number(
    one('SELECT COUNT(*) AS c FROM claim WHERE item_id IN (SELECT item_id FROM story_item WHERE story_id = ?) AND is_meta = 0', [storyId])?.c ?? 0
  )
  const metaCount = Number(
    one('SELECT COUNT(*) AS c FROM claim WHERE story_id = ? AND is_meta = 1', [storyId])?.c ?? 0
  )

  const claimRows = all(
    `${CLAIM_WITH_EVIDENCE('c.item_id IN (SELECT item_id FROM story_item WHERE story_id = ?) AND c.is_meta = 0')}
     ORDER BY c.item_id, COALESCE(e.time_start, 1e9), c.id
     LIMIT ?`,
    [storyId, STORY_CLAIMS_MAX]
  )

  const itemOrder = new Map()
  itemRows.forEach((row, index) => itemOrder.set(row.id, index))

  const claims = claimRows
    .map(decorateClaim)
    .map((claim) => ({
      ...claim,
      item_order: itemOrder.has(claim.item_id) ? itemOrder.get(claim.item_id) : 999
    }))
    .sort((a, b) => {
      if (a.item_order !== b.item_order) return a.item_order - b.item_order
      const ta = a.time_start ?? Number.POSITIVE_INFINITY
      const tb = b.time_start ?? Number.POSITIVE_INFINITY
      if (ta !== tb) return ta - tb
      return String(a.id).localeCompare(String(b.id))
    })

  attachEntities(claims)

  // 每个条目的 claim 数
  const perItem = new Map()
  for (const claim of claims) perItem.set(claim.item_id, (perItem.get(claim.item_id) ?? 0) + 1)

  const legacyRows = itemRows.length
    ? all(
        `SELECT * FROM legacy_doc WHERE item_id IN (${inList(itemRows.length)})`,
        itemRows.map((r) => r.id)
      )
    : []
  const legacyMap = new Map(legacyRows.map((row) => [row.item_id, row]))

  const items = itemRows.map((row) => {
    const legacyRow = legacyMap.get(row.id)
    const legacy = legacyRow
      ? {
          tldr: legacyRow.tldr || '',
          detailed: legacyRow.detailed || '',
          key_topics: Array.isArray(parseJsonSafe(legacyRow.key_topics, []))
            ? parseJsonSafe(legacyRow.key_topics, [])
            : [],
          tags: Array.isArray(parseJsonSafe(legacyRow.tags, [])) ? parseJsonSafe(legacyRow.tags, []) : [],
          model_guess: legacyRow.model_guess || '',
          ratio: num(legacyRow.ratio)
        }
      : null
    return {
      id: row.id,
      title: row.title || '未命名条目',
      author: row.author || '',
      url: row.url || '',
      published_at: row.published_at || '',
      published_ts: toTs(row.published_ts),
      published_label: toTs(row.published_ts) ? dateLabel(row.published_ts) : (row.published_at || ''),
      duration_sec: num(row.duration_sec),
      duration_label: durationLabel(row.duration_sec),
      view_count: num(row.view_count),
      view_label: viewLabel(row.view_count),
      segment_count: num(row.segment_count),
      frame_count: num(row.frame_count),
      asr_quality: num(row.asr_quality),
      dir: row.dir || '',
      role: row.role || 'report',
      claim_count: perItem.get(row.id) ?? 0,
      legacy
    }
  })

  // 事件层面的实体汇总（用来看"这个事件涉及谁/什么"）
  const entityCount = new Map()
  for (const claim of claims) {
    for (const ent of claim.entities) {
      const hit = entityCount.get(ent.id) ?? { id: ent.id, type: ent.type, name: ent.name, count: 0 }
      hit.count += 1
      entityCount.set(ent.id, hit)
    }
  }
  const entities = [...entityCount.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 24)
    .map((ent) => ({ ...ent, type_label: typeLabel(ent.type) }))

  const itemTimes = itemRows.map((r) => toTs(r.published_ts)).filter((v) => v !== null)
  const sortTs =
    toTs(storyRow.last_update_ts) ||
    (itemTimes.length ? Math.max(...itemTimes) : null) ||
    null
  const firstTs =
    toTs(storyRow.first_seen_ts) ||
    (itemTimes.length ? Math.min(...itemTimes) : null) ||
    null

  // ── Story 正文（新结构）：body_md + 章节 + 事实锚点 ──────────────
  const hasBody = typeof storyRow.body_md === 'string' && storyRow.body_md.trim().length > 0
  let body = ''
  let sections = []
  let factSpans = []
  let storyFacts = []
  if (hasBody) {
    body = storyRow.body_md
    sections = all(
      'SELECT id, order_idx, heading, char_start, char_end FROM story_section WHERE story_id = ? ORDER BY order_idx',
      [storyId]
    ).map((r) => ({
      id: r.id,
      order_idx: Number(r.order_idx ?? 0),
      heading: r.heading || '',
      char_start: Number(r.char_start ?? 0),
      char_end: Number(r.char_end ?? 0)
    }))
    const links = all(
      `SELECT sf.fact_id, sf.char_start, sf.char_end, sf.section_id,
              f.canonical_text, f.support_count
       FROM story_fact sf JOIN fact f ON f.id = sf.fact_id
       WHERE sf.story_id = ? ORDER BY sf.char_start, sf.fact_id`,
      [storyId]
    )
    const spanMap = new Map()
    for (const l of links) {
      const key = `${l.char_start}|${l.char_end}`
      const hit = spanMap.get(key) || { start: Number(l.char_start), end: Number(l.char_end), section_id: l.section_id, facts: [] }
      hit.facts.push({ id: l.fact_id, text: l.canonical_text || '', support: Number(l.support_count ?? 0) })
      spanMap.set(key, hit)
    }
    factSpans = [...spanMap.values()].sort((a, b) => a.start - b.start)

    const factIds = [...new Set(links.map((l) => l.fact_id))]
    if (factIds.length) {
      const factRows = all(
        `SELECT f.id, f.canonical_text, f.support_count, f.category FROM fact f WHERE f.id IN (${inList(factIds.length)})`,
        factIds
      )
      const evidence = all(
        `SELECT fc.fact_id, c.id AS claim_id, c.text, c.confidence,
                i.title AS item_title, i.url AS item_url, s2.name AS source
         FROM fact_claim fc
         JOIN claim c ON c.id = fc.claim_id
         JOIN item i ON i.id = c.item_id
         LEFT JOIN source s2 ON s2.id = i.source_id
         WHERE fc.fact_id IN (${inList(factIds.length)})
         ORDER BY fc.fact_id, c.confidence DESC
         LIMIT 1200`,
        factIds
      )
      const evByFact = new Map()
      for (const ev of evidence) {
        const list = evByFact.get(ev.fact_id) || []
        if (list.length < 6) {
          list.push({
            claim_id: ev.claim_id,
            text: ev.text || '',
            confidence: num(ev.confidence),
            item_title: ev.item_title || '',
            item_url: ev.item_url || '',
            source: ev.source || ''
          })
        }
        evByFact.set(ev.fact_id, list)
      }
      storyFacts = factRows.map((f) => ({
        id: f.id,
        text: f.canonical_text || '',
        support: Number(f.support_count ?? 0),
        category: f.category || '',
        evidence: evByFact.get(f.id) || []
      }))
    }
  }

  return {
    story: {
      id: storyRow.id,
      title: storyRow.title || '未命名事件',
      status: storyRow.status ?? null,
      status_label: statusLabel(storyRow.status),
      anchor: storyRow.anchor || '',
      validated: Number(storyRow.validated ?? 0) === 1,
      summary_seed: storyRow.summary_seed || '',
      category: storyRow.category || '',
      category_confidence: num(storyRow.category_confidence),
      story_kind: storyRow.story_kind || 'story',
      seen: ksRow ? { level: ksRow.level, frontier_at: ksRow.frontier_at } : null,
      pending_updates: { count: pendingRows.length, items: pendingRows.map(r => ({ id: r.id, at: r.at, type: r.change_type, severity: r.severity, action: r.action })) },
      timeline: updateRows.map(r => ({ at: r.at, type: r.change_type, severity: r.severity, action: r.action })),
      annotations: annotationRows,
      stance: stanceRow ? { position: stanceRow.position, rationale: stanceRow.rationale, updated_at: stanceRow.updated_at, history: stanceHistory } : null,
      research: researchByKind.deep || null,
      research_contrast: researchByKind.contrast || null,
      merged_into: mergedRow ? { id: mergedRow.id, title: mergedRow.title } : null,
      qa: qaRow ? {
        score: num(qaRow.score),
        coverage: num(qaRow.coverage),
        dup_rate: num(qaRow.dup_rate),
        conflicts: num(qaRow.conflict_count),
        facts: num(qaRow.fact_count),
        missed: num(qaRow.missed_facts),
        checked_at: qaRow.checked_at || ''
      } : null,
      item_count: Number(storyRow.item_count ?? itemRows.length),
      claim_count: claimTotal,
      meta_claim_count: metaCount,
      claims_truncated: claimTotal > claimRows.length,
      first_ts: firstTs,
      last_ts: sortTs,
      first_label: dateLabel(firstTs),
      last_label: dateLabel(sortTs),
      updated_label: relLabel(sortTs, NOW()),
      url: `/story/${encodeURIComponent(storyRow.id)}`
    },
    items,
    claims,
    entities,
    claim_total: claimTotal,
    related_stories: relatedStories,
    has_body: hasBody,
    body,
    sections,
    fact_spans: factSpans,
    facts: storyFacts
  }
}

// ── /api/story/:id/facts ────────────────────────────────────────────────
export function getStoryFacts(storyId) {
  if (!storyId) return null
  const storyRow = one('SELECT id, title, category, body_md FROM story WHERE id = ?', [storyId])
  if (!storyRow) return null
  const links = all(
    `SELECT sf.fact_id, f.canonical_text, f.support_count
     FROM story_fact sf JOIN fact f ON f.id = sf.fact_id
     WHERE sf.story_id = ?`,
    [storyId]
  )
  const factIds = [...new Set(links.map((l) => l.fact_id))]
  if (!factIds.length) return { story_id: storyId, facts: [] }
  const rows = all(
    `SELECT f.id, f.canonical_text, f.support_count, f.category FROM fact f WHERE f.id IN (${inList(factIds.length)})`,
    factIds
  )
  const evidence = all(
    `SELECT fc.fact_id, c.id AS claim_id, c.text, c.confidence,
            i.title AS item_title, i.url AS item_url, s2.name AS source
     FROM fact_claim fc
     JOIN claim c ON c.id = fc.claim_id
     JOIN item i ON i.id = c.item_id
     LEFT JOIN source s2 ON s2.id = i.source_id
     WHERE fc.fact_id IN (${inList(factIds.length)})
     ORDER BY fc.fact_id, c.confidence DESC`,
    factIds
  )
  const evByFact = new Map()
  for (const ev of evidence) {
    const list = evByFact.get(ev.fact_id) || []
    if (list.length < 6) list.push({ claim_id: ev.claim_id, text: ev.text || '', confidence: num(ev.confidence), item_title: ev.item_title || '', item_url: ev.item_url || '', source: ev.source || '' })
    evByFact.set(ev.fact_id, list)
  }
  return {
    story_id: storyId,
    title: storyRow.title || '',
    category: storyRow.category || '',
    facts: rows.map((f) => ({
      id: f.id,
      text: f.canonical_text || '',
      support: Number(f.support_count ?? 0),
      category: f.category || '',
      evidence: evByFact.get(f.id) || []
    }))
  }
}

// ── /api/entity/:id ─────────────────────────────────────────────────────
export function getEntity(entityId) {
  if (!entityId) return null
  const entityRow = one('SELECT * FROM entity WHERE id = ?', [entityId])
  if (!entityRow) return null

  const total = Number(
    one(
      `SELECT COUNT(*) AS c FROM claim_entity ce JOIN claim c ON c.id = ce.claim_id
       WHERE ce.entity_id = ? AND c.is_meta = 0`,
      [entityId]
    )?.c ?? 0
  )

  const claimRows = all(
    `${CLAIM_WITH_EVIDENCE('ce.entity_id = ? AND c.is_meta = 0', 'JOIN claim_entity ce ON ce.claim_id = c.id')}
     ORDER BY (c.predicate IS NULL OR c.predicate = ''), c.predicate, c.confidence DESC, c.id
     LIMIT ?`,
    [entityId, ENTITY_CLAIMS_MAX]
  )
  const claims = claimRows.map(decorateClaim)

  // 按 predicate 分组；空 predicate 归入"其他"
  const groups = new Map()
  for (const claim of claims) {
    const predicate = (claim.predicate || '').trim()
    const key = predicate || '其他'
    const group = groups.get(key) ?? {
      predicate: predicate || '',
      predicate_label: predicate || '其他',
      count: 0,
      claims: []
    }
    group.count += 1
    group.claims.push(claim)
    groups.set(key, group)
  }
  const groupList = [...groups.values()].sort((a, b) => {
    if (a.predicate_label === '其他') return 1
    if (b.predicate_label === '其他') return -1
    return b.count - a.count || a.predicate_label.localeCompare(b.predicate_label)
  })

  const storyRows = all(
    `SELECT s.id, s.title, s.status, s.item_count, s.last_update_ts,
            COUNT(DISTINCT c.id) AS claim_count,
            COUNT(DISTINCT c.item_id) AS item_count
     FROM claim_entity ce
     JOIN claim c ON c.id = ce.claim_id
     JOIN story s ON s.id = c.story_id
     WHERE ce.entity_id = ? AND c.is_meta = 0
     GROUP BY s.id
     ORDER BY claim_count DESC, s.id
     LIMIT 40`,
    [entityId]
  )
  const stories = storyRows.map((row) => ({
    id: row.id,
    title: row.title || '未命名事件',
    status: row.status ?? null,
    status_label: statusLabel(row.status),
    item_count: Number(row.item_count ?? 0),
    claim_count: Number(row.claim_count ?? 0),
    updated_label: relLabel(row.last_update_ts, NOW()),
    url: `/story/${encodeURIComponent(row.id)}`
  }))

  const itemCount = Number(
    one(
      `SELECT COUNT(DISTINCT c.item_id) AS c FROM claim_entity ce JOIN claim c ON c.id = ce.claim_id
       WHERE ce.entity_id = ? AND c.is_meta = 0`,
      [entityId]
    )?.c ?? 0
  )

  return {
    entity: {
      id: entityRow.id,
      type: entityRow.type ?? null,
      type_label: typeLabel(entityRow.type),
      name: entityRow.name || '未命名实体',
      aliases: Array.isArray(parseJsonSafe(entityRow.aliases, [])) ? parseJsonSafe(entityRow.aliases, []) : []
    },
    stats: {
      claim_count: total,
      shown_count: claims.length,
      story_count: stories.length,
      item_count: itemCount,
      predicate_count: groupList.filter((g) => g.predicate_label !== '其他').length
    },
    groups: groupList,
    stories
  }
}

