// cli/evidence-gate.mjs — 运行证据校验门禁
import { openDb } from '../shared/db.mjs'
import { reverifyEvidence } from '../domains/knowledge/evidence.mjs'
const db = openDb()
console.log(JSON.stringify(reverifyEvidence(db, { limit: Number(process.env.LIMIT || 0) }), null, 1))
db.close()
