// 展示字段与跨页面复用的小工具。

import { num, toTs, kindMeta, confPct, confLabel, statusLabel, typeLabel, relLabel, dateLabel, timeRangeLabel, viewLabel, durationLabel, frameUrl, mmss } from './views/fmt.mjs'
import { all, inList } from './db.mjs'

export const NOW = () => Date.now()

export function placeholders(ids) {
  return ids.length ? inList(ids.length) : ''
}

/**
 * 把 claim 行 + 证据行装饰成前端可直接展示的对象。
 * 不做 HTML 转义（转义在模板层），保证文本可安全用于 JSON API。
 */
export function decorateClaim(row) {
  const km = kindMeta(row.kind)
  return {
    id: row.id ?? null,
    text: row.text ?? '',
    kind: row.kind ?? null,
    kind_label: km.label,
    kind_cls: km.cls,
    confidence: num(row.confidence),
    confidence_pct: confPct(row.confidence),
    confidence_label: confLabel(row.confidence),
    subject: row.subject || '',
    predicate: row.predicate || '',
    object_text: row.object_text || '',
    object_value_json: row.object_value_json ?? null,
    is_meta: Number(row.is_meta ?? 0) === 1,
    story_id: row.story_id ?? null,
    item_id: row.item_id ?? null,
    item_title: row.item_title || '',
    item_author: row.item_author || '',
    item_published_label: toTs(row.item_published_ts) ? dateLabel(row.item_published_ts) : '',
    item_published_ts: toTs(row.item_published_ts),
    excerpt: row.excerpt || '',
    time_start: num(row.time_start),
    time_end: num(row.time_end),
    time_label: timeRangeLabel(row.time_start, row.time_end),
    segment_from: num(row.segment_from),
    segment_to: num(row.segment_to),
    frame_id: row.frame_id || null,
    frame_path: row.frame_path || null,
    frame_url: frameUrl(row.frame_path),
    verified: row.verified === null || row.verified === undefined ? null : Number(row.verified) === 1,
    entities: []
  }
}


export function attachEntities(claims) {
  if (!claims.length) return claims
  const ids = claims.map((c) => c.id)
  const rows = all(
    `SELECT ce.claim_id AS claim_id, e.id AS id, e.type AS type, e.name AS name
     FROM claim_entity ce JOIN entity e ON e.id = ce.entity_id
     WHERE ce.claim_id IN (${inList(ids.length)})
     ORDER BY (e.type = 'uploader') DESC, e.name`,
    ids
  )
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row.claim_id) ?? []
    if (list.length < 6) list.push({ id: row.id, type: row.type, name: row.name })
    map.set(row.claim_id, list)
  }
  for (const claim of claims) claim.entities = map.get(claim.id) ?? []
  return claims
}

export function parseJsonSafe(raw, fallback) {
  if (!raw || typeof raw !== 'string') return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

