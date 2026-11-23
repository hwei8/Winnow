import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from '../src/shared/config.mjs'
import { FEEDS } from '../src/domains/ingest/adapters/rss.mjs'

test('config/feeds.json is well formed', () => {
  const raw = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'feeds.json'), 'utf8'))
  assert.ok(Array.isArray(raw.feeds) && raw.feeds.length >= 10)
  for (const feed of raw.feeds) {
    assert.match(feed.sourceId, /^src:/, 'sourceId must be src: prefixed')
    assert.ok(feed.name, 'name required')
    assert.ok([1, 2, 3].includes(feed.tier), `tier must be 1..3 (${feed.sourceId})`)
    assert.ok(['zh', 'en'].includes(feed.lang), `lang must be zh|en (${feed.sourceId})`)
    assert.equal(typeof feed.full, 'boolean')
    assert.ok(Array.isArray(feed.urls) && feed.urls.length)
    for (const url of feed.urls) assert.match(url, /^https:\/\//)
  }
})

test('feed ids are unique and the adapter loads them all', () => {
  const ids = FEEDS.map((f) => f.sourceId)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(FEEDS.length, 17)
})
