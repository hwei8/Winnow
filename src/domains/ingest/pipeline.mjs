// ingest/pipeline.mjs — 入库流水线：抓取 → 抽取 → 归簇 → 链接判定 → 新建/并入/更新
import { createHash } from 'node:crypto'
import { openDb, nowIso } from '../../shared/db.mjs'
import { htmlToBlocks, blockText, locate } from './feed.mjs'
import { extractMainText } from './extract.mjs'
import { fetchPage } from './page.mjs'
import { chat, extractJson } from '../../providers/llm.mjs'
import { assignClaimsToFacts } from '../knowledge/facts.mjs'
import { linkIncoming } from '../knowledge/link.mjs'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const db = openDb()
const h = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const SOURCE = 'src:pipeline'
db.exec(`CREATE TABLE IF NOT EXISTS ingest_decision (
  item_id TEXT PRIMARY KEY, action TEXT, parent_story_id TEXT, same_event REAL,
  gap_count INTEGER, claims INTEGER, decided_at TEXT
)`)
const insDecision = db.prepare('INSERT OR REPLACE INTO ingest_decision(item_id,action,parent_story_id,same_event,gap_count,claims,decided_at) VALUES (?,?,?,?,?,?,?)')
db.prepare('INSERT OR REPLACE INTO source(id,adapter_id,name,external_id,tier,lang) VALUES (?,?,?,?,?,?)').run(SOURCE, 'pipeline', '入库流水线', 'pipeline', 2, null)

const insItem = db.prepare(`INSERT OR REPLACE INTO item(id,source_id,url,title,author,published_at,published_ts,media_kind,description,dir,segment_count,char_count,content_source,lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insBlock = db.prepare('INSERT OR REPLACE INTO item_block(item_id,idx,text,char_start,char_end,kind) VALUES (?,?,?,?,?,?)')
const insClaim = db.prepare(`INSERT OR REPLACE INTO claim(id,story_id,item_id,text,kind,subject,predicate,object_text,confidence,extractor,created_at,object_value_json,is_meta,status,asserted_at,source_tier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insEv = db.prepare('INSERT OR REPLACE INTO claim_evidence(claim_id,item_id,stance,segment_from,segment_to,time_start,time_end,frame_id,excerpt,verified) VALUES (?,?,?,?,?,?,?,?,?,?)')

function titleOf (html) { const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i); return m ? m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '(无标题)' }
const cleanBlocks = (blocks) => blocks.map(b => b.replace(/\s+/g, ' ').trim()).filter(b => b.length >= 80).filter(b => !/^(cookie|privacy|subscribe|sign in|log in|advertisement)/i.test(b))

// ── 阶段 1：抓取落库 ─────────────────────────────────────
async function ingest (url) {
  const existingId = 'src:pipeline:' + h(url)
  const existing = db.prepare('SELECT id,title FROM item WHERE id=?').get(existingId)
  if (existing) {
    const blocks = db.prepare('SELECT text FROM item_block WHERE item_id=? ORDER BY idx').all(existingId).map(r => r.text)
    const claims = db.prepare('SELECT COUNT(*) c FROM claim WHERE item_id=?').get(existingId).c
    if (blocks.length && claims > 0) return { url, id: existingId, title: existing.title, text: blocks.join('\n'), blocks, reused: true }
  }
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(25000) })
  if (!res.ok) return { url, error: 'HTTP ' + res.status }
  const html = await res.text()
  let blocks = cleanBlocks(extractMainText(html))
  let text = blockText(blocks)
  if (text.length < 400) {
    try {
      const p = await fetchPage(url)
      blocks = p.blocks; text = p.text
    } catch {}
  }
  if (text.length < 400) return { url, error: 'too-short', chars: text.length }
  const id = 'src:pipeline:' + h(url)
  const title = titleOf(html).slice(0, 220)
  insItem.run(id, SOURCE, url, title, null, null, null, 'article', text.slice(0, 300), null, blocks.length, text.length, 'fetched-full', /[\u4e00-\u9fa5]/.test(text) ? 'zh' : 'en')
  db.prepare('DELETE FROM item_block WHERE item_id=?').run(id)
  let off = 0
  blocks.forEach((b, i) => { insBlock.run(id, i, b, off, off + b.length, 'paragraph'); off += b.length + 1 })
  return { url, id, title, text, blocks }
}

// ── 阶段 2：抽 claim ────────────────────────────────────
async function extractClaims (item) {
  const full = item.text
  const r = await chat({ json: true, maxTokens: 10000, messages: [{ role: 'user', content: `从下面内容抽取最多 15 条原子事实，每条给逐字 quote（≥10 字），text 用简体中文。只输出 JSON：{"claims":[{"text":"...","quote":"...","confidence":0.8}]}\n\n${full.slice(0, 7000)}` }] })
  const p = extractJson(r.content)
  const ids = []
  for (const c of (p?.claims || [])) {
    const t = String(c.text || '').trim(), q = String(c.quote || '').trim()
    if (t.length < 8 || q.length < 8) continue
    const pos = locate(full, q)
    if (!pos) continue
    const cid = 'claim:' + item.id + ':' + h(t).slice(0, 6)
    insClaim.run(cid, null, item.id, t, 'fact', '', '', '', Number.isFinite(c.confidence) ? c.confidence : 0.5, 'llm:deepseek-v4.1-flash', nowIso(), null, 0, 'active', null, 2)
    insEv.run(cid, item.id, 'supports', pos[0], pos[1], null, null, null, q.slice(0, 500), 1)
    ids.push(cid)
  }
  return ids
}

