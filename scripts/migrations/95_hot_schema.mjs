// 95_hot_schema.mjs — 热榜条目与排名历史（newsnow 采集）
import { openDb } from './lib/db.mjs'
const db = openDb()
db.exec(`
CREATE TABLE IF NOT EXISTS hot_entry (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  mobile_url TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  appearances INTEGER DEFAULT 1,
  best_rank INTEGER,
  last_rank INTEGER,
  heat REAL DEFAULT 0,
  promoted_item_id TEXT,
  UNIQUE(platform, url)
);
CREATE INDEX IF NOT EXISTS idx_hot_platform ON hot_entry(platform, last_rank);
CREATE INDEX IF NOT EXISTS idx_hot_seen ON hot_entry(last_seen);

CREATE TABLE IF NOT EXISTS hot_rank (
  entry_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(entry_id, at)
);
CREATE INDEX IF NOT EXISTS idx_hot_rank_entry ON hot_rank(entry_id, at);

CREATE TABLE IF NOT EXISTS hot_crawl (
  at TEXT PRIMARY KEY,
  platforms INTEGER,
  entries INTEGER,
  errors TEXT
);
`)
db.prepare('PRAGMA user_version').get()
db.exec('PRAGMA user_version = 16')
console.log(JSON.stringify({ ok: true, tables: ['hot_entry', 'hot_rank', 'hot_crawl'] }))
db.close()
