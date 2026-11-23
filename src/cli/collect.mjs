// cli/collect.mjs — adapter 采集 CLI
//   node src/cli/collect.mjs --adapter=hn --limit=5
//   node src/cli/collect.mjs --adapter=rss --limit=5 --source=src:36kr
//   node src/cli/collect.mjs --health=hn
import { openDb } from '../shared/db.mjs'
import { collect, healthCheck, listAdapters } from '../domains/ingest/registry.mjs'

const arg = (n, d = null) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d }
const db = openDb()
if (process.argv.includes('--list')) { console.log(JSON.stringify(listAdapters())); process.exit(0) }
const health = arg('health')
if (health) { console.log(JSON.stringify(await healthCheck(health), null, 1)); process.exit(0) }
const adapter = arg('adapter', 'hn')
const r = await collect(db, { adapter, limit: Number(arg('limit', '5')), source: arg('source') })
// 单行 JSON（pipeline 会解析最后一行）
console.log(JSON.stringify(r))
db.close()
