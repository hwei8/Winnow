// 32_migrate_v5.mjs — 补 Jev 判定的落库字段
import { openDb } from './lib/db.mjs'
const db = openDb()
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
const ddl = []
for (const [t, c, d] of [
  ['claim', 'temporal_kind', 'temporal_kind TEXT'],
  ['claim', 'validity_mode', 'validity_mode TEXT'],
  ['claim', 'temporal_confidence', 'temporal_confidence REAL'],
  ['item', 'durability', 'durability REAL']
]) if (!has(t, c)) ddl.push(`ALTER TABLE ${t} ADD COLUMN ${d}`)
for (const s of ddl) db.exec(s)
db.exec('CREATE INDEX IF NOT EXISTS idx_claim_temporal ON claim(temporal_kind, validity_mode)')
db.exec('PRAGMA user_version = 5')
console.log(JSON.stringify({ migration: ddl, claim_cols: db.prepare('PRAGMA table_info(claim)').all().map(r => r.name), item_cols: db.prepare('PRAGMA table_info(item)').all().map(r => r.name) }, null, 1))
db.close()
