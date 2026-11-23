import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFeed, decodeEntities, htmlToBlocks, blockText, locate } from '../src/domains/ingest/feed.mjs'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<item>
  <title><![CDATA[英伟达发布新芯片]]></title>
  <link>https://example.com/a?x=1&amp;y=2</link>
  <description><![CDATA[<p>第一段正文，长度足够用于测试的段落内容。</p>]]></description>
  <content:encoded><![CDATA[<p>正文第一段，长度足够用于测试的段落内容。</p><p>正文第二段，同样足够长以便被保留下来。</p>]]></content:encoded>
  <pubDate>Sat, 22 Nov 2026 08:00:00 GMT</pubDate>
  <dc:creator>张三</dc:creator>
  <category>科技</category>
</item></channel></rss>`

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Atom 条目</title><link href="https://example.com/atom"/><updated>2026-11-22T08:00:00Z</updated>
<summary>摘要内容</summary></entry></feed>`

test('parseFeed 解析 RSS：标题/链接/正文/时间/作者/分类', () => {
  const [item] = parseFeed(RSS)
  assert.equal(item.title, '英伟达发布新芯片')
  assert.equal(item.link, 'https://example.com/a?x=1&y=2')
  assert.match(item.content, /正文第二段/)
  assert.equal(item.author, '张三')
  assert.deepEqual(item.categories, ['科技'])
  assert.match(item.pubDate, /2026/)
})

test('parseFeed 解析 Atom：link href 与 updated', () => {
  const [item] = parseFeed(ATOM)
  assert.equal(item.title, 'Atom 条目')
  assert.equal(item.link, 'https://example.com/atom')
  assert.equal(item.description, '摘要内容')
})

test('parseFeed 对空输入返回空数组', () => {
  assert.deepEqual(parseFeed(''), [])
})

test('decodeEntities 处理命名与数字实体', () => {
  assert.equal(decodeEntities('a&amp;b &lt;c&gt; &#39;d&#39; &#x4e2d;'), "a&b <c> 'd' 中")
})

test('htmlToBlocks 去标签、按段落切块、丢弃过短块', () => {
  const blocks = htmlToBlocks('<p>短</p><p>这一段足够长，用来验证段落切分是否正常工作，因此会被保留下来。</p><div>第二段也足够长，用来验证 div 也会被切成块，并且同样保留。</div>')
  assert.equal(blocks.length, 2)
  assert.match(blocks[0], /验证段落切分/)
  assert.equal(blockText(blocks), blocks.join('\n'))
})

test('locate 精确命中与空白容错命中', () => {
  const text = '第一段内容。第二段  内容，带有多余空格，用于验证容错定位。'
  assert.deepEqual(locate(text, '第一段内容'), [0, 5])
  const hit = locate(text, '第二段  内容，带有多余空格')
  assert.ok(hit && hit[0] > 0)
})

test('locate 找不到时返回 null', () => {
  assert.equal(locate('abc', '不存在的片段内容'), null)
  assert.equal(locate('', 'x'), null)
})
