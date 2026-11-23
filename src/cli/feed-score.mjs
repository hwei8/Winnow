// cli/feed-score.mjs — 候选 RSS 源评分：正文可得性 / 更新量 / 与库内重复率
// 用法：node src/cli/feed-score.mjs [--per-feed=10] [--probe-fetch=2] [--only=关键字] [--json]
// 输出：out/feed-score-<时间>.md + JSON，并在 stdout 打印评分表
import fs from 'node:fs'
import path from 'node:path'
import { parseFeed, htmlToBlocks, blockText } from '../domains/ingest/feed.mjs'
import { fetchPage } from '../domains/ingest/page.mjs'
import { openDb } from '../shared/db.mjs'
import { embedTexts } from '../domains/knowledge/facts.mjs'
import { outFile } from '../shared/config.mjs'

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const arg = (k, d) => {
  const p = process.argv.find(a => a.startsWith(`--${k}=`))
  if (p) return p.slice(k.length + 3)
  const i = process.argv.indexOf(`--${k}`)
  if (i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  return d
}
const PER_FEED = Number(arg('per-feed', 10))
const PROBE_FETCH = Number(arg('probe-fetch', 2))
const ONLY = arg('only', '')
const SEMANTIC = true
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const CANDIDATES = [
  // —— 中文科技 / 商业（全文型居多）
  { name: '36氪（官方全文）', url: 'https://www.36kr.com/feed', lang: 'zh', topic: '科技商业' },
  { name: '钛媒体', url: 'https://www.tmtpost.com/rss', lang: 'zh', topic: '科技商业' },
  { name: '极客公园', url: 'https://www.geekpark.net/rss', lang: 'zh', topic: '科技商业' },
  { name: '爱范儿', url: 'https://www.ifanr.com/feed', lang: 'zh', topic: '消费科技' },
  { name: '雷锋网', url: 'https://www.leiphone.com/feed', lang: 'zh', topic: 'AI/科技' },
  { name: 'IT之家', url: 'https://www.ithome.com/rss/', lang: 'zh', topic: '消费科技' },
  { name: 'Solidot', url: 'https://www.solidot.org/index.rss', lang: 'zh', topic: '科技社区' },
  { name: '少数派', url: 'https://sspai.com/feed', lang: 'zh', topic: '效率工具' },
  { name: '量子位', url: 'https://www.qbitai.com/feed', lang: 'zh', topic: 'AI' },
  { name: '36氪快讯（现用）', url: 'https://rss.injahow.cn/36kr/newsflashes', lang: 'zh', topic: '快讯' },
  { name: '知乎热榜（现用）', url: 'https://rss.injahow.cn/zhihu/hotlist', lang: 'zh', topic: '社区热榜' },
  // —— 英文科技 / 深度
  { name: 'SemiAnalysis', url: 'https://www.semianalysis.com/feed', lang: 'en', topic: '芯片/算力' },
  { name: 'Cloudflare Blog', url: 'https://blog.cloudflare.com/rss/', lang: 'en', topic: '基础设施' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', lang: 'en', topic: '消费科技' },
  { name: 'Ars Technica', url: 'https://arstechnica.com/feed/', lang: 'en', topic: '科技深度' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', lang: 'en', topic: '创投' },
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage', lang: 'en', topic: '技术社区' },
  { name: 'Lobsters', url: 'https://lobste.rs/rss', lang: 'en', topic: '技术社区' },
  // —— 官方 / 一手
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', lang: 'en', topic: 'AI 官方' },
  { name: 'Google AI Blog', url: 'https://blog.google/technology/ai/rss/', lang: 'en', topic: 'AI 官方' },
  { name: 'HuggingFace Blog', url: 'https://huggingface.co/blog/feed.xml', lang: 'en', topic: 'AI 官方' },
  { name: 'NVIDIA Blog', url: 'https://blogs.nvidia.com/feed/', lang: 'en', topic: 'AI 芯片' },
  // —— 财经 / 宏观
  { name: '华尔街日报·市场', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', lang: 'en', topic: '财经' },
  { name: 'Economist·Finance', url: 'https://www.economist.com/finance-and-economics/rss.xml', lang: 'en', topic: '宏观' },
  { name: 'NYT Technology（现用）', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', lang: 'en', topic: '科技' },
  // —— 国际 / 中文新闻
  { name: 'BBC 中文', url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', lang: 'zh', topic: '国际' },
  { name: '联合早报·国际', url: 'https://www.zaobao.com.sg/rss/realtime/world', lang: 'zh', topic: '国际' }
]

function strip (html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim()
}
function bigrams (s) {
  const t = String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}
function jaccard (a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

async function fetchXml (url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(25000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

async function scoreFeed (cand, known) {
  const out = { ...cand, ok: false, items: 0, avgChars: 0, feedFullRatio: 0, fetchFullRatio: 0, dupRate: 0, perDay: 0, err: '' }
  let xml
  try { xml = await fetchXml(cand.url) } catch (e) { out.err = e.message.slice(0, 60); return out }
  let items
  try { items = parseFeed(xml) } catch (e) { out.err = 'parse: ' + e.message.slice(0, 40); return out }
  if (!items.length) { out.err = 'no items'; return out }
  out.ok = true
  out.items = items.length
  const sample = items.slice(0, PER_FEED)
  const texts = []
  let fullByFeed = 0
  for (const it of sample) {
    const raw = it.content && strip(it.content).length > strip(it.description || '').length ? it.content : (it.description || '')
    const txt = strip(raw)
    texts.push({ it, txt })
    if (txt.length >= 800) fullByFeed++
  }
  out.avgChars = Math.round(texts.reduce((s, x) => s + x.txt.length, 0) / Math.max(1, texts.length))
  out.feedFullRatio = +(fullByFeed / Math.max(1, texts.length)).toFixed(2)

  // 摘要型：探针抓正文，测「抓得到」比例
  if (fullByFeed < texts.length) {
    const probes = texts.filter(x => x.txt.length < 800).slice(0, PROBE_FETCH)
    let ok = 0
    const lens = []
    for (const p of probes) {
      if (!p.it.link) continue
      try {
        const page = await fetchPage(p.it.link, { allowFallback: true })
        if (page.text.length >= 800) { ok++; lens.push(page.text.length) }
        else lens.push(page.text.length)
      } catch { /* ignore */ }
    }
    out.fetchFullRatio = probes.length ? +(ok / probes.length).toFixed(2) : 0
    out.fetchChars = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0
  }

  // 重复率：标题 bigram / URL vs 库内 item/story
  let dup = 0
  for (const { it } of texts) {
    const bg = bigrams(it.title)
    let hit = known.urls.has(String(it.link || '').replace(/\/$/, ''))
    for (const k of known) {
      if (jaccard(bg, k.bg) >= 0.6) { hit = true; break }
    }
    if (hit) dup++
  }
  out.dupRate = +(dup / Math.max(1, texts.length)).toFixed(2)

  // 语义重复率：标题+首段 与库内 Story 正文向量（out/story-vectors.json）比 cos
  out.semDupRate = 0
  if (SEMANTIC && !process.argv.includes('--no-semantic')) {
    try {
      const vs = loadStoryVecs()
      if (vs.length) {
        const vecs = await embedTexts(texts.map(x => (x.it.title + '。' + x.txt).slice(0, 300)))
        let hit = 0
        for (const v of vecs) {
          let mx = 0
          for (const s of vs) { let d = 0; for (let i = 0; i < v.length; i++) d += v[i] * s.v[i]; if (d > mx) mx = d }
          if (mx >= 0.78) hit++
        }
        out.semDupRate = +(hit / texts.length).toFixed(2)
      }
    } catch (e) { out.semErr = e.message.slice(0, 50) }
  }

  // 更新量：pubDate 跨度
  const times = sample.map(it => Date.parse(it.pubDate)).filter(t => Number.isFinite(t)).sort((a, b) => a - b)
  if (times.length >= 2) {
    const days = Math.max(0.5, (times.at(-1) - times[0]) / 86400000)
    out.perDay = +(times.length / days).toFixed(1)
  } else out.perDay = out.items >= PER_FEED ? PER_FEED : out.items

  // 摘要型源：用实测抓取字数折算正文深度
  const fetched = out.fetchChars || 0
  const fullPart = out.avgChars * out.feedFullRatio
  const recapPart = fetched * (1 - out.feedFullRatio) * (out.fetchFullRatio || 0)
  out.effChars = Math.round(fullPart + recapPart)
  out.estClaims = Math.round(out.effChars / 600)
  const dupAll = Math.min(0.95, out.dupRate + (out.semDupRate || 0) * 0.9)
  out.dupAll = +dupAll.toFixed(2)
  out.perDayGood = +(out.perDay * (1 - dupAll) * Math.min(1, out.effChars / 1200)).toFixed(1)
  const depth = Math.min(1, out.effChars / 2500)
  const volume = Math.min(1, out.perDayGood / 8)
  const novelty = 1 - dupAll
  out.score = Math.round(100 * (0.45 * depth + 0.25 * volume + 0.30 * novelty))
  out.verdict = out.score >= 70 ? '订' : out.score >= 50 ? '试' : '弃'
  return out
}

function loadStoryVecs () {
  const p = outFile('story-vectors.json')
  if (!fs.existsSync(p)) return []
  const j = JSON.parse(fs.readFileSync(p))
  return Object.values(j).filter(Array.isArray).map(v => ({ v: Float32Array.from(v) }))
}

function loadKnown () {
  const db = openDb()
  const rows = [
    ...db.prepare('select title from item where title is not null').all(),
    ...db.prepare('select title from story where title is not null').all()
  ]
  const urls = new Set(db.prepare('select url from item where url is not null').all().map(r => String(r.url).replace(/\/$/, '')))
  return Object.assign(rows.map(r => ({ bg: bigrams(r.title) })).filter(x => x.bg.size), { urls })
}

async function main () {
  const known = loadKnown()
  const cands = ONLY ? CANDIDATES.filter(c => (c.name + c.topic).includes(ONLY)) : CANDIDATES
  const rows = []
  for (const c of cands) {
    const r = await scoreFeed(c, known)
    rows.push(r)
    process.stderr.write(`  ${r.name} → ${r.ok ? r.score + ' ' + r.verdict : 'ERR ' + r.err}\n`)
  }
  rows.sort((a, b) => b.score - a.score)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
    fs.writeFileSync(outFile(`feed-score-${stamp}.json`), JSON.stringify(rows, null, 2))
  const md = []
  md.push(`# RSS 源评分（${new Date().toISOString().slice(0, 16).replace('T', ' ')}）\n`)
  md.push(`口径：每源取最新 ${PER_FEED} 条；\`字数\`=feed 自带正文字数；\`抓取\`=feed 不足 800 字时抓页成功率；\`重复\`=标题与库内 item/story 相似度≥0.6 的比例；\`日供\`=每日可用条数（已扣重复与深度）；\`估 claim\`=按 600 字/条折算。\n`)
  md.push('| 源 | 域 | 语言 | 条数 | 字数 | 抓取 | 重复(字面/语义) | 日供 | 估 claim | 评分 | 结论 |')
  md.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    if (!r.ok) { md.push(`| ${r.name} | ${r.topic} | ${r.lang} | — | — | — | — | — | — | — | 不可用（${r.err}） |`); continue }
    md.push(`| ${r.name} | ${r.topic} | ${r.lang} | ${r.items} | ${r.avgChars} | ${r.feedFullRatio >= 1 ? '全文' : (r.fetchFullRatio || 0) * 100 + '%'} | ${r.dupRate * 100}% / ${(r.semDupRate || 0) * 100}% | ${r.perDayGood} | ${r.estClaims} | ${r.score} | ${r.verdict} |`)
  }
  const sum = rows.filter(r => r.ok).reduce((s, r) => s + r.perDayGood, 0)
  md.push(`\n合计日供（全部可订源）：**${sum.toFixed(1)} 条/天**；按 0.59 Story/item 折算 ≈ **${(sum * 0.59).toFixed(0)} 篇 Story/天**。`)
  const file = outFile(`feed-score-${stamp}.md`)
  fs.writeFileSync(file, md.join('\n'))
  console.log(md.join('\n'))
  console.log('\n写入：' + file)
}

main().catch(e => { console.error(e); process.exit(1) })
