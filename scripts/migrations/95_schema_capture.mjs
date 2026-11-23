// 95_schema_capture.mjs — capture（私人记忆）+ capture_link + knowledge_state 索引
import { openDb } from './lib/db.mjs'
const db = openDb()
db.exec(`
CREATE TABLE IF NOT EXISTS capture (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- idea / todo / decision / reference / life
  content TEXT NOT NULL,
  intent TEXT,                     -- 为什么存
  review_at TEXT,                  -- 什么场景/什么时候该再出现
  target_type TEXT,                -- 可选：关联 story/entity/claim
  target_id TEXT,
  status TEXT DEFAULT 'inbox',     -- inbox / filed / archived
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS capture_link (
  capture_id TEXT, target_type TEXT, target_id TEXT, relation TEXT,
  PRIMARY KEY (capture_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_capture_status ON capture(status);
CREATE INDEX IF NOT EXISTS idx_capture_review ON capture(review_at);
CREATE INDEX IF NOT EXISTS idx_ks_scope ON knowledge_state(scope, level);
`)
db.exec('PRAGMA user_version = 10')
console.log(JSON.stringify({ user_version: db.prepare('PRAGMA user_version').get().user_version, capture: db.prepare("SELECT name FROM sqlite_master WHERE name='capture'").all().length }))
db.close()
