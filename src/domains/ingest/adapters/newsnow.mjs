// adapters/newsnow.mjs — 中文热榜 adapter（newsnow 公共 API，标题/排名/链接）
// 契约：list / fetch / normalize / health
import { cleanBlocks, titleOfHtml } from '../store.mjs'
import { extractMainText } from '../extract.mjs'
import { blockText } from '../feed.mjs'
import { fetchPage } from '../page.mjs'

const API = process.env.NEWSNOW_API || 'https://newsnow.busiyi.world/api/s'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

export const PLATFORMS = [
  { id: 'weibo', name: '微博热搜', domain: 'weibo.com' },
  { id: 'zhihu', name: '知乎热榜', domain: 'zhihu.com' },
  { id: 'douyin', name: '抖音热榜', domain: 'douyin.com' },
  { id: 'baidu', name: '百度热搜', domain: 'baidu.com' },
  { id: 'toutiao', name: '今日头条', domain: 'toutiao.com' },
  { id: 'bilibili-hot-search', name: 'B站热搜', domain: 'bilibili.com' },
  { id: 'cls-hot', name: '财联社热门', domain: 'cls.cn' },
  { id: 'wallstreetcn-hot', name: '华尔街见闻', domain: 'wallstreetcn.com' },
  { id: 'thepaper', name: '澎湃新闻', domain: 'thepaper.cn' },
  { id: 'ifeng', name: '凤凰网', domain: 'ifeng.com' },
  { id: 'tieba', name: '百度贴吧', domain: 'tieba.baidu.com' }
]

function domainOk (url, domain) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    return u.hostname === domain || u.hostname.endsWith('.' + domain)
  } catch { return false }
}

export async function fetchHot (platform, { timeout = 20000 } = {}) {
  const r = await fetch(`${API}?id=${encodeURIComponent(platform)}&latest`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeout)
  })
  if (!r.ok) throw new Error(`newsnow ${platform}: HTTP ${r.status}`)
  const d = await r.json()
  if (!d || !Array.isArray(d.items)) throw new Error(`newsnow ${platform}: bad payload`)
  return d
}

const ADAPTER = {
  id: 'newsnow',
  name: '中文热榜',
  sourceId: 'src:newsnow',
  mediaKind: 'article',
  platforms: PLATFORMS,

  async list ({ limit = 10, source = null } = {}) {
    const targets = source ? PLATFORMS.filter(p => p.id === source || 'src:' + p.id === source) : PLATFORMS
    if (!targets.length) throw new Error('unknown platform: ' + source)
    const out = []
    for (const p of targets) {
      if (out.length >= limit) break
      let d
      try { d = await fetchHot(p.id) } catch (e) { console.error('[newsnow]', p.id, String(e.message).slice(0, 80)); continue }
      d.items.slice(0, Math.max(5, limit)).forEach((it, i) => {
        if (out.length >= limit) return
        const url = it.url || it.mobileUrl
        if (!url || !it.title) return
        if (!domainOk(url, p.domain)) return
        out.push({
          url, title: it.title.trim(), rank: i + 1, platform: p.id, platformName: p.name,
          externalId: String(it.id || ''), mobileUrl: it.mobileUrl || null,
          sourceId: 'src:' + p.id, publishedAt: null
        })
      })
    }
    return out
  },

  async fetch (ref) { return await fetchPage(ref.url) },

  normalize (ref, html) {
    const blocks = cleanBlocks(extractMainText(html))
    const text = blockText(blocks)
    if (text.length < 400) throw new Error('too-short: ' + text.length)
    return { title: ref.title || titleOfHtml(html), blocks, text }
  },

  async health () {
    const t0 = Date.now()
    try {
      const d = await fetchHot('weibo')
      return { ok: Array.isArray(d.items) && d.items.length > 0, latencyMs: Date.now() - t0, detail: `weibo items=${d.items?.length ?? 0}` }
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, detail: String(e.message).slice(0, 80) } }
  }
}

export default ADAPTER
