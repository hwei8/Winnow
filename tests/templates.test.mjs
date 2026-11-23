import test from 'node:test'
import assert from 'node:assert/strict'
import { safeUrl } from '../src/web/views/fmt.mjs'
import { highlight, storyMain, searchResultsHtml, storyCard } from '../src/web/views/templates.mjs'

test('safeUrl only lets http(s) and same-site paths through', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(safeUrl('/story/x'), '/story/x')
  assert.equal(safeUrl('#claim-1'), '#claim-1')
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example/x', '/\\evil.example', '', null, undefined, 'not a url']) {
    assert.equal(safeUrl(bad), '#', String(bad))
  }
})

test('highlight escapes text and never corrupts entities', () => {
  assert.equal(highlight('AT&T <b>', 'amp'), 'AT&amp;T &lt;b&gt;')
  assert.equal(highlight('x < y', 'lt'), 'x &lt; y')
  assert.equal(highlight('mark the mark', 'mark'), '<mark>mark</mark> the <mark>mark</mark>')
  assert.equal(highlight('<img src=x onerror=1>', 'img'), '&lt;<mark>img</mark> src=x onerror=1&gt;')
  assert.equal(highlight('abc', ''), 'abc')
})

test('rendered pages neutralise javascript: links from scraped data', () => {
  const evil = 'javascript:alert(document.cookie)'
  const story = storyMain({
    has_body: true,
    body: '## 摘要\n\n正文。',
    story: { id: 'story:x', title: 't', body: '' },
    sections: [], fact_spans: [], facts: [],
    items: [{ url: evil, title: 'src', source: 's' }],
    claims: [{ id: 'c1', text: 'claim', item_url: evil, confidence_pct: 50 }]
  })
  assert.ok(!story.includes('javascript:'), 'story page leaked a javascript: url')
  const search = searchResultsHtml({ q: 'ab', results: [], items: [{ url: evil, title: 'ab' }] })
  assert.ok(!search.includes('javascript:'), 'search panel leaked a javascript: url')
  const card = storyCard({ id: 'x', url: evil, title: 't', claims: [{ id: 'c', text: 'x' }] })
  assert.ok(!card.includes('javascript:'), 'stream card leaked a javascript: url')
})

test('templates contain no inline event handlers (blocked by the CSP)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/web/views/templates.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /\son(click|error|load|submit|input|change|mouseover)=/i)
})
