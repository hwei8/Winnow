import test from 'node:test'
import assert from 'node:assert/strict'
import { extractMainText } from '../src/domains/ingest/extract.mjs'
import { htmlToBlocks, parseFeed, decodeEntities } from '../src/domains/ingest/feed.mjs'
import { stripTags, elements, tagPrefix } from '../src/domains/ingest/html.mjs'

// 不可信网页的最坏输入：旧正则在这些输入上是 O(n²)（250KB `<div ` 实测 12.5 秒）
const HOSTILE = {
  manyOpenTags: '<div '.repeat(50000),
  nestedP: '<p>'.repeat(50000) + 'x',
  unclosedScript: '<script>' + 'a'.repeat(200000),
  manyLt: '<'.repeat(200000),
  unclosedItem: '<item><title>' + 'x '.repeat(100000),
  classedNoClose: '<div class="nav">'.repeat(30000)
}

test('parsers stay linear on hostile input', () => {
  for (const [name, input] of Object.entries(HOSTILE)) {
    for (const [fnName, fn] of [['extractMainText', extractMainText], ['htmlToBlocks', htmlToBlocks], ['parseFeed', parseFeed]]) {
      const t0 = performance.now()
      fn(input)
      const ms = performance.now() - t0
      assert.ok(ms < 1500, `${fnName}(${name}) took ${ms.toFixed(0)}ms`)
    }
  }
})

test('stripTags is equivalent to /<[^>]+>/g', () => {
  const alphabet = ['<', '>', 'a', ' ', '<b>', '</p>', '<>', '"', '\n']
  let seed = 42
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let i = 0; i < 2000; i++) {
    const s = Array.from({ length: Math.floor(rnd() * 30) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')
    assert.equal(stripTags(s), s.replace(/<[^>]+>/g, ' '), JSON.stringify(s))
  }
})

test('element scanning keeps the legacy prefix semantics (output unchanged by the rewrite)', () => {
  // 旧正则 `<(p|h1|…)` 没有词边界：<pre> 被当成 p，读到下一个 </p>。改写刻意保留这一行为。
  const html = '<pre>code</pre> tail</p><p>real</p>'
  assert.deepEqual([...elements(html, tagPrefix('p'))].map(e => e.inner), ['code</pre> tail', 'real'])
})

test('extractMainText still finds article paragraphs and drops noise', () => {
  const para = (t) => `<p>${t} ${'这是一段足够长的正文内容，用来通过块长度的过滤条件。'.repeat(3)}</p>`
  const html = `<html><head><title>T</title><script>var x = "<p>not text</p>"</script></head><body>
    <nav class="menu">${para('导航')}</nav>
    <div class="sidebar-related">${para('相关推荐')}</div>
    <article>${para('第一段')}${para('第二段')}${para('第三段')}</article>
    <footer>${para('页脚')}</footer></body></html>`
  const blocks = extractMainText(html)
  assert.equal(blocks.length, 3)
  assert.ok(blocks[0].startsWith('第一段'))
  assert.ok(!blocks.some(b => /导航|相关推荐|页脚|not text/.test(b)))
})

test('entities outside the BMP decode correctly and invalid code points do not throw', () => {
  assert.equal(decodeEntities('&#128512; &#x1F600;'), '😀 😀')
  assert.equal(decodeEntities('&#99999999;'), '�')
  const [block] = extractMainText(`<article><p>${'表情 &#128512; 测试。'.repeat(20)}</p></article>`)
  assert.ok(block.includes('😀'))
})

test('parseFeed: atom self-closing links and CDATA', () => {
  const xml = `<feed><entry><title><![CDATA[A & B]]></title><link href="https://e.test/a"/><updated>2026-01-01</updated></entry>
    <entry><title>x</title><link rel="alternate" href="https://e.test/b"/></entry></feed>`
  const items = parseFeed(xml)
  assert.deepEqual(items.map(i => [i.title, i.link]), [['A & B', 'https://e.test/a'], ['x', 'https://e.test/b']])
})
