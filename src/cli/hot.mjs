// cli/hot.mjs — 热榜跟踪：抓 newsnow 各平台，记录排名历史与热度
//
// 用法：
//   node hot_track.mjs                          # 抓全部平台，入库并打印 Top
//   node hot_track.mjs --platforms weibo,zhihu  # 只抓指定平台
//   node hot_track.mjs --top 20                 # 打印前 N
//   node hot_track.mjs --promote 3 --platform thepaper   # 把前 3 条文章入队（走完整正文抽取）
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { openDb, nowIso } from '../shared/db.mjs'
import { fetchHot, PLATFORMS } from '../domains/ingest/adapters/newsnow.mjs'
import { enqueue } from '../domains/ingest/queue.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const eq = argv.find(a => a.startsWith('--' + k + '='))
  if (eq) return eq.slice(k.length + 3)
  const i = argv.indexOf('--' + k)
  return i >= 0 ? (argv[i + 1] ?? true) : d
}

const only = arg('platforms') ? String(arg('platforms')).split(',').map(s => s.trim()).filter(Boolean) : null
const topN = Number(arg('top', 15))
const promoteN = Number(arg('promote', 0))
const promotePlatform = arg('platform')
const db = openDb()

const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 12)
const targets = only ? PLATFORMS.filter(p => only.includes(p.id)) : PLATFORMS
const at = nowIso()
const rows = []
const errors = []

for (const p of targets) {
  let d
  try { d = await fetchHot(p.id) } catch (e) { errors.push({ platform: p.id, error: String(e.message).slice(0, 60) }); continue }
  d.items.forEach((it, i) => {
    const url = it.url || it.mobileUrl
    if (!url || !it.title) return
    rows.push({ platform: p.id, platformName: p.name, url, mobile_url: it.mobileUrl || null, title: String(it.title).trim(), rank: i + 1 })
  })
}

const upsert = db.prepare(`
INSERT INTO hot_entry(id,platform,url,title,mobile_url,first_seen,last_seen,appearances,best_rank,last_rank,heat)
VALUES (?,?,?,?,?,?,?,1,?,?,0)
ON CONFLICT(platform,url) DO UPDATE SET
  last_seen=excluded.last_seen,
  appearances=hot_entry.appearances+1,
  best_rank=MIN(COALESCE(hot_entry.best_rank, 999), excluded.best_rank),
  last_rank=excluded.last_rank,
  title=excluded.title
`)
const getEntry = db.prepare('SELECT * FROM hot_entry WHERE platform=? AND url=?')
const insRank = db.prepare('INSERT OR REPLACE INTO hot_rank(entry_id,rank,at) VALUES (?,?,?)')

let saved = 0
for (const r of rows) {
  const id = 'hot:' + hash(r.platform + '|' + r.url)
  upsert.run(id, r.platform, r.url, r.title, r.mobile_url, at, at, r.rank, r.rank)
  insRank.run(id, r.rank, at)
  saved++
}

// 热度：排名 0.6 + 出现频次 0.3 + 趋势 0.1
const all = db.prepare("SELECT * FROM hot_entry WHERE last_seen >= ?").all(at)
const upd = db.prepare('UPDATE hot_entry SET heat=? WHERE id=?')
for (const e of all) {
  const rankScore = Math.max(0, 1 - (e.last_rank - 1) / 50)
  const freq = Math.min(1, (e.appearances - 1) / 5)
  const trend = e.best_rank && e.last_rank ? Math.max(-1, Math.min(1, (e.best_rank - e.last_rank) / 10)) : 0
  const heat = Math.round((0.6 * rankScore + 0.3 * freq + 0.1 * (trend + 1) / 2) * 1000) / 1000
  upd.run(heat, e.id)
  e.heat = heat
}

db.prepare('INSERT OR REPLACE INTO hot_crawl(at,platforms,entries,errors) VALUES (?,?,?,?)')
  .run(at, targets.length, saved, errors.length ? JSON.stringify(errors) : null)

const dir = path.join(HERE, 'out/hot'); mkdirSync(dir, { recursive: true })
const file = path.join(dir, `hot-${at.slice(0, 16).replace(/[:T]/g, '')}.json`)
writeFileSync(file, JSON.stringify({ at, platforms: targets.map(p => p.id), entries: all.length, rows, errors }, null, 2))

const top = [...all].sort((a, b) => b.heat - a.heat).slice(0, topN)
console.log(`抓取 ${targets.length} 个平台，${saved} 条，错误 ${errors.length}；热度 Top ${top.length}`)
for (const e of top) {
  console.log(`  ${e.heat.toFixed(3)}  P${String(e.last_rank).padStart(2)}  x${e.appearances}  ${e.platform.padEnd(18)} ${e.title.slice(0, 42)}`)
  console.log(`         ${e.url}`)
}

const jsonMode = argv.includes('--json')
const promotedUrls = []
if (promoteN > 0) {
  const fresh = all.filter(e => !e.promoted_item_id)
  const pool = promotePlatform
    ? fresh.filter(e => e.platform === promotePlatform)
    : fresh.filter(e => !/weibo\.com|zhihu\.com|douyin\.com|bilibili\.com|tieba\.baidu\.com/.test(e.url))
  const picked = pool.sort((a, b) => b.heat - a.heat).slice(0, promoteN)
  for (const e of picked) {
    const q = enqueue(db, e.url, 'hot')
    db.prepare('UPDATE hot_entry SET promoted_item_id=? WHERE id=?').run(q.id, e.id)
    if (!q.reused) promotedUrls.push(e.url)
    if (!jsonMode) console.log(`+ 入队 ${e.title.slice(0, 40)}  ${q.reused ? '(已存在)' : q.id}`)
  }
}
if (errors.length) console.log('errors:', JSON.stringify(errors))
if (!jsonMode) console.log('明细', path.relative(HERE, file))
if (jsonMode) console.log(JSON.stringify({ tool: 'hot_track', urls: promotedUrls, entries: all.length, file: path.relative(HERE, file) }))
db.close()
