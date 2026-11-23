import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { env, envInt, envBool, outPath, dataPath, secretPath, ROOT, OUT_DIR, DATA_DIR } from '../src/shared/config.mjs'

test('env falls back when unset', () => {
  assert.equal(env('IM_TEST_MISSING', 'x'), 'x')
  assert.equal(env('IM_TEST_MISSING'), undefined)
})

test('env prefers process value', () => {
  process.env.IM_TEST_VALUE = 'yes'
  assert.equal(env('IM_TEST_VALUE', 'no'), 'yes')
  delete process.env.IM_TEST_VALUE
})

test('envInt parses and clamps to fallback', () => {
  process.env.IM_TEST_NUM = '42'
  assert.equal(envInt('IM_TEST_NUM', 1), 42)
  process.env.IM_TEST_NUM = 'not-a-number'
  assert.equal(envInt('IM_TEST_NUM', 7), 7)
  delete process.env.IM_TEST_NUM
})

test('envBool treats 1/true/yes as true', () => {
  for (const v of ['1', 'true', 'yes', 'TRUE']) {
    process.env.IM_TEST_BOOL = v
    assert.equal(envBool('IM_TEST_BOOL'), true, v)
  }
  for (const v of ['0', 'false', 'no', '']) {
    process.env.IM_TEST_BOOL = v
    assert.equal(envBool('IM_TEST_BOOL'), false, v)
  }
  delete process.env.IM_TEST_BOOL
})

test('path helpers stay inside their roots', () => {
  assert.equal(outPath('briefs', 'a.md'), path.join(OUT_DIR, 'briefs', 'a.md'))
  assert.equal(dataPath('p0.db'), path.join(DATA_DIR, 'p0.db'))
  assert.ok(OUT_DIR.startsWith(ROOT))
})

test('secretPath points at .secrets', () => {
  assert.ok(secretPath('zen.key').includes('.secrets'))
})
