// 98_schema_p3.mjs — P3：interest 说明字段 + beat_report 历史
import { openDb } from './lib/db.mjs'
const db = openDb()
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
if (!has('interest', 'kind')) db.exec("ALTER TABLE interest ADD COLUMN kind TEXT DEFAULT 'topic'")
if (!has('interest', 'last_report_at')) db.exec('ALTER TABLE interest ADD COLUMN last_report_at TEXT')
db.exec(`
CREATE TABLE IF NOT EXISTS beat_report (
  id TEXT PRIMARY KEY, generated_at TEXT, topics_json TEXT, findings_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_beat_time ON beat_report(generated_at);
`)
db.exec('PRAGMA user_version = 13')
console.log('P3 schema:', db.prepare('PRAGMA user_version').get().user_version)
db.close()
