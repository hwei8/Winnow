// cli/source-quality.mjs — 重算源质量
import { openDb } from '../shared/db.mjs'
import { recomputeSourceQuality } from '../domains/ops/source-quality.mjs'
const db = openDb()
const rows = recomputeSourceQuality(db)
console.log(JSON.stringify(rows.slice(0, 12), null, 1))
db.close()
