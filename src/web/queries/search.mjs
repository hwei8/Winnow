// 全文搜索（FTS5 trigram + LIKE 兜底）。

import { all, one, statement, inList, TS, clampInt, STREAM_LIMIT_DEFAULT, STREAM_LIMIT_MAX, CARD_CLAIMS, STORY_CLAIMS_MAX, ENTITY_CLAIMS_MAX } from '../db.mjs'
import { decorateClaim, attachEntities, parseJsonSafe, placeholders, NOW } from '../shared.mjs'
import { num, toTs, kindMeta, confPct, confLabel, statusLabel, typeLabel, relLabel, dateLabel, timeRangeLabel, viewLabel, durationLabel, frameUrl, mmss } from '../views/fmt.mjs'

// ── /api/search ─────────────────────────────────────────────────────────
function escapeLike(raw) {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function buildFtsQuery(raw) {
  const tokens = raw.split(/\s+/).filter(Boolean)
  if (!tokens.length) return null
  // 每个 token 用短语包裹，避免用户输入的 FTS 元字符造成语法错误
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

export function search(rawQuery, rawLimit = 30) {
  // 限制查询长度，避免超长输入拖慢 LIKE 路径
  const q = String(rawQuery ?? '').trim().slice(0, 200)
  const limit = clampInt(rawLimit, 1, 100, 30)
  const empty = { q, mode: 'empty', count: 0, total: 0, results: [], items: [] }
  if (!q) return empty

  const tokens = q.split(/\s+/).filter(Boolean)
  // trigram 索引最短需要 3 个字符；短词退化为 LIKE
  const ftsEligible = tokens.every((t) => t.length >= 3)
  let mode = 'like'
  let rows = []

  if (ftsEligible) {
    const match = buildFtsQuery(q)
    if (match) {
      try {
        rows = all(
          `SELECT c.id, c.story_id, c.item_id, c.text, c.kind, c.confidence,
                  c.subject, c.predicate, c.object_text,
                  i.title AS item_title, i.author AS item_author, s.title AS story_title
           FROM claim_fts
           JOIN claim c ON c.rowid = claim_fts.rowid
           LEFT JOIN item i ON i.id = c.item_id
           LEFT JOIN story s ON s.id = c.story_id
           WHERE claim_fts MATCH ? AND c.is_meta = 0
           ORDER BY rank, c.confidence DESC
           LIMIT ?`,
          [match, limit]
        )
        if (rows.length) mode = 'fts'
      } catch {
        rows = []
      }
    }
  }

  if (!rows.length) {
    mode = 'like'
    const where = tokens.map(() => `c.text LIKE ? ESCAPE '\\'`).join(' AND ')
    rows = all(
      `SELECT c.id, c.story_id, c.item_id, c.text, c.kind, c.confidence,
              c.subject, c.predicate, c.object_text,
              i.title AS item_title, i.author AS item_author, s.title AS story_title
       FROM claim c
       LEFT JOIN item i ON i.id = c.item_id
       LEFT JOIN story s ON s.id = c.story_id
       WHERE ${where} AND c.is_meta = 0
       ORDER BY c.confidence DESC, c.id
       LIMIT ?`,
      [...tokens.map((t) => `%${escapeLike(t)}%`), limit]
    )
  }

  const results = rows.map((row) => {
    const claim = decorateClaim(row)
    return {
      ...claim,
      story_title: row.story_title || '',
      story_url: row.story_id ? `/story/${encodeURIComponent(row.story_id)}` : null,
      url: row.story_id
        ? `/story/${encodeURIComponent(row.story_id)}#${encodeURIComponent(`claim-${row.id}`)}`
        : null
    }
  })

  // 顺带给出标题命中的条目（点击进入所属事件）
  let items = []
  const itemLike = `%${escapeLike(tokens[0])}%`
  const itemRows = all(
    `SELECT i.id, i.title, i.author, i.published_ts, i.duration_sec,
            (SELECT si.story_id FROM story_item si WHERE si.item_id = i.id LIMIT 1) AS story_id
     FROM item i
     WHERE i.title LIKE ? ESCAPE '\\'
     ORDER BY i.published_ts DESC
     LIMIT 5`,
    [itemLike]
  )
  items = itemRows.map((row) => ({
    id: row.id,
    title: row.title || '未命名条目',
    author: row.author || '',
    published_label: toTs(row.published_ts) ? dateLabel(row.published_ts) : '',
    duration_label: durationLabel(row.duration_sec),
    story_id: row.story_id || null,
    url: row.story_id ? `/story/${encodeURIComponent(row.story_id)}` : null
  }))

  return { q, mode, count: results.length, total: results.length, results, items }
}

