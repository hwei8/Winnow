// ingest/store.mjs — 条目入库（fetch → 正文抽取 → item/item_block 落库），供 adapter 与 pipeline 共用
import { createHash } from 'node:crypto'
import { extractMainText } from './extract.mjs'
import { blockText } from './feed.mjs'
import { safeFetchText } from '../../shared/net.mjs'

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
export const urlHash = (url) => createHash('sha1').update(String(url)).digest('hex').slice(0, 12)
export const itemIdFor = (sourceId, url) => `${sourceId}:${urlHash(url)}`

export function cleanBlocks (blocks) {
  return blocks.map(b => String(b || '').replace(/\s+/g, ' ').trim())
    .filter(b => b.length >= 80)
    .filter(b => !/^(cookie|privacy|subscribe|sign in|log in|advertisement)/i.test(b))
}

/** 抓取不可信 URL 的 HTML：只允许公网地址、逐跳校验重定向、响应体上限 5MB。 */
export async function fetchHtml (url, { timeout = 25000 } = {}) {
  const r = await safeFetchText(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, timeout })
  return r.text
}

export function titleOfHtml (html) {
  const m = String(html).match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)
  return m ? m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '(无标题)'
}

export function saveItem (db, { itemId, sourceId, url, title, blocks, text, publishedAt = null, publishedTs = null, contentSource = 'fetched-full', author = null }) {
  const c = text || blockText(blocks)
  upsertItem(db).run(itemId, sourceId, url, String(title || '').slice(0, 220), author, publishedAt, publishedTs,
    'article', c.slice(0, 300), null, blocks.length, c.length, contentSource, /[\u4e00-\u9fa5]/.test(c) ? 'zh' : 'en')
  db.prepare('DELETE FROM item_block WHERE item_id=?').run(itemId)
  const ins = db.prepare('INSERT OR REPLACE INTO item_block(item_id,idx,text,char_start,char_end,kind) VALUES (?,?,?,?,?,?)')
  let off = 0
  blocks.forEach((b, i) => { ins.run(itemId, i, b, off, off + b.length, 'paragraph'); off += b.length + 1 })
  return { itemId, title, text: c, blocks }
}

// item 的 upsert：只更新本函数负责的列，不像 INSERT OR REPLACE 那样把其余列（durability 等）清空。
const ITEM_COLS = ['source_id', 'url', 'title', 'author', 'published_at', 'published_ts', 'media_kind', 'description', 'dir', 'segment_count', 'char_count', 'content_source', 'lang']
export function upsertItem (db) {
  return db.prepare(`INSERT INTO item(id,${ITEM_COLS.join(',')}) VALUES (?${',?'.repeat(ITEM_COLS.length)})
    ON CONFLICT(id) DO UPDATE SET ${ITEM_COLS.map(c => `${c}=excluded.${c}`).join(', ')}`)
}

// 抓取 URL 并入库；若已存在则复用
export async function ingestUrl (db, url, { sourceId = 'src:pipeline', titleHint = null } = {}) {
  const itemId = itemIdFor(sourceId, url)
  const existing = db.prepare('SELECT id,title FROM item WHERE id=?').get(itemId)
  if (existing) {
    const blocks = db.prepare('SELECT text FROM item_block WHERE item_id=? ORDER BY idx').all(itemId).map(r => r.text)
    const text = blockText(blocks)
    if (blocks.length && text.length > 200) return { itemId, title: existing.title, text, blocks, reused: true }
  }
  const html = await fetchHtml(url)
  const blocks = cleanBlocks(extractMainText(html))
  const text = blockText(blocks)
  if (text.length < 400) throw new Error('too-short: ' + text.length)
  return saveItem(db, { itemId, sourceId, url, title: titleHint || titleOfHtml(html), blocks, text })
}

// 从已有 item 读取（adapter 已入库时使用）
export function loadItem (db, itemId) {
  const row = db.prepare('SELECT id,title,url FROM item WHERE id=?').get(itemId)
  if (!row) return null
  const blocks = db.prepare('SELECT text FROM item_block WHERE item_id=? ORDER BY idx').all(itemId).map(r => r.text)
  return { itemId, title: row.title, url: row.url, blocks, text: blockText(blocks) }
}
