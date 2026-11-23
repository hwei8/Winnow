// 85_schema_update.mjs — 重写策略所需：severity 字段 + 版本快照表
import { openDb } from './lib/db.mjs'
const db = openDb()
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
if (!has('story_update', 'severity')) db.exec("ALTER TABLE story_update ADD COLUMN severity TEXT")
if (!has('story_update', 'action')) db.exec("ALTER TABLE story_update ADD COLUMN action TEXT")
if (!has('story_update', 'reason')) db.exec("ALTER TABLE story_update ADD COLUMN reason TEXT")
db.exec(`
CREATE TABLE IF NOT EXISTS story_version (
  story_id TEXT, version INTEGER, body_md TEXT, sections_json TEXT, facts_json TEXT,
  category TEXT, created_at TEXT, note TEXT,
  PRIMARY KEY (story_id, version)
);
`)
db.exec('PRAGMA user_version = 9')
console.log(JSON.stringify({ user_version: db.prepare('PRAGMA user_version').get().user_version, cols: db.prepare('PRAGMA table_info(story_update)').all().map(r => r.name) }, null, 1))
db.close()
