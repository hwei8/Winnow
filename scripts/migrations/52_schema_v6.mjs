// 52_schema_v6.mjs — Story 中心化：story/category/正文偏移 + fact/fact_claim 记忆层
import { openDb } from './lib/db.mjs'
const db = openDb()
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
const cols = []
if (!hasCol('story', 'category')) cols.push('ALTER TABLE story ADD COLUMN category TEXT')
if (!hasCol('story', 'category_confidence')) cols.push('ALTER TABLE story ADD COLUMN category_confidence REAL')
if (!hasCol('story', 'body_md')) cols.push('ALTER TABLE story ADD COLUMN body_md TEXT')
if (!hasCol('claim', 'embedding')) cols.push('ALTER TABLE claim ADD COLUMN embedding BLOB')
if (!hasCol('claim', 'fact_id')) cols.push('ALTER TABLE claim ADD COLUMN fact_id TEXT')
for (const c of cols) db.exec(c)

db.exec(`
CREATE TABLE IF NOT EXISTS fact (
  id TEXT PRIMARY KEY,
  canonical_text TEXT NOT NULL,
  subject TEXT, predicate TEXT, object_text TEXT,
  temporal_kind TEXT, validity_mode TEXT,
  confidence REAL,
  first_seen TEXT, last_updated TEXT,
  superseded_by TEXT,
  support_count INTEGER DEFAULT 0,
  category TEXT
);
CREATE TABLE IF NOT EXISTS fact_claim (
  fact_id TEXT, claim_id TEXT, stance TEXT DEFAULT 'supports',
  observed_at TEXT,
  PRIMARY KEY (fact_id, claim_id)
);
CREATE TABLE IF NOT EXISTS story_section (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  order_idx INTEGER NOT NULL,
  heading TEXT,
  body_md TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_fact (
  story_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  section_id TEXT,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  role TEXT DEFAULT 'asserts',
  order_idx INTEGER,
  PRIMARY KEY (story_id, fact_id, char_start)
);
CREATE TABLE IF NOT EXISTS story_source (
  story_id TEXT, item_id TEXT, role TEXT,
  PRIMARY KEY (story_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_story_fact_story ON story_fact(story_id, char_start);
CREATE INDEX IF NOT EXISTS idx_story_section_story ON story_section(story_id, order_idx);
CREATE INDEX IF NOT EXISTS idx_fact_cat ON fact(category);
CREATE INDEX IF NOT EXISTS idx_claim_fact ON claim(fact_id);
`)
db.exec('PRAGMA user_version = 6')
console.log(JSON.stringify({
  user_version: db.prepare('PRAGMA user_version').get().user_version,
  story_cols: db.prepare('PRAGMA table_info(story)').all().map(r => r.name),
  claim_cols: db.prepare('PRAGMA table_info(claim)').all().map(r => r.name),
  new_tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fact','fact_claim','story_section','story_fact','story_source')").all().map(r => r.name)
}, null, 1))
db.close()
