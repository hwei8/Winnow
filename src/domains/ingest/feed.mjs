// 极简 RSS/Atom 解析（零依赖）：返回 {title, link, description, content, pubDate, author, categories}
export function parseFeed (xml) {
  const items = []
  const blocks = [...String(xml).matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(m => m[0])
  const entries = [...String(xml).matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map(m => m[0])
  for (const raw of [...blocks, ...entries]) {
    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
      const m = raw.match(re)
      if (!m) return ''
      return clean(m[1])
    }
    const linkTag = raw.match(/<link[^>]*href="([^"]+)"[^>]*>/i)
    const linkPlain = raw.match(/<link>([\s\S]*?)<\/link>/i)
    const out = {
      title: get('title'),
      link: (linkPlain ? clean(linkPlain[1]) : '') || (linkTag ? linkTag[1] : ''),
      description: get('description') || get('summary'),
      content: get('content:encoded') || get('content'),
      pubDate: get('pubDate') || get('published') || get('updated') || '',
      author: get('dc:creator') || get('author') || '',
      categories: [...raw.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map(m => clean(m[1])).filter(Boolean)
    }
    if (out.title || out.link) items.push(out)
  }
  return items
}

function clean (s) {
  if (!s) return ''
  let t = String(s)
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  t = decodeEntities(t)
  return t.trim()
}

export function decodeEntities (s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

// HTML → 纯文本块（段落）
export function htmlToBlocks (html) {
  if (!html) return []
  let s = String(html)
  s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote|section)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
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
