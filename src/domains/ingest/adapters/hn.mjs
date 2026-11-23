// adapters/hn.mjs — Hacker News adapter（契约：list / fetch / normalize / health）
import { fetchHtml, cleanBlocks, titleOfHtml } from '../store.mjs'
import { extractMainText } from '../extract.mjs'
import { blockText } from '../feed.mjs'

const ADAPTER = {
  id: 'hn',
  name: 'Hacker News',
  sourceId: 'src:hn',
  mediaKind: 'article',

  async list ({ limit = 10, mode = 'front' } = {}) {
    const base = mode === 'new'
      ? 'https://hn.algolia.com/api/v1/search_by_date?tags=story&query='
      : 'https://hn.algolia.com/api/v1/search?tags=front_page&query='
    const r = await fetch(`${base}&hitsPerPage=${Math.min(50, limit * 2)}`, { signal: AbortSignal.timeout(20000) })
    const d = await r.json()
    return (d.hits || [])
      .filter(h => h.url && !/twitter\.com|x\.com|youtube\.com/.test(h.url))
      .slice(0, limit)
      .map(h => ({ url: h.url, title: h.title || '', externalId: String(h.objectID || ''), publishedAt: h.created_at || null }))
  },

  async fetch (ref) { return await fetchHtml(ref.url) },

  normalize (ref, html) {
    const blocks = cleanBlocks(extractMainText(html))
    const text = blockText(blocks)
    if (text.length < 400) throw new Error('too-short: ' + text.length)
    return { title: ref.title || titleOfHtml(html), blocks, text }
  },

  async health () {
    const t0 = Date.now()
    try {
      const r = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=1', { signal: AbortSignal.timeout(10000) })
      const d = await r.json()
      return { ok: r.ok && Array.isArray(d.hits), latencyMs: Date.now() - t0, detail: `hits=${d.hits?.length ?? 0}` }
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, detail: String(e.message).slice(0, 80) } }
  }
}
export default ADAPTER
