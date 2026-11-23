// cli/ontology.mjs — 本体演化：候选提案（重复实体合并 / 罕见谓词复核）
//   node ontology.mjs --propose
//   node ontology.mjs --list
//   node ontology.mjs --approve=ID | --reject=ID
import { randomUUID } from 'node:crypto'
import { openDb, nowIso } from '../shared/db.mjs'

const arg = (n, d = null) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d }
const db = openDb()

function propose () {
  const out = []
  const dupEntities = db.prepare(`SELECT lower(name) key, GROUP_CONCAT(id) ids, COUNT(*) n, MAX(name) name FROM entity
    GROUP BY lower(name) HAVING n > 1 LIMIT 30`).all()
  for (const d of dupEntities) {
    if (d.n < 2) continue
    const ids = d.ids.split(',')
    out.push({ kind: 'merge-entity', payload: { name: d.name, ids, primary: ids[0] } })
  }
  const rarePred = db.prepare(`SELECT predicate, COUNT(*) n FROM claim WHERE predicate IS NOT NULL AND predicate!='' GROUP BY predicate HAVING n <= 2 LIMIT 20`).all()
  for (const r of rarePred) out.push({ kind: 'review-predicate', payload: { predicate: r.predicate, n: r.n } })
  return out
}

if (process.argv.includes('--propose')) {
  const props = propose()
  const ins = db.prepare('INSERT OR IGNORE INTO ontology_proposal(id,kind,payload_json,status,created_at) VALUES (?,?,?,?,?)')
  let added = 0
  for (const p of props) {
    const key = p.kind + ':' + JSON.stringify(p.payload).slice(0, 100)
    const exists = db.prepare('SELECT id FROM ontology_proposal WHERE payload_json=?').get(JSON.stringify(p.payload))
    if (exists) continue
    ins.run('ont:' + randomUUID().slice(0, 10), p.kind, JSON.stringify(p.payload), 'pending', nowIso())
    added++
  }
  console.log(JSON.stringify({ proposals: props.length, added }, null, 1))
} else if (process.argv.includes('--list') || process.argv.includes('--pending')) {
  console.log(JSON.stringify(db.prepare("SELECT * FROM ontology_proposal WHERE status='pending' ORDER BY created_at DESC LIMIT 50").all(), null, 1))
} else if (arg('approve')) {
  const p = db.prepare('SELECT * FROM ontology_proposal WHERE id=?').get(arg('approve'))
  if (!p) { console.log('not found'); process.exit(1) }
  if (p.kind === 'merge-entity') {
    const { primary, ids } = JSON.parse(p.payload_json)
    for (const id of ids) if (id !== primary) {
      db.prepare('UPDATE OR REPLACE claim_entity SET entity_id=? WHERE entity_id=?').run(primary, id)
      db.prepare('DELETE FROM entity WHERE id=?').run(id)
    }
  }
  db.prepare("UPDATE ontology_proposal SET status='approved', decided_at=? WHERE id=?").run(nowIso(), arg('approve'))
  console.log(JSON.stringify({ approved: arg('approve'), kind: p.kind }))
} else if (arg('reject')) {
  db.prepare("UPDATE ontology_proposal SET status='rejected', decided_at=? WHERE id=?").run(nowIso(), arg('reject'))
  console.log(JSON.stringify({ rejected: arg('reject') }))
} else {
  console.log('usage: node ontology.mjs --propose | --list | --approve=ID | --reject=ID')
}
db.close()
