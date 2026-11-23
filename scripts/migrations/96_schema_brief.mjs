// 96_schema_brief.mjs — IM 简报 + 兴趣声明表
import { openDb } from './lib/db.mjs'
const db = openDb()
db.exec(`
CREATE TABLE IF NOT EXISTS briefing (
  id TEXT PRIMARY KEY,
  date TEXT,
  generated_at TEXT,
  window_hours INTEGER,
  items_json TEXT,
  stats_json TEXT
);
CREATE TABLE IF NOT EXISTS interest (
  topic TEXT PRIMARY KEY,
  weight REAL DEFAULT 1.0,
  created_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_brief_date ON briefing(date);
`)
db.exec('PRAGMA user_version = 11')
console.log('briefing ready:', db.prepare('PRAGMA user_version').get().user_version)
db.close()
