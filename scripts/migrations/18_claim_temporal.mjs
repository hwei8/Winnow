// 18_claim_temporal.mjs — 为 claim 补"时间与版本"字段（支撑时效性/冲突/CRUD 的 U 与 D）
import { openDb } from './lib/db.mjs'
const db = openDb()
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)
const add = (c, ddl) => { if (!has('claim', c)) db.exec(`ALTER TABLE claim ADD COLUMN ${ddl}`) }
add('asserted_at', 'asserted_at TEXT')      // 信息源声称的时间
add('world_from', 'world_from TEXT')        // 事实在世界中开始成立
add('world_to', 'world_to TEXT')            // 事实失效
add('superseded_by', 'superseded_by TEXT')  // 被哪条 claim 取代
add('superseded_at', 'superseded_at TEXT')
add('source_tier', 'source_tier INTEGER')   // 来源等级（1 高）
db.exec('CREATE INDEX IF NOT EXISTS idx_claim_sp ON claim(subject,predicate,status)')
db.exec('PRAGMA user_version = 4')
console.log(JSON.stringify({
  claim_cols: db.prepare('PRAGMA table_info(claim)').all().map(r => r.name),
  user_version: db.prepare('PRAGMA user_version').get().user_version
}, null, 1))
db.close()
