import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, extractionInfo } from '../src/domains/ingest/claims.mjs'

test('chunkText 按段落切块，尾块并入前一块', () => {
  const para = 'x'.repeat(1200)
  const text = Array.from({ length: 7 }, () => para).join('\n\n')
  const chunks = chunkText(text, 3500)
  assert.ok(chunks.length >= 2, 'should split')
  assert.ok(chunks.every(c => c.length <= 3500), 'no chunk exceeds size')
  assert.equal(chunks.join('\n\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''))
})

test('chunkText 单段超长时硬切', () => {
  const chunks = chunkText('y'.repeat(9000), 3500)
  assert.equal(chunks.length, 3)
  assert.equal(chunks.join('').length, 9000)
  assert.ok(chunks.every(c => c.length <= 3500))
})

test('尾块过短时并入上一块', () => {
  const text = 'a'.repeat(3400) + '\n\n' + 'b'.repeat(100)
  const chunks = chunkText(text, 3500)
  assert.equal(chunks.length, 1)
})

test('extractionInfo 暴露可配参数', () => {
  const info = extractionInfo()
  assert.equal(typeof info.chunkChars, 'number')
  assert.equal(info.maxClaims, 40)
})
