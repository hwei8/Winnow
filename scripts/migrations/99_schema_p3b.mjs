// 99_schema_p3b.mjs — P3 尾巴：别名 / 源质量 / 待入库队列
import { openDb } from './lib/db.mjs'
const db = openDb()
db.exec(`
CREATE TABLE IF NOT EXISTS topic_alias (
  topic TEXT, alias TEXT, lang TEXT, created_at TEXT,
  PRIMARY KEY (topic, alias)
);
CREATE TABLE IF NOT EXISTS source_quality (
  source_id TEXT PRIMARY KEY,
  items INTEGER, claims INTEGER, contested INTEGER,
  verified_rate REAL, wrong_hits INTEGER, score REAL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ingest_queue (
  id TEXT PRIMARY KEY, url TEXT, source TEXT, status TEXT,
  created_at TEXT, started_at TEXT, finished_at TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON ingest_queue(status);
`)
db.exec('PRAGMA user_version = 14')
console.log('P3b schema:', db.prepare('PRAGMA user_version').get().user_version)
db.close()
