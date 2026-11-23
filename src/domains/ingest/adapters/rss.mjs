// adapters/rss.mjs — 通用 RSS adapter（17 个源，A 级全文 + B 级抓正文）
// 设计：feed 自带正文 ≥ FEED_MIN 直接入库；不足则抓页（DeepSeek Fetch 兜底）；再不足才降级用 feed 摘要
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from '../../../shared/config.mjs'
import { fetchHtml } from '../store.mjs'
import { parseFeed, htmlToBlocks, blockText } from '../feed.mjs'
import { fetchPage } from '../page.mjs'

const FEED_MIN = 700   // feed 正文达到此长度视为"全文源"，不再抓页
const PAGE_MIN = 400   // 抓页后低于此长度视为失败

/** 读取源清单（config/feeds.json）。 */
export function loadFeeds () {
  const raw = readFileSync(path.join(CONFIG_DIR, 'feeds.json'), 'utf8')
  const { feeds } = JSON.parse(raw)
  if (!Array.isArray(feeds) || !feeds.length) throw new Error('config/feeds.json: feeds[] is empty')
  return feeds
}

// 源清单在 config/feeds.json（环境与配置隔离）：A 级 = feed 自带全文，B 级 = 只有摘要需抓正文。
export const FEEDS = loadFeeds()

function feedBlocks (it) {
  const raw = (it.content && it.content.length > (it.description || '').length) ? it.content : (it.description || '')
  return htmlToBlocks(raw)
}

const ADAPTER = {
  id: 'rss',
  name: 'RSS',
  sourceId: 'src:rss',
  mediaKind: 'article',

  // 轮转取样：每个 feed 先取 perFeed 条，再按顺序合并，避免第一个源吃满 limit
  async list ({ limit = 20, source = null } = {}) {
    const feeds = source ? FEEDS.filter(f => f.sourceId === source || f.name === source) : FEEDS
    const perFeed = Math.max(1, Math.ceil(limit / Math.max(1, feeds.length)))
    const buckets = []
    for (const feed of feeds) {
      const bucket = []
      for (const url of feed.urls) {
        if (bucket.length >= perFeed) break
        try {
          const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }, signal: AbortSignal.timeout(20000) })
          if (!res.ok) continue
          const xml = await res.text()
          for (const it of parseFeed(xml)) {
            if (bucket.length >= perFeed) break
            const link = it.link || ''
            if (!link) continue
            bucket.push({
              url: link,
              title: it.title || '',
              externalId: it.guid || link,
              publishedAt: it.pubDate || null,
              sourceId: feed.sourceId,
              sourceName: feed.name,
              sourceTier: feed.tier,
              lang: feed.lang,
              _full: feed.full,
              _content: it.content || '',
              _description: it.description || ''
            })
          }
        } catch { /* 单 feed 失败不影响其它 */ }
      }
      buckets.push(bucket)
    }
    const out = []
    const maxLen = Math.max(0, ...buckets.map(b => b.length))
    for (let i = 0; i < maxLen && out.length < limit; i++) {
      for (const b of buckets) {
        if (out.length >= limit) break
        if (b[i]) out.push(b[i])
      }
    }
    return out
  },

  // 返回预归一化文档（adapter.collect 识别 blocks+text 后直接入库）
  async fetch (ref) {
    const it = { content: ref._content, description: ref._description }
    let blocks = feedBlocks(it)
    let text = blockText(blocks)
    if (text.length >= FEED_MIN) {
      return { title: ref.title, blocks, text, contentSource: 'feed-full' }
    }
    // 摘要型：抓页（直连 → DeepSeek Fetch 兜底）
    try {
      const page = await fetchPage(ref.url, { minChars: FEED_MIN, allowFallback: true })
      if (page.text.length >= PAGE_MIN) {
        return { title: ref.title || page.title, blocks: page.blocks, text: page.text, contentSource: 'page-fetched' }
      }
    } catch { /* fallthrough */ }
    if (text.length >= 200) return { title: ref.title, blocks, text, contentSource: 'feed-summary' }
    throw new Error('too-short: ' + text.length)
  },

  normalize (ref, page) {
    if (page && page.blocks) return page
    const blocks = feedBlocks({ content: ref._content, description: ref._description })
    const text = blockText(blocks)
    if (text.length < 200) throw new Error('too-short: ' + text.length)
    return { title: ref.title, blocks, text, contentSource: 'feed-summary' }
  },

  async health () {
    const t0 = Date.now()
    let okCount = 0
    for (const f of FEEDS) {
      try {
        const r = await fetch(f.urls[0], { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) })
        if (r.ok) okCount++
      } catch {}
    }
    return { ok: okCount > 0, latencyMs: Date.now() - t0, detail: `feeds ok ${okCount}/${FEEDS.length}` }
  }
}
export default ADAPTER
