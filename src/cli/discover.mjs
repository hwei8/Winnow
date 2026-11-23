// cli/discover.mjs — 搜索型发现：按 config/search_queries.txt 跑 DeepSeek 搜索，过滤后入队
//
// 用法：
//   node search_discover.mjs                    # 只发现，打印候选
//   node search_discover.mjs --enqueue          # 入 ingest_queue（worker_ingest 消费）
//   node search_discover.mjs --query "..." --count 10
//   node search_discover.mjs --topic 英伟达与AI芯片 --days 3
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, nowIso } from '../shared/db.mjs'
import { search } from '../providers/search.mjs'
import { enqueue } from '../domains/ingest/queue.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] ?? true) : d }
const flag = k => argv.includes('--' + k)

const CONFIG = arg('config', path.join(HERE, 'config/search_queries.txt'))
const DEFAULTS = {
  count: Number(arg('count', 10)),
  maxItems: Number(arg('max', 6)),
  days: Number(arg('days', 7)),
  minAuthority: Number(arg('min-authority', -1)),
  minScore: Number(arg('min-score', 0)),
  dedupeDays: Number(arg('dedupe-days', 7))
}

function parseConfig (text) {
  const lines = text.split(/\r?\n/)
  const globalFilter = { words: [], sites: [] }
  const topics = []
  let section = null
  let cur = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^\[GLOBAL_FILTER\]$/i.test(line)) { section = 'global'; cur = null; continue }
    if (/^\[SEARCH_TOPICS\]$/i.test(line)) { section = 'topics'; cur = null; continue }
    if (section === 'global') {
      if (/^-site:/i.test(line)) globalFilter.sites.push(line.slice(6).toLowerCase())
      else if (line.startsWith('!')) globalFilter.words.push(line.slice(1))
      continue
    }
    if (section !== 'topics') continue
    const isName = /^\[.+\]$/.test(line)
    if (!cur || (isName && (cur.name || cur.queries.length))) {
      cur = { name: '', queries: [], exclude: [], sites: [], blockSites: [], max: DEFAULTS.maxItems, days: DEFAULTS.days, provider: 'deepseek' }
      topics.push(cur)
    }
    if (isName) { cur.name = line.slice(1, -1); continue }
    if (line.startsWith('@provider:')) { cur.provider = line.slice(10); continue }
    if (/^@\d+$/.test(line)) { cur.max = Number(line.slice(1)); continue }
    if (/^~\d+d$/i.test(line)) { cur.days = Number(line.slice(1, -1)); continue }
    if (/^-site:/i.test(line)) { cur.blockSites.push(line.slice(6).toLowerCase()); continue }
    if (/^site:/i.test(line)) { cur.sites.push(line.slice(5).toLowerCase()); continue }
    if (line.startsWith('!')) { cur.exclude.push(line.slice(1)); continue }
    cur.queries.push(line)
  }
  return { globalFilter, topics: topics.filter(t => t.queries.length) }
}

const normTitle = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

function hostOf (u) { try { return new URL(u).hostname.toLowerCase() } catch { return '' } }
function withinDays (iso, days) {
  if (!days || days <= 0) return true
  if (!iso) return true
  const t = Date.parse(iso)
  return !Number.isFinite(t) || Date.now() - t <= days * 86400e3
}
function hitsWord (text, w) { return text.includes(String(w).toLowerCase()) }

const db = openDb()
const knownUrls = new Set(db.prepare('SELECT url FROM item WHERE url IS NOT NULL').all().map(r => r.url))
const pendingUrls = new Set(db.prepare("SELECT url FROM ingest_queue WHERE status IN ('queued','running')").all().map(r => r.url))
const recentTitles = new Set(db.prepare('SELECT title FROM item WHERE published_ts > ?').all(Math.floor(Date.now() / 1000) - DEFAULTS.dedupeDays * 86400).map(r => normTitle(r.title)))

let onlyTopic = arg('topic', null)
let oneQuery = arg('query', null)
const out = []

if (oneQuery) {
  const r = await search({ query: oneQuery, count: DEFAULTS.count })
  out.push({ topic: '(直接查询)', query: oneQuery, results: r.results })
} else {
  const cfg = parseConfig(readFileSync(CONFIG, 'utf8'))
  for (const t of cfg.topics) {
    if (onlyTopic && t.name !== onlyTopic) continue
    const seen = new Set()
    const picked = []
    for (const q of t.queries) {
      let r
      try { r = await search({ query: q, count: Math.max(DEFAULTS.count, t.max * 3) }) } catch (e) { console.error('[search] fail:', q, String(e.message).slice(0, 80)); continue }
      for (const x of r.results) {
        if (seen.has(x.url)) continue
        seen.add(x.url)
        const title = x.title
        const text = (title + ' ' + x.snippet).toLowerCase()
        if (!withinDays(x.publishedAt, t.days)) continue
        if (t.sites.length && !t.sites.some(s => hostOf(x.url).endsWith(s))) continue
        if (t.blockSites.some(s => hostOf(x.url).endsWith(s))) continue
        if (cfg.globalFilter.sites.some(s => hostOf(x.url).endsWith(s))) continue
        if ([...cfg.globalFilter.words, ...t.exclude].some(w => hitsWord(text, w))) continue
        if (x.authority !== null && x.authority < DEFAULTS.minAuthority) continue
        if (x.score !== null && x.score < DEFAULTS.minScore) continue
        if (knownUrls.has(x.url) || pendingUrls.has(x.url)) continue
        if (recentTitles.has(normTitle(title))) continue
        picked.push(x)
        if (picked.length >= t.max) break
      }
      if (picked.length >= t.max) break
    }
    out.push({ topic: t.name || t.queries[0], query: t.queries.join(' | '), results: picked })
  }
}

const dir = path.join(HERE, 'out/search'); mkdirSync(dir, { recursive: true })
const file = path.join(dir, `search-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`)
writeFileSync(file, JSON.stringify({ at: nowIso(), config: CONFIG, topics: out }, null, 2))

if (flag('json')) {
  const urls = out.flatMap(t => t.results.map(x => x.url))
  if (flag('enqueue')) for (const u of urls) enqueue(db, u, 'search')
  console.log(JSON.stringify({ tool: 'search_discover', urls, topics: out.map(t => ({ name: t.topic, n: t.results.length })), file: path.relative(HERE, file) }))
  db.close()
  process.exit(0)
}

let total = 0
for (const t of out) {
  console.log(`\n## ${t.topic}  (${t.results.length})`)
  for (const x of t.results) {
    total++
    console.log(`- [${x.authority ?? '-'}|${x.score?.toFixed(2) ?? '-'}] ${x.title.slice(0, 70)}  ${x.site}  ${x.publishedAt?.slice(0, 10) ?? ''}`)
    console.log(`    ${x.url}`)
    if (flag('enqueue')) enqueue(db, x.url, 'search')
  }
}
console.log(`\n候选 ${total} 条；${flag('enqueue') ? '已入队' : '未入队（加 --enqueue 入库）'}；明细 ${path.relative(HERE, file)}`)
db.close()
