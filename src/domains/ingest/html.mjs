// ingest/html.mjs — 线性时间的 HTML 元素扫描（替代 `<(tag)…>[\s\S]*?</\1>` 式正则）
//
// 为什么：旧写法对"未闭合的开标签"会从每个起点一路扫到文末，退化成 O(n²)。
// 实测 250KB 的 `<div ` 让正文抽取卡 12.5 秒；抓来的网页完全不可信，这是现成的拒绝服务。
//
// 做法：开标签用 `[^<>]*` 匹配（遇到下一个 `<` 就停，不会跨标签回溯），闭合标签用 indexOf 找
// 第一个对应的 `</tag>`（与旧的懒惰匹配语义一致）。某个闭合标签一旦找不到，就记下来，
// 之后同名开标签直接跳过——每个字符最多被扫常数次，整体 O(n)。
//
// 兼容性：调用方的匹配器刻意复刻旧正则的行为（包括它的怪癖），让改写前后的抽取结果逐字节一致。
// 例如旧的 `<(p|h1|…)` 没有词边界，<pre>/<picture> 也被当作 p、读到下一个 </p> 为止——
// 这会把代码块算进正文。是否修正它属于抽取策略的改动，不在这次性能修复的范围内。
//
// 匹配器 matcher(rawName, attrs)：rawName 为小写的开标签名，返回要找的闭合标签名；返回 null 表示不是目标。

const OPEN_TAG = /<([a-zA-Z][\w:-]*)([^<>]*)>/g

/** replaceElements 回调返回 KEEP：保留该元素并跳过其内部（旧正则的不重叠语义）。 */
export const KEEP = Symbol('keep')

function findClose (lower, closeName, from, noClose) {
  if (noClose.has(closeName)) return null
  const tok = `</${closeName}>`
  const i = lower.indexOf(tok, from)
  if (i < 0) { noClose.add(closeName); return null }
  return { innerEnd: i, end: i + tok.length }
}

/** 依次产出匹配的元素（不重叠：匹配后从元素结尾继续，与旧正则相同）。 */
export function * elements (html, matcher) {
  const s = String(html ?? '')
  const lower = s.toLowerCase()
  const noClose = new Set()
  const re = new RegExp(OPEN_TAG.source, 'g')
  let m
  while ((m = re.exec(s))) {
    const tag = matcher(m[1].toLowerCase(), m[2])
    if (!tag) continue
    const close = findClose(lower, tag, re.lastIndex, noClose)
    if (!close) continue
    yield { tag, attrs: m[2], start: m.index, end: close.end, outer: s.slice(m.index, close.end), inner: s.slice(re.lastIndex, close.innerEnd) }
    re.lastIndex = close.end
  }
}

/**
 * 替换匹配的元素。回调 fn({ tag, attrs, inner }) 返回：
 *   string → 替换整个元素；KEEP → 保留并跳过其内部；null → 保留，继续扫描其内部。
 */
export function replaceElements (html, matcher, fn) {
  const s = String(html ?? '')
  const lower = s.toLowerCase()
  const noClose = new Set()
  const re = new RegExp(OPEN_TAG.source, 'g')
  let out = ''
  let pos = 0
  let m
  while ((m = re.exec(s))) {
    const tag = matcher(m[1].toLowerCase(), m[2])
    if (!tag) continue
    const close = findClose(lower, tag, re.lastIndex, noClose)
    if (!close) continue
    const rep = fn({ tag, attrs: m[2], inner: s.slice(re.lastIndex, close.innerEnd) })
    if (rep === null || rep === undefined) continue
    if (rep === KEEP) { re.lastIndex = close.end; continue }
    out += s.slice(pos, m.index) + rep
    pos = close.end
    re.lastIndex = close.end
  }
  return out + s.slice(pos)
}

/**
 * 等价于 `s.replace(/<[^>]+>/g, replacement)`，但保证线性：
 * 旧正则遇到没有 `>` 的 `<` 时会从每个 `<` 扫到文末。
 */
export function stripTags (html, replacement = ' ') {
  const s = String(html ?? '')
  let out = ''
  let pos = 0
  let i = 0
  for (;;) {
    const lt = s.indexOf('<', i)
    if (lt < 0) break
    const gt = s.indexOf('>', lt + 1)
    if (gt < 0) break // 后面再没有 '>'：任何 '<' 都不可能再匹配
    if (gt === lt + 1) { i = lt + 1; continue } // "<>" 不算标签（[^>]+ 至少一个字符）
    out += s.slice(pos, lt) + replacement
    pos = gt + 1
    i = gt + 1
  }
  return out + s.slice(pos)
}

/** 精确匹配标签名（对应旧正则里的 `<tag[\s>]`）。 */
export const tagSet = (...names) => {
  const set = new Set(names.map(n => n.toLowerCase()))
  return (raw) => (set.has(raw) ? raw : null)
}

/** 前缀匹配，按给出的顺序取第一个（对应旧正则里没有词边界的 `<(a|b|c)`）。 */
export const tagPrefix = (...names) => {
  const list = names.map(n => n.toLowerCase())
  return (raw) => list.find(n => raw.startsWith(n)) ?? null
}

/** `<(\w+)`：纯单词字符的任意标签（自定义元素 my-nav 之类不匹配，与旧正则一致）。 */
export const wordTag = (raw) => (/^\w+$/.test(raw) ? raw : null)
