import test from 'node:test'
import assert from 'node:assert/strict'
import { hostnameOf, tokenEquals, cookieValue, writeRequestError } from '../src/web/security.mjs'

const json = { 'content-type': 'application/json', host: '127.0.0.1:3083' }

test('writeRequestError: only same-origin JSON writes pass', () => {
  assert.equal(writeRequestError(json), null) // curl / CLI
  assert.equal(writeRequestError({ ...json, origin: 'http://127.0.0.1:3083', 'sec-fetch-site': 'same-origin' }), null)
  assert.equal(writeRequestError({ ...json, 'content-type': 'application/json; charset=utf-8' }), null)

  // 跨站表单能发的"简单请求"类型
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) {
    assert.equal(writeRequestError({ ...json, 'content-type': ct }).status, 415, ct)
  }
  assert.equal(writeRequestError({ ...json, origin: 'https://evil.example' }).status, 403)
  assert.equal(writeRequestError({ ...json, origin: 'null' }).status, 403)
  assert.equal(writeRequestError({ ...json, origin: 'http://127.0.0.1:9999' }).status, 403)
  assert.equal(writeRequestError({ ...json, 'sec-fetch-site': 'cross-site' }).status, 403)
  assert.equal(writeRequestError({ ...json, 'sec-fetch-site': 'same-site' }).status, 403)
})

test('hostnameOf strips ports and handles IPv6', () => {
  assert.equal(hostnameOf('127.0.0.1:3083'), '127.0.0.1')
  assert.equal(hostnameOf('LocalHost'), 'localhost')
  assert.equal(hostnameOf('[::1]:3083'), '::1')
  assert.equal(hostnameOf('evil.example:80'), 'evil.example')
  assert.equal(hostnameOf(''), '')
})

test('tokenEquals and cookieValue', () => {
  assert.equal(tokenEquals('abc', 'abc'), true)
  assert.equal(tokenEquals('abd', 'abc'), false)
  assert.equal(tokenEquals('ab', 'abc'), false)
  assert.equal(tokenEquals('', 'abc'), false)
  assert.equal(tokenEquals('abc', null), false)
  assert.equal(cookieValue('a=1; winnow_token=s%3Dx; b=2', 'winnow_token'), 's=x')
  assert.equal(cookieValue('a=1', 'winnow_token'), null)
})
