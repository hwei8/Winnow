// 69_schema_qa.mjs — story_qa 表 + story.title_original
import { openDb } from './lib/db.mjs'
const db = openDb()
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
if (!hasCol('story', 'title_original')) db.exec('ALTER TABLE story ADD COLUMN title_original TEXT')
db.exec(`
CREATE TABLE IF NOT EXISTS story_qa (
  story_id TEXT PRIMARY KEY,
  score REAL,
  coverage REAL,
  dup_rate REAL,
  conflict_count INTEGER,
  anchor_count INTEGER,
  fact_count INTEGER,
  missed_facts INTEGER,
  issues_json TEXT,
  checked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_qa_score ON story_qa(score);
`)
db.exec('PRAGMA user_version = 7')
console.log(JSON.stringify({
  user_version: db.prepare('PRAGMA user_version').get().user_version,
  story_cols: db.prepare('PRAGMA table_info(story)').all().map(r => r.name).filter(n => n.includes('title')),
  tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='story_qa'").all().map(r => r.name)
}, null, 1))
db.close()
