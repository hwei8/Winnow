// cli/ingest.mjs — 入库流水线：抓取 → 抽取 → 归簇 → 链接判定 → 新建/并入/更新
//
//   URLS=https://a,https://b node src/cli/ingest.mjs   # 抓取并入库
//   ITEMS=item:xxx node src/cli/ingest.mjs             # adapter 已入库的条目，直接抽取
//
// 最后一行输出 `REPORT_JSON <json>`，供 worker 机读（不要靠解析人类可读输出）。
import { createHash } from 'node:crypto'
import { openDb, nowIso } from '../shared/db.mjs'
import { LLM_CHAT_MODEL } from '../shared/config.mjs'
import { extractClaimsFromText } from '../domains/ingest/claims.mjs'
import { loadArticle } from '../domains/ingest/page.mjs'
import { saveItem, itemIdFor, loadItem } from '../domains/ingest/store.mjs'
import { assignClaimsToFacts } from '../domains/knowledge/facts.mjs'
import { linkIncoming } from '../domains/knowledge/link.mjs'

const db = openDb()
const h = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const SOURCE = 'src:pipeline'
// ingest_decision 表由 shared/schema.mjs 定义（schema as code），这里不建表
const insDecision = db.prepare('INSERT OR REPLACE INTO ingest_decision(item_id,action,parent_story_id,same_event,gap_count,claims,decided_at) VALUES (?,?,?,?,?,?,?)')
db.prepare('INSERT OR IGNORE INTO source(id,adapter_id,name,external_id,tier,lang) VALUES (?,?,?,?,?,?)').run(SOURCE, 'pipeline', '入库流水线', 'pipeline', 2, null)

const insClaim = db.prepare(`INSERT OR REPLACE INTO claim(id,story_id,item_id,text,kind,subject,predicate,object_text,confidence,extractor,created_at,object_value_json,is_meta,status,asserted_at,source_tier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insEv = db.prepare('INSERT OR REPLACE INTO claim_evidence(claim_id,item_id,stance,segment_from,segment_to,time_start,time_end,frame_id,excerpt,verified) VALUES (?,?,?,?,?,?,?,?,?,?)')

// ── 阶段 1：抓取落库 ─────────────────────────────────────
async function ingest (url) {
  const id = itemIdFor(SOURCE, url)
  const existing = loadItem(db, id)
  if (existing && existing.blocks.length) {
    const claims = db.prepare('SELECT COUNT(*) c FROM claim WHERE item_id=?').get(id).c
    if (claims > 0) return { url, id, title: existing.title, text: existing.blocks.join('\n'), blocks: existing.blocks, reused: true }
  }
  // 直连抛错（网络抖动 / 反爬）与"抽出来太短"都走 loadArticle 的统一兜底：
  // 以前 fetchHtml 一抛错就直接 return，整条内容丢掉，而 DeepSeek fetch 通常能拿到正文。
  let blocks, text, title
  try {
    ({ blocks, text, title } = await loadArticle(url, { minChars: 400 }))
  } catch (e) {
    console.error('  [fetch]', url, String(e.message).slice(0, 80))
    const m = String(e.message)
    return { url, error: m.startsWith('too-short') ? 'too-short' : 'fetch-failed', chars: text ? text.length : 0 }
  }
  saveItem(db, { itemId: id, sourceId: SOURCE, url, title, blocks, text })
  return { url, id, title, text: blocks.join('\n'), blocks }
}

// ── 阶段 2：抽 claim（分块，见 domains/ingest/claims.mjs）───────────
async function extractClaims (item) {
  const claims = await extractClaimsFromText(item.text)
  const ids = []
  for (const c of claims) {
    const cid = 'claim:' + item.id + ':' + h(c.text).slice(0, 6)
    insClaim.run(cid, null, item.id, c.text, 'fact', '', '', '', c.confidence, `llm:${LLM_CHAT_MODEL}`, nowIso(), null, 0, 'active', null, 2)
    insEv.run(cid, item.id, 'supports', c.start, c.end, null, null, null, c.quote.slice(0, 500), 1)
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
  // 判定器不可用：不再猜，也不写 story_link（写下去就会被当成已决），条目退回队列等下一轮
  if (action === 'deferred') {
    db.prepare('INSERT OR REPLACE INTO ingest_decision(item_id,action,parent_story_id,same_event,gap_count,claims,decided_at) VALUES (?,?,?,?,?,?,?)')
      .run(item.id, 'deferred', null, null, 0, claimIds.length, nowIso())
    if (item.url) {
      db.prepare("INSERT OR IGNORE INTO ingest_queue(id,url,source,status,created_at) VALUES (?,?,?,?,?)")
        .run('q:retry:' + item.id.slice(-12), item.url, 'deferred', 'pending', nowIso())
    }
    return { item: item.id, decision: 'deferred', reason: link.reason || 'jev-unavailable', assigned, created }
  }
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
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const fid of gapIds) insSf.run(parentId, fid, null, 0, 0, 'update', 0)
      db.prepare('INSERT OR REPLACE INTO story_update(id,story_id,at,change_type,detail_json) VALUES (?,?,?,?,?)')
        .run(`ingest-update:${item.id}`, parentId, nowIso(), 'new_facts', JSON.stringify({ from_item: item.id, facts: gapIds }))
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
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
  for (const id of ITEMS) {
    try {
      const loaded = loadItem(db, id)
      const item = loaded && { id, title: loaded.title, url: loaded.url, blocks: loaded.blocks, text: loaded.blocks.join('\n') }
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
console.log('REPORT_JSON ' + JSON.stringify(report))
db.close()
