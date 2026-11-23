// cli/fetch-titles.mjs — 给"标题级条目"补抓原文正文
import { openDb, nowIso } from '../shared/db.mjs'
import { extractMainText } from '../domains/ingest/extract.mjs'
import { blockText } from '../domains/ingest/feed.mjs'

const db = openDb()
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const items = db.prepare(`
  SELECT DISTINCT i.id, i.title, i.url FROM story s
  JOIN story_item si ON si.story_id = s.id
  JOIN item i ON i.id = si.item_id
  WHERE (s.body_md IS NULL OR s.body_md='')
    AND i.url IS NOT NULL AND i.url != ''
    AND (SELECT COUNT(*) FROM item_block b WHERE b.item_id = i.id) = 0
    AND NOT EXISTS (SELECT 1 FROM claim c WHERE c.item_id = i.id)
`).all()
console.log('title-only items:', items.length)
const insBlock = db.prepare('INSERT OR REPLACE INTO item_block(item_id,idx,text,char_start,char_end,kind) VALUES (?,?,?,?,?,?)')
const report = []
async function fetchOne (it) {
  try {
    const res = await fetch(it.url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(25000) })
    if (!res.ok) return { id: it.id, error: 'HTTP ' + res.status }
    const ct = res.headers.get('content-type') || ''
    if (!/text\/html|application\/xhtml/.test(ct)) return { id: it.id, error: 'not-html' }
    const blocks = extractMainText(await res.text()).filter(b => b.length >= 60)
    const text = blockText(blocks)
    if (text.length < 300) return { id: it.id, error: 'too-short', chars: text.length }
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM item_block WHERE item_id=?').run(it.id)
      let off = 0
      blocks.forEach((b, i) => { insBlock.run(it.id, i, b, off, off + b.length, 'paragraph'); off += b.length + 1 })
      db.prepare("UPDATE item SET content_source='fetched-full', segment_count=?, char_count=?, description=? WHERE id=?").run(blocks.length, text.length, text.slice(0, 400), it.id)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return { id: it.id, ok: true, blocks: blocks.length, chars: text.length }
  } catch (e) { return { id: it.id, error: String(e.message).slice(0, 60) } }
}
const CONC = 6
let idx = 0
async function worker () { while (idx < items.length) { const it = items[idx++]; report.push(await fetchOne(it)) } }
await Promise.all(Array.from({ length: CONC }, worker))
const ok = report.filter(r => r.ok)
console.log(JSON.stringify({ total: items.length, fetched: ok.length, failed: report.filter(r => r.error).length, total_chars: ok.reduce((a, r) => a + r.chars, 0), failures: report.filter(r => r.error).slice(0, 8) }, null, 1))
db.close()
