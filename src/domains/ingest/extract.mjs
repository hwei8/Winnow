// ingest/extract.mjs — 正文抽取（去导航/侧边栏/相关推荐），替代粗暴的 htmlToBlocks
// 策略：剔除噪声标签与噪声 class/id → 选 <article> 或"段落文本最多"的容器 → 取块

const NOISE_TAGS = 'script|style|noscript|nav|header|footer|aside|form|button|iframe|svg|figure|video|audio|canvas|select|input|textarea'
const NOISE_KW = /(?:^|[-_\s])(nav|menu|sidebar|side-bar|related|recommend|recirc|most-?read|popular|trending|share|social|comment|disqus|cookie|consent|subscribe|newsletter|signup|advert|ad-|ads|promo|sponsor|partner|footer|header|breadcrumb|tag-?list|tags|author-?bio|read-?more|more-?stories|outbrain|taboola|paywall|banner|popup|modal)(?:$|[-_\s])/i

function decodeEntities (s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripNoise (html) {
  let s = String(html)
  // 1) 噪声标签整体删除
  s = s.replace(new RegExp(`<(${NOISE_TAGS})[\\s\\S]*?<\\/\\1>`, 'gi'), ' ')
  // 2) 带噪声 class/id 的元素整体删除（允许嵌套一层，最多循环 3 次）
  for (let pass = 0; pass < 3; pass++) {
    const before = s
    s = s.replace(/<(\w+)([^>]*(?:class|id)\s*=\s*["'][^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi, (m, tag, attrs, inner) => {
      const attrStr = attrs.replace(/[^=]*=\s*["']([^"']*)["']/g, '$1 ')
      return NOISE_KW.test(attrStr) ? ' ' : m
    })
    if (s === before) break
  }
  return s
}

function textOf (fragment) {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' ').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim())
}

// 选正文容器：优先 article；否则选"直接子 p 文本总量"最大的容器
function pickContainer (html) {
  const article = html.match(/<article[\s>][\s\S]*?<\/article>/i)
  if (article && textOf(article[0]).length > 600) return article[0]
  const candidates = []
  const re = /<(div|section|main|td)([^>]*)>([\s\S]*?)<\/\1>/gi
  let m
  while ((m = re.exec(html))) {
    const inner = m[3]
    const pTexts = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(x => textOf(x[1]))
    const total = pTexts.reduce((a, t) => a + t.length, 0)
    if (pTexts.length >= 3 && total > 500) candidates.push({ html: m[0], total, count: pTexts.length })
  }
  if (!candidates.length) return html
  candidates.sort((a, b) => b.total - a.total)
  return candidates[0].html
}

const NAV_KW = /(Menu|Subscribe|Sign in|Sign up|Log in|Watchlist|Cookies|Privacy Policy|Newsletter|All rights reserved|Follow us|Share this|Advertisement|Live ?Stream|Download the app|Get the app|Terms of (use|service))/i

function blockOk (t) {
  if (t.length < 80 || t.length > 2500) return false
  if (NAV_KW.test(t)) return false
  if ((t.match(/\|/g) || []).length >= 2) return false
  const punct = (t.match(/[。.!?！？；;:：]/g) || []).length
  if (punct === 0 && t.length < 220) return false
  // 链接式块：大量短词无标点分隔
  const words = t.split(/\s+/)
  if (words.length > 30 && punct === 0) return false
  return true
}

export function extractMainText (html) {
  const cleaned = stripNoise(html)
  const container = pickContainer(cleaned)

  const blocksFrom = (frag) => {
    const out = []
    const re = /<(p|h1|h2|h3|blockquote)([^>]*)>([\s\S]*?)<\/\1>/gi
    let m
    while ((m = re.exec(frag))) { const t = textOf(m[3]); if (blockOk(t)) out.push(t) }
    return out
  }

  const containerBlocks = blocksFrom(container)
  const allBlocks = blocksFrom(cleaned)
  // 容器抽取过短时退回全文（容器可能选错），全文更短则用容器
  const cLen = containerBlocks.join('').length
  const aLen = allBlocks.join('').length
  let blocks = cLen >= 1500 || aLen < cLen * 1.5 ? containerBlocks : allBlocks
  if (!blocks.length) blocks = allBlocks.length ? allBlocks : containerBlocks

  const seen = new Set()
  return blocks.filter(b => { const k = b.slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true })
}

export function extractTitle (html) {
  const m = String(html).match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}
