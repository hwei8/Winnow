// ingest/page.mjs — 统一取正文：直连 HTML 抽取；失败/过短时用 DeepSeek Fetch API 兜底
import { fetchHtml, cleanBlocks, titleOfHtml } from './store.mjs'
import { extractMainText } from './extract.mjs'
import { blockText } from './feed.mjs'
import { fetchViaDeepSeek } from '../../providers/search.mjs'
import { assertPublicUrl } from '../../shared/net.mjs'

const MIN_CHARS = Number(process.env.FETCH_MIN_CHARS || 500)

export function markdownToBlocks (md) {
  return String(md || '')
    .split(/\n{2,}/)
    .map(s => s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[>\-*+]\s+/gm, '')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(b => b.length >= 40)
    .filter(b => !/^(cookie|privacy|subscribe|sign in|log in|advertisement|分享到|责任编辑)/i.test(b))
}

export async function fetchPage (url, { minChars = MIN_CHARS, allowFallback = process.env.FETCH_FALLBACK !== '0' } = {}) {
  let html = null
  try {
    html = await fetchHtml(url)
    const blocks = cleanBlocks(extractMainText(html))
    const text = blockText(blocks)
    if (text.length >= minChars) return { blocks, text, title: titleOfHtml(html), via: 'http' }
  } catch (e) { /* fallthrough */ }
  if (!allowFallback) throw new Error('too-short')
  // 兜底会把 URL 发给第三方：内网地址绝不外发
  await assertPublicUrl(url)
  const md = await fetchViaDeepSeek(url)
  const blocks = markdownToBlocks(md)
  const text = blockText(blocks)
  if (text.length < 200) throw new Error('too-short-after-fallback: ' + text.length)
  return { blocks, text, title: html ? titleOfHtml(html) : '', via: 'deepseek' }
}
