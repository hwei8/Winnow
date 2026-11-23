import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, escapeHtml, sendMessage, toPlainText } from '../src/providers/telegram.mjs'
import { isRetryable } from '../src/providers/llm.mjs'
import { localDate } from '../src/shared/config.mjs'

test('telegram chunkText never exceeds the limit, even for a single huge line', () => {
  const text = ['short', 'x'.repeat(9000), 'tail'].join('\n')
  const chunks = chunkText(text, 3500)
  assert.ok(chunks.every(c => c.length <= 3500), chunks.map(c => c.length).join(','))
  assert.equal(chunks.join('\n').replace(/\n/g, ''), text.replace(/\n/g, ''))
})

test('telegram sends plain text by default (titles with & < > must not break delivery)', async (t) => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { json: async () => ({ ok: true, result: { message_id: 1 } }) } }
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  process.env.TELEGRAM_CHAT_ID = '42'
  t.after(() => { globalThis.fetch = realFetch; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID })

  await sendMessage(toPlainText('# 简报\n1. [科技] AT&T <新> 芯片'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].parse_mode, undefined)
  assert.equal(calls[0].chat_id, '42')
  assert.match(calls[0].text, /AT&T <新>/)

  await sendMessage(`<b>${escapeHtml('a<b & c')}</b>`, { parseMode: 'HTML' })
  assert.equal(calls[1].parse_mode, 'HTML')
  assert.equal(calls[1].text, '<b>a&lt;b &amp; c</b>')
})

test('llm retries only transient failures', () => {
  for (const msg of ['HTTP 429: slow down', 'HTTP 503: x', 'HTTP 502', 'fetch failed', 'model overloaded']) assert.equal(isRetryable(new Error(msg)), true, msg)
  const abort = new Error('aborted'); abort.name = 'AbortError'
  assert.equal(isRetryable(abort), true)
  for (const msg of ['HTTP 400: bad request', 'HTTP 401: unauthorized', 'HTTP 404', 'OPENCODE_GO_API_KEY not set']) assert.equal(isRetryable(new Error(msg)), false, msg)
})

test('localDate uses the configured timezone, not UTC', () => {
  const d = new Date('2026-11-22T23:30:00Z') // 东八区已是 23 日
  assert.equal(localDate(d, 'Asia/Shanghai'), '2026-11-23')
  assert.equal(localDate(d, 'UTC'), '2026-11-22')
})
