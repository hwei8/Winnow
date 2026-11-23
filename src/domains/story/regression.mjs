// story/regression.mjs — 真实更新回归：对已入库的 update item 用当前策略重新分级（只判定不执行）
import { openDb } from '../../shared/db.mjs'
import { classifyUpdate } from './policy.mjs'

const db = openDb()
const rows = db.prepare(`SELECT d.item_id, d.parent_story_id, d.action, d.same_event, d.gap_count, i.title
  FROM ingest_decision d JOIN item i ON i.id=d.item_id
  WHERE d.action IN ('update','duplicate') ORDER BY d.decided_at DESC`).all()
console.log('real update/duplicate items:', rows.length)
const report = []
for (const r of rows) {
  if (!r.parent_story_id) continue
  const factIds = db.prepare('SELECT DISTINCT fact_id FROM claim WHERE item_id=? AND fact_id IS NOT NULL').all(r.item_id).map(x => x.fact_id)
  if (!factIds.length) continue
  try {
    const cls = await classifyUpdate({ db, parentId: r.parent_story_id, newFactIds: factIds })
    report.push({ item: r.item_id, title: (r.title || '').slice(0, 44), parent: r.parent_story_id, decided: r.action, severity: cls.severity, action: cls.action, reasons: cls.reasons, gap: cls.gapCount, lede: cls.lede, retraction: cls.retraction, sections: cls.updateSections })
  } catch (e) { report.push({ item: r.item_id, error: e.message.slice(0, 60) }) }
}
const dist = {}
for (const r of report) { if (!r.error) { const k = `${r.severity}/${r.action}`; dist[k] = (dist[k] || 0) + 1 } }
console.log('\nseverity/action distribution:')
Object.entries(dist).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`))
console.log('\ndetails:')
for (const r of report.filter(x => !x.error)) console.log(`  ${r.severity.padEnd(3)} ${r.action.padEnd(12)} | gap ${String(r.gap).padStart(2)} | sec ${r.sections} | lede ${r.lede} | ${r.title}`)
const errors = report.filter(x => x.error)
if (errors.length) console.log('\nerrors:', errors.length, errors.slice(0, 3))
db.close()
