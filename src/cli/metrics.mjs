// cli/metrics.mjs — 计算并保存系统度量
import { openDb } from '../shared/db.mjs'
import { saveMetrics } from '../domains/ops/metrics.mjs'
const db = openDb()
const m = saveMetrics(db)
console.log(JSON.stringify(m, null, 1))
db.close()
