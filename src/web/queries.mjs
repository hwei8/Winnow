// Web 只读查询层的门面（barrel）：按页面域拆分在 queries/ 下，这里统一导出。
export { DB_PATH, SUMMARY_ROOT, closeDb, STREAM_LIMIT_MAX, CARD_CLAIMS, STORY_CLAIMS_MAX } from './db.mjs'
export * from './queries/pages.mjs'
export * from './queries/story.mjs'
export * from './queries/search.mjs'
export * from './queries/item.mjs'

export const LAYOUT_LIMITS = { CARD_CLAIMS: 5, STREAM_LIMIT_MAX: 50, STORY_CLAIMS_MAX: 800 }