// ── 阶段 3/4：归簇 + 链接判定 + 执行 ─────────────────────
async function decideAndApply (item, claimIds) {
  const { assigned, created } = await assignClaimsToFacts(db, claimIds)
  const factIds = db.prepare(`SELECT fact_id FROM claim WHERE id IN (${claimIds.map(() => '?').join(',')}) AND fact_id IS NOT NULL`).all(...claimIds).map(r => r.fact_id)
  if (factIds.length < 2) return { item: item.id, decision: 'new', reason: 'too-few-facts', facts: factIds.length }
  const link = await linkIncoming({ title: item.title, body: item.text, factIds })
  const action = link.action
  const parentId = link.parent?.id || null
  // 记录链接
  if (parentId) db.prepare('INSERT OR REPLACE INTO story_link(story_id,related_story_id,relation,same_event_prob,overlap,gap_count,gap_facts_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(item.id, parentId, action, link.parent.same_event, link.parent.cos, (link.parent.gap || []).length, JSON.stringify((link.parent.gap || []).map(g => g.id)), nowIso())
  insDecision.run(item.id, action, parentId, link.parent?.same_event ?? null, (link.parent?.gap || []).length, claimIds.length, nowIso())
  if (action === 'duplicate') {
    return { item: item.id, decision: 'duplicate', parent: link.parent?.title, same_event: link.parent?.same_event, gap: 0, assigned, created }
  }
  if (action === 'update') {
    const gapIds = (link.parent?.gap || []).map(g => g.id)
    // 立即把缺口事实记入母 Story 的 story_fact（供下一轮去重判定为 duplicate）
    const insSf = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    db.exec('BEGIN')
    try {
      for (const fid of gapIds) insSf.run(parentId, fid, null, 0, 0, 'update', 0)
      db.prepare('INSERT OR REPLACE INTO story_update(id,story_id,at,change_type,detail_json) VALUES (?,?,?,?,?)')
        .run(`ingest-update:${item.id}`, parentId, nowIso(), 'new_facts', JSON.stringify({ from_item: item.id, facts: gapIds }))
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK') }
    return { item: item.id, decision: 'update', parent: link.parent?.title, same_event: link.parent?.same_event, gap: gapIds.length, gap_facts: gapIds, assigned, created }
  }
  return { item: item.id, decision: 'new', facts: factIds.length, assigned, created }
}

// ── 执行 ────────────────────────────────────────────────
const URLS = (process.env.URLS || '').split(',').map(s => s.trim()).filter(Boolean)
// 已有条目（adapter 采集后）直接抽取，跳过抓取
const ITEMS = (process.env.ITEMS || '').split(',').map(s => s.trim()).filter(Boolean)
console.log('URLs:', URLS.length, '| items:', ITEMS.length)
const report = []
if (ITEMS.length) {
  const loadItem = (id) => {
    const row = db.prepare('SELECT id,title,url FROM item WHERE id=?').get(id)
    if (!row) return null
    const blocks = db.prepare('SELECT text FROM item_block WHERE item_id=? ORDER BY idx').all(id).map(r => r.text)
    return { id, title: row.title, url: row.url, blocks, text: blocks.join('\n') }
  }
  for (const id of ITEMS) {
    try {
      const item = loadItem(id)
      if (!item || item.text.length < 200) { report.push({ item: id, stage: 'load', error: 'missing-or-short' }); continue }
      const claimIds = db.prepare('SELECT COUNT(*) c FROM claim WHERE item_id=?').get(id).c > 0
        ? db.prepare('SELECT id FROM claim WHERE item_id=?').all(id).map(r => r.id)
        : await extractClaims(item)
      const decision = await decideAndApply(item, claimIds)
      report.push({ item: id, title: item.title.slice(0, 60), claims: claimIds.length, ...decision })
      console.error('  ', item.title.slice(0, 40), '→', decision.decision, decision.parent ? `(${decision.parent})` : '')
    } catch (e) { report.push({ item: id, error: String(e.message).slice(0, 100) }) }
  }
}
for (const url of URLS) {
  try {
    const item = await ingest(url)
    if (item.error) { report.push({ url, stage: 'fetch', error: item.error }); continue }
    const claimIds = item.reused
      ? db.prepare('SELECT id FROM claim WHERE item_id=?').all(item.id).map(r => r.id)
      : await extractClaims(item)
    const decision = await decideAndApply(item, claimIds)
    report.push({ url, title: item.title.slice(0, 60), claims: claimIds.length, ...decision })
    console.error('  ', item.title.slice(0, 40), '→', decision.decision, decision.parent ? `(${decision.parent})` : '')
  } catch (e) { report.push({ url, error: String(e.message).slice(0, 100) }) }
}
console.log(JSON.stringify({ urls: URLS.length }, null, 1))
console.log(JSON.stringify(report, null, 1))
db.close()
