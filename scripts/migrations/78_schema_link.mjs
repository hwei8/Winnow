// 78_schema_link.mjs — Story 链接所需字段与表
import { openDb } from './lib/db.mjs'
const db = openDb()
const has = (t,c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
if (!has('story','merged_into')) db.exec('ALTER TABLE story ADD COLUMN merged_into TEXT')
if (!has('story','story_kind')) db.exec("ALTER TABLE story ADD COLUMN story_kind TEXT DEFAULT 'story'")
db.exec(`
CREATE TABLE IF NOT EXISTS story_link (
  story_id TEXT, related_story_id TEXT, relation TEXT,
  same_event_prob REAL, overlap REAL, gap_count INTEGER, gap_facts_json TEXT,
  created_at TEXT,
  PRIMARY KEY (story_id, related_story_id)
);
CREATE TABLE IF NOT EXISTS story_update (
  id TEXT PRIMARY KEY, story_id TEXT, at TEXT, change_type TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_link_story ON story_link(story_id);
`)
db.exec('PRAGMA user_version = 8')
console.log(JSON.stringify({ user_version: db.prepare('PRAGMA user_version').get().user_version, cols: ['merged_into','story_kind'].map(c => [c, has('story', c)]) }, null, 1))
db.close()
