// 07_migrate.mjs — P0.1 schema 迁移（可重复执行）
// 新增：claim 的结构化值/元信息标记/状态、story 的锚点与验证标记、claim_dup 表
import { existsSync } from 'node:fs'
import { openDb } from './lib/db.mjs'

const db = openDb()
const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col)

const ddl = []
if (!has('claim', 'object_value_json')) ddl.push("ALTER TABLE claim ADD COLUMN object_value_json TEXT")
if (!has('claim', 'is_meta')) ddl.push("ALTER TABLE claim ADD COLUMN is_meta INTEGER DEFAULT 0")
if (!has('claim', 'status')) ddl.push("ALTER TABLE claim ADD COLUMN status TEXT DEFAULT 'active'")
if (!has('story', 'anchor')) ddl.push('ALTER TABLE story ADD COLUMN anchor TEXT')
if (!has('story', 'validated')) ddl.push('ALTER TABLE story ADD COLUMN validated INTEGER DEFAULT 0')
for (const sql of ddl) db.exec(sql)

db.exec(`
CREATE TABLE IF NOT EXISTS claim_dup (
  keep_id     TEXT NOT NULL,
  dup_id      TEXT NOT NULL,
  similarity  REAL,
  route       TEXT,
  judged_by   TEXT,
  at          TEXT,
  PRIMARY KEY (keep_id, dup_id)
);
CREATE INDEX IF NOT EXISTS idx_dup_dup ON claim_dup(dup_id);

CREATE TABLE IF NOT EXISTS cluster_audit (
  story_id    TEXT PRIMARY KEY,
  verdict     TEXT,            -- same_event | mixed | split
  anchor      TEXT,
  reason      TEXT,
  at          TEXT
);
`)
db.exec('PRAGMA user_version = 2')

const info = {
  migration: ddl,
  claim_cols: db.prepare('PRAGMA table_info(claim)').all().map(r => r.name),
  story_cols: db.prepare('PRAGMA table_info(story)').all().map(r => r.name),
  tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name)
}
console.log(JSON.stringify(info, null, 2))
db.close()
