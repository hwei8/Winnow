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
 * 修复历史数据：把裸的 `secN` 形式的 section_id 改成 `${story_id}:secN`。
 * 只改能在 story_section 里找到对应行的记录；幂等。返回修复的行数。
 */
export function repairSectionIds (db) {
  return db.prepare(`UPDATE story_fact SET section_id = story_id || ':' || section_id
    WHERE section_id GLOB 'sec[0-9]*'
      AND EXISTS (SELECT 1 FROM story_section ss WHERE ss.id = story_fact.story_id || ':' || story_fact.section_id)`).run().changes
}
