// 11_rss_schema.mjs — 为文本源（RSS/文章）补 schema
import { openDb } from './lib/db.mjs'
const db = openDb()
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
const ddl = []
if (!has('item', 'content_source')) ddl.push("ALTER TABLE item ADD COLUMN content_source TEXT")
if (!has('item', 'lang')) ddl.push('ALTER TABLE item ADD COLUMN lang TEXT')
for (const s of ddl) db.exec(s)
db.exec(`
CREATE TABLE IF NOT EXISTS item_block (
  item_id    TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end   INTEGER NOT NULL,
  kind       TEXT DEFAULT 'paragraph',
  PRIMARY KEY (item_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_block_item ON item_block(item_id, idx);
`)
db.exec('PRAGMA user_version = 3')
console.log(JSON.stringify({ migration: ddl, item_cols: db.prepare('PRAGMA table_info(item)').all().map(r=>r.name), user_version: db.prepare('PRAGMA user_version').get().user_version }))
db.close()
