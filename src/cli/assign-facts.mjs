// cli/assign-facts.mjs — 把未归簇的 claim 归入既有 fact（cosine top3 + Jev），否则新建
//
// 逻辑在 domains/knowledge/facts.mjs（与入库流水线共用一份实现）：
// 同批去重、Jev 失败即停（不制造重复 fact）、事务内分配编号。
import { openDb } from '../shared/db.mjs'
import { assignClaimsToFacts } from '../domains/knowledge/facts.mjs'

const db = openDb()
const pending = db.prepare("SELECT id FROM claim WHERE fact_id IS NULL AND COALESCE(status,'') != 'meta'").all().map(r => r.id)
console.log('claims to assign:', pending.length)
let result = { assigned: 0, created: 0 }
let error = null
try { result = await assignClaimsToFacts(db, pending) } catch (e) { error = String(e.message).slice(0, 200); process.exitCode = 1 }
console.log(JSON.stringify({
  assigned_to_existing: result.assigned,
  created_new_facts: result.created,
  error,
  facts_total: db.prepare('SELECT COUNT(*) c FROM fact').get().c,
  claims_mapped: db.prepare('SELECT COUNT(*) c FROM claim WHERE fact_id IS NOT NULL').get().c
}, null, 1))
db.close()
