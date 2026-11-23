// story/store.mjs — Story 行与章节 id 的唯一写法
//
// 为什么需要：曾经有两个生成器各写各的——一个把 story_fact.section_id 写成 `sec1`，
// 另一个写成 `${storyId}:sec1`（与 story_section.id 一致）。consolidate 按完整 id 查锚点，
// 对前一种格式查不到，随后 DELETE + 重建，悄悄丢掉了保留章节的全部锚点。

/** story_section.id / story_fact.section_id 的唯一格式。n 从 1 开始。 */
export function sectionId (storyId, n) {
  return `${storyId}:sec${n}`
}

const STORY_COLS = new Set(['title', 'status', 'item_count', 'first_seen_ts', 'last_update_ts', 'summary_seed', 'anchor', 'validated', 'category', 'category_confidence', 'body_md', 'title_original', 'merged_into', 'story_kind'])

/**
 * 插入或更新一条 story，只改传入的列。
 * 不用 INSERT OR REPLACE：那会先删整行，把未列出的列（merged_into / title_original / story_kind…）清空。
 * 已被判为 duplicate 的 story 重新生成正文时保持 duplicate，不会"复活"到信息流里。
 */
export function upsertStory (db, row) {
  if (!row.id) throw new Error('upsertStory: id required')
  const cols = Object.keys(row).filter(k => k !== 'id')
  for (const c of cols) if (!STORY_COLS.has(c)) throw new Error(`upsertStory: unknown column ${c}`)
  const set = cols.map(c => c === 'status'
    ? "status = CASE WHEN story.status = 'duplicate' THEN story.status ELSE excluded.status END"
    : `${c} = excluded.${c}`)
  const sql = `INSERT INTO story(id${cols.map(c => ',' + c).join('')}) VALUES (?${',?'.repeat(cols.length)})
    ON CONFLICT(id) DO UPDATE SET ${set.join(', ')}`
  return db.prepare(sql).run(row.id, ...cols.map(c => row[c] ?? null))
}

/**
 * 修复历史数据，幂等，返回修复的行数。两种错配都要修：
 *
 *  1. 裸 `secN` → `${story_id}:secN`（早期 generate-stories 的写法，consolidate 按完整 id 查不到就丢锚点）。
 *  2. `section_id` 为 NULL 或指向已不存在的章节 → 按 `char_start/char_end` 归到覆盖它的章节。
 *     正文重写后偏移仍落在章节区间内，只是归属丢了；没有归属时 consolidate 重建章节会连带删掉锚点。
 *     先按"完整覆盖取最内层章节"，再退一步按"起点落在章节内取最内层"，两轮都不中的保持原样。
 */
export function repairSectionIds (db) {
  const prefixed = db.prepare(`UPDATE story_fact SET section_id = story_id || ':' || section_id
    WHERE section_id GLOB 'sec[0-9]*'
      AND EXISTS (SELECT 1 FROM story_section ss WHERE ss.id = story_fact.story_id || ':' || story_fact.section_id)`).run().changes

  // 待定的追加锚点（role='update'，跨度 0..0）不是"丢了归属"，而是还没进正文：
  // 按区间归位会把它们钉到第 1 节，consolidate 之后再也认不出它们是待处理的更新。
  const orphans = db.prepare(`SELECT story_id, fact_id, role, char_start, char_end FROM story_fact sf
    WHERE NOT EXISTS (SELECT 1 FROM story_section ss WHERE ss.id = sf.section_id)
      AND COALESCE(sf.role, '') != 'update'
      AND sf.char_end > sf.char_start`).all()
  const strict = db.prepare(`SELECT id FROM story_section
    WHERE story_id = ? AND char_start <= ? AND char_end >= ?
    ORDER BY (char_end - char_start) ASC LIMIT 1`)
  const loose = db.prepare(`SELECT id FROM story_section
    WHERE story_id = ? AND char_start <= ? AND char_end > ?
    ORDER BY (char_end - char_start) ASC LIMIT 1`)
  const update = db.prepare(`UPDATE story_fact SET section_id = ?
    WHERE story_id = ? AND fact_id = ? AND char_start = ? AND char_end = ?
      AND COALESCE(role, '') != 'update'
      AND NOT EXISTS (SELECT 1 FROM story_section ss WHERE ss.id = story_fact.section_id)`)

  let ranged = 0
  for (const r of orphans) {
    const hit = strict.get(r.story_id, r.char_start, r.char_end) || loose.get(r.story_id, r.char_start, r.char_start)
    if (!hit) continue
    update.run(hit.id, r.story_id, r.fact_id, r.char_start, r.char_end)
    ranged++
  }
  return prefixed + ranged
}
