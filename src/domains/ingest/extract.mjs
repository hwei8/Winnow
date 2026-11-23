// ingest/extract.mjs — 正文抽取（去导航/侧边栏/相关推荐），替代粗暴的 htmlToBlocks
// 策略：剔除噪声标签与噪声 class/id → 选 <article> 或"段落文本最多"的容器 → 取块

import { elements, replaceElements, stripTags, tagSet, tagPrefix, wordTag, KEEP } from './html.mjs'
import { isLatexNoise } from './tex.mjs'

// 输入上限：再大的网页正文也不会超过这个量级，截断可以把最坏情况封顶
const MAX_HTML = 3 * 1024 * 1024
// 匹配器与旧正则一一对应（前缀匹配 = 旧正则没有词边界），保证抽取结果不变，见 html.mjs
const NOISE_TAGS = tagPrefix('script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'iframe', 'svg', 'figure', 'video', 'audio', 'canvas', 'select', 'input', 'textarea')
const CLASSED_TAG = (raw, attrs) => (/(?:class|id)\s*=\s*["'][^"']*["']/i.test(attrs) ? wordTag(raw) : null)
const CONTAINER_TAGS = tagPrefix('div', 'section', 'main', 'td')
const BLOCK_TAGS = tagPrefix('p', 'h1', 'h2', 'h3', 'blockquote')
const P_TAG = tagPrefix('p')
const ARTICLE_TAG = tagSet('article')
const NOISE_KW = /(?:^|[-_\s])(nav|menu|sidebar|side-bar|related|recommend|recirc|most-?read|popular|trending|share|social|comment|disqus|cookie|consent|subscribe|newsletter|signup|advert|ad-|ads|promo|sponsor|partner|footer|header|breadcrumb|tag-?list|tags|author-?bio|read-?more|more-?stories|outbrain|taboola|paywall|banner|popup|modal)(?:$|[-_\s])/i

// fromCodePoint 才能还原 BMP 之外的字符（emoji 等）；非法码点用替换符而不是抛错
const codePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd')

function decodeEntities (s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
}

function stripNoise (html) {
  // 1) 噪声标签整体删除
  let s = replaceElements(html, NOISE_TAGS, () => ' ')
  // 2) 带噪声 class/id 的元素整体删除（允许嵌套一层，最多循环 3 次；语义与旧正则保持一致）
  for (let pass = 0; pass < 3; pass++) {
    const before = s
    s = replaceElements(s, CLASSED_TAG, ({ attrs }) => {
      const attrStr = attrs.replace(/[^=]*=\s*["']([^"']*)["']/g, '$1 ')
      return NOISE_KW.test(attrStr) ? ' ' : KEEP
    })
    if (s === before) break
  }
  return s
}

function textOf (fragment) {
  return decodeEntities(stripTags(fragment).replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim())
}

// 选正文容器：优先 article；否则选"直接子 p 文本总量"最大的容器
function pickContainer (html) {
  const article = elements(html, ARTICLE_TAG).next().value
  if (article && textOf(article.outer).length > 600) return article.outer
  const candidates = []
  for (const el of elements(html, CONTAINER_TAGS)) {
    const pTexts = [...elements(el.inner, P_TAG)].map(x => textOf(x.inner))
    const total = pTexts.reduce((a, t) => a + t.length, 0)
    if (pTexts.length >= 3 && total > 500) candidates.push({ html: el.outer, total, count: pTexts.length })
  }
  if (!candidates.length) return html
  candidates.sort((a, b) => b.total - a.total)
  return candidates[0].html
}

const NAV_KW = /(Menu|Subscribe|Sign in|Sign up|Log in|Watchlist|Cookies|Privacy Policy|Newsletter|All rights reserved|Follow us|Share this|Advertisement|Live ?Stream|Download the app|Get the app|Terms of (use|service))/i

function blockOk (t) {
  if (t.length < 80 || t.length > 2500) return false
  if (isLatexNoise(t)) return false
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
  const cleaned = stripNoise(String(html ?? '').slice(0, MAX_HTML))
  const container = pickContainer(cleaned)

  const blocksFrom = (frag) => {
    const out = []
    for (const el of elements(frag, BLOCK_TAGS)) { const t = textOf(el.inner); if (blockOk(t)) out.push(t) }
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
