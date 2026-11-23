// cli/revalidate.mjs — 周期重验证：找出需要复核的 claim/Story
//   node src/cli/revalidate.mjs --days=90 --limit=200
import { randomUUID } from 'node:crypto'
import { openDb, nowIso } from '../shared/db.mjs'

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d }
const days = Number(arg('days', '90'))
const limit = Number(arg('limit', '200'))
const db = openDb()
const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString()

const staleClaims = db.prepare(`SELECT c.id, c.story_id, c.text, c.asserted_at FROM claim c
  WHERE c.is_meta=0 AND (c.status IS NULL OR c.status IN ('active','ok'))
    AND (c.validity_mode='time-bound' OR COALESCE(c.asserted_at, c.created_at) < ?)
  LIMIT ?`).all(cutoff, limit)

const staleStories = db.prepare(`SELECT s.id, s.title, MAX(u.at) last_at FROM story s LEFT JOIN story_update u ON u.story_id=s.id
  WHERE (s.status IS NULL OR s.status!='duplicate') GROUP BY s.id
  HAVING MAX(u.at) IS NOT NULL AND MAX(u.at) < ? LIMIT ?`).all(cutoff, limit)

let marked = 0
for (const c of staleClaims) {
  db.prepare("UPDATE claim SET status='needs_recheck' WHERE id=?").run(c.id)
  db.prepare('INSERT INTO revalidation(id,claim_id,story_id,reason,at) VALUES (?,?,?,?,?)')
    .run('rv:' + randomUUID().slice(0, 10), c.id, c.story_id, c.validity_mode === 'time-bound' ? 'time-bound' : 'older-than-' + days + 'd', nowIso())
  marked++
}
if (arg('resolve')) {
  const id = arg('resolve')
  db.prepare("UPDATE claim SET status='ok' WHERE id=?").run(id)
  db.prepare('UPDATE revalidation SET resolved_at=? WHERE claim_id=? AND resolved_at IS NULL').run(nowIso(), id)
  console.log(JSON.stringify({ resolved: id }))
  db.close()
  process.exit(0)
}
const report = { cutoff, stale_claims: staleClaims.length, stale_stories: staleStories.length, marked_needs_recheck: marked, sample: staleClaims.slice(0, 5).map(c => c.text?.slice(0, 50)) }
console.log(JSON.stringify(report, null, 1))
db.close()
