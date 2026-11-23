// 极简 RSS/Atom 解析（零依赖）：返回 {title, link, description, content, pubDate, author, categories}
import { elements, replaceElements, stripTags, tagSet, tagPrefix } from './html.mjs'

const MAX_FEED = 8 * 1024 * 1024
const SCRIPTY = tagPrefix('script', 'style', 'noscript')
const BARE_LINK = (raw, attrs) => (raw === 'link' && attrs === '' ? 'link' : null)

export function parseFeed (xml) {
  const items = []
  const src = String(xml ?? '').slice(0, MAX_FEED)
  // 线性扫描（见 html.mjs）：未闭合的 <item 不会让解析退化成 O(n²)
  const blocks = [...elements(src, tagSet('item'))].map(e => e.outer)
  const entries = [...elements(src, tagSet('entry'))].map(e => e.outer)
  for (const raw of [...blocks, ...entries]) {
    const get = (tag) => {
      const el = elements(raw, tagPrefix(tag)).next().value
      return el ? clean(el.inner) : ''
    }
    const linkTag = raw.match(/<link[^>]*href="([^"]+)"[^>]*>/i)
    const linkPlain = elements(raw, BARE_LINK).next().value
    const out = {
      title: get('title'),
      link: (linkPlain ? clean(linkPlain.inner) : '') || (linkTag ? linkTag[1] : ''),
      description: get('description') || get('summary'),
      content: get('content:encoded') || get('content'),
      pubDate: get('pubDate') || get('published') || get('updated') || '',
      author: get('dc:creator') || get('author') || '',
      categories: [...elements(raw, tagPrefix('category'))].map(e => clean(e.inner)).filter(Boolean)
    }
    if (out.title || out.link) items.push(out)
  }
  return items
}

// 线性展开 CDATA（未闭合的 CDATA 原样保留）
function unwrapCdata (t) {
  let out = ''
  let pos = 0
  for (;;) {
    const a = t.indexOf('<![CDATA[', pos)
    if (a < 0) break
    const b = t.indexOf(']]>', a + 9)
    if (b < 0) break
    out += t.slice(pos, a) + t.slice(a + 9, b)
    pos = b + 3
  }
  return out + t.slice(pos)
}

function clean (s) {
  if (!s) return ''
  let t = String(s)
  t = unwrapCdata(t)
  t = decodeEntities(t)
  return t.trim()
}

// 非法码点（如 &#99999999;）会让 fromCodePoint 抛 RangeError，整篇解析失败
const safeCodePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd')

export function decodeEntities (s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

// HTML → 纯文本块（段落）
export function htmlToBlocks (html) {
  if (!html) return []
  let s = String(html)
  s = replaceElements(s, SCRIPTY, () => ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote|section)>/gi, '\n')
  s = stripTags(s)
  s = decodeEntities(s)
  return s.split(/\n+/).map(x => x.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(x => x.length > 30)
}

export function blockText (blocks) {
  return blocks.join('\n')
}

// 在全文里定位片段，返回 [start,end)；找不到返回 null
export function locate (text, quote) {
  if (!text || !quote) return null
  const q = String(quote).trim()
  if (!q) return null
  let i = text.indexOf(q)
  if (i >= 0) return [i, i + q.length]
  // 容忍空白差异：按去空白后的序列做一次近似定位
  const squash = (s) => s.replace(/\s+/g, '')
  const target = squash(q)
  if (target.length < 8) return null
  const flat = []
  const map = []
  for (let k = 0; k < text.length; k++) { const ch = text[k]; if (!/\s/.test(ch)) { flat.push(ch); map.push(k) } }
  const hay = flat.join('')
  const idx = hay.indexOf(target)
  if (idx < 0) return null
  const start = map[idx]
  const end = map[idx + target.length - 1] + 1
  return [start, end]
}
