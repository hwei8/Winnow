// ingest/registry.mjs — adapter 注册与采集编排
import hn from './adapters/hn.mjs'
import rss from './adapters/rss.mjs'
import newsnow from './adapters/newsnow.mjs'
import { saveItem, itemIdFor, cleanBlocks } from './store.mjs'

const REGISTRY = new Map([['hn', hn], ['rss', rss], ['newsnow', newsnow]])
export function getAdapter (name) {
  const a = REGISTRY.get(name)
  if (!a) throw new Error(`unknown adapter: ${name} (available: ${[...REGISTRY.keys()].join(', ')})`)
  return a
}
export function listAdapters () { return [...REGISTRY.values()].map(a => ({ id: a.id, name: a.name })) }

// 采集一轮：list → fetch → normalize → 入库；返回 item ids
export async function collect (db, { adapter, limit = 10, source = null, cursor = null } = {}) {
  const a = getAdapter(adapter)
  const t0 = Date.now()
  const refs = await a.list({ limit, source, cursor })
  const saved = []
  const errors = []
  for (const ref of refs) {
    try {
      const page = await a.fetch(ref)
      const doc = page && Array.isArray(page.blocks) && page.text !== undefined ? page : a.normalize(ref, page)
      const sourceId = ref.sourceId || a.sourceId
      // 新源首采：自动登记 source 行（否则 item.source_id 外键失败）
      try {
        db.prepare('INSERT OR IGNORE INTO source(id,adapter_id,name,external_id,tier,lang) VALUES (?,?,?,?,?,?)')
          .run(sourceId, adapter, ref.sourceName || ref.sourceId || a.name, ref.sourceId || a.id, ref.sourceTier ?? 2, ref.lang || null)
      } catch {}
      const itemId = itemIdFor(sourceId, ref.url)
      const published = ref.publishedAt ? new Date(ref.publishedAt) : null
      saveItem(db, {
        itemId, sourceId, url: ref.url, title: doc.title, blocks: doc.blocks, text: doc.text,
        publishedAt: published && !isNaN(published) ? published.toISOString() : null,
        publishedTs: published && !isNaN(published) ? Math.floor(published.getTime() / 1000) : null,
        contentSource: doc.contentSource || 'fetched-full'
      })
      saved.push(itemId)
    } catch (e) { errors.push({ url: ref.url, error: String(e.message).slice(0, 80) }) }
  }
  const health = { ok: errors.length < refs.length, latencyMs: Date.now() - t0, listCount: refs.length, saved: saved.length, errors: errors.length }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS adapter_health (adapter TEXT, checked_at TEXT, ok INTEGER, latency_ms INTEGER, detail TEXT, PRIMARY KEY(adapter, checked_at))`)
    db.prepare('INSERT OR REPLACE INTO adapter_health(adapter,checked_at,ok,latency_ms,detail) VALUES (?,?,?,?,?)')
      .run(adapter, new Date().toISOString(), health.ok ? 1 : 0, health.latencyMs, JSON.stringify({ list: refs.length, saved: saved.length, errors: errors.slice(0, 5) }))
  } catch {}
  return { adapter, refs: refs.length, saved, errors, health }
}

export async function healthCheck (name) {
  const a = getAdapter(name)
  const t0 = Date.now()
  try { return { adapter: name, ...(await a.health()), ok: true } } catch (e) { return { adapter: name, ok: false, latencyMs: Date.now() - t0, detail: String(e.message).slice(0, 100) } }
}
