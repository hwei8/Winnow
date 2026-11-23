// 97_schema_p2.mjs — P2：标注闭环 + Stance + L4 深研缓存
import { openDb } from './lib/db.mjs'
const db = openDb()
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
if (!has('annotation', 'meta_json')) db.exec('ALTER TABLE annotation ADD COLUMN meta_json TEXT')
db.exec(`
CREATE TABLE IF NOT EXISTS stance (
  id TEXT PRIMARY KEY,
  target_type TEXT, target_id TEXT,
  position TEXT, rationale TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS stance_revision (
  id TEXT PRIMARY KEY, stance_id TEXT, position TEXT, rationale TEXT,
  source_annotation_id TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS research (
  id TEXT PRIMARY KEY, story_id TEXT, kind TEXT, content TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_stance_target ON stance(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_annotation_target ON annotation(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_research_story ON research(story_id, kind);
`)
db.exec('PRAGMA user_version = 12')
console.log('P2 schema ready:', db.prepare('PRAGMA user_version').get().user_version)
db.close()
