// 单条 item 详情（可选接口）。

import { all, one, statement, inList, TS, clampInt, STREAM_LIMIT_DEFAULT, STREAM_LIMIT_MAX, CARD_CLAIMS, STORY_CLAIMS_MAX, ENTITY_CLAIMS_MAX } from '../db.mjs'
import { decorateClaim, attachEntities, parseJsonSafe, placeholders, NOW } from '../shared.mjs'
import { num, toTs, kindMeta, confPct, confLabel, statusLabel, typeLabel, relLabel, dateLabel, timeRangeLabel, viewLabel, durationLabel, frameUrl, mmss } from '../views/fmt.mjs'

// ── /api/item/:id（可选接口）────────────────────────────────────────────
export function getItem(itemId) {
  if (!itemId) return null
  const itemRow = one('SELECT * FROM item WHERE id = ?', [itemId])
  if (!itemRow) return null

  const segmentRows = all(
    `SELECT idx, start_sec, end_sec, text_raw FROM item_segment
     WHERE item_id = ? ORDER BY idx LIMIT 80`,
    [itemId]
  )
  const segmentTotal = Number(
    one('SELECT COUNT(*) AS c FROM item_segment WHERE item_id = ?', [itemId])?.c ?? 0
  )

  const storyRow = one(
    `SELECT s.id, s.title, s.status, s.item_count FROM story_item si
     JOIN story s ON s.id = si.story_id WHERE si.item_id = ? LIMIT 1`,
    [itemId]
  )

  const legacyRow = one('SELECT * FROM legacy_doc WHERE item_id = ?', [itemId])
  const claimCount = Number(
    one('SELECT COUNT(*) AS c FROM claim WHERE item_id = ? AND is_meta = 0', [itemId])?.c ?? 0
  )

  return {
    item: {
      id: itemRow.id,
      title: itemRow.title || '未命名条目',
      author: itemRow.author || '',
      url: itemRow.url || '',
      published_at: itemRow.published_at || '',
      published_label: toTs(itemRow.published_ts) ? dateLabel(itemRow.published_ts) : '',
      duration_sec: num(itemRow.duration_sec),
      duration_label: durationLabel(itemRow.duration_sec),
      view_count: num(itemRow.view_count),
      view_label: viewLabel(itemRow.view_count),
      segment_count: num(itemRow.segment_count),
      frame_count: num(itemRow.frame_count),
      asr_quality: num(itemRow.asr_quality),
      dir: itemRow.dir || '',
      description: itemRow.description || ''
    },
    story: storyRow
      ? {
          id: storyRow.id,
          title: storyRow.title || '未命名事件',
          status_label: statusLabel(storyRow.status),
          item_count: Number(storyRow.item_count ?? 0),
          url: `/story/${encodeURIComponent(storyRow.id)}`
        }
      : null,
    legacy: legacyRow
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
      : null,
    claim_count: claimCount,
    segment_total: segmentTotal,
    segments: segmentRows.map((row) => ({
      idx: row.idx,
      start_sec: num(row.start_sec),
      end_sec: num(row.end_sec),
      time_label: mmss(row.start_sec),
      text: row.text_raw || ''
    }))
  }
}

// 供模板复用的常量
