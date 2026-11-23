// 端到端：起一个真实的 web/server.mjs（临时库、随机端口），验证访问控制、跨站防护与前端模块可加载。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { freshDb } from '../src/shared/db.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'winnow-server-'))
const dbPath = path.join(tmpDir, 'web.db')
freshDb(dbPath).close()

async function startServer (extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/web/server.mjs')], {
    env: { ...process.env, WINNOW_DB: dbPath, WINNOW_OUT_DIR: path.join(tmpDir, 'out'), HOST: '127.0.0.1', PORT: '0', NODE_NO_WARNINGS: '1', WINNOW_WEB_TOKEN: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + out)), 15000)
    const onData = (d) => {
      out += d
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${out}`)))
  })
  return { port, stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM') }) }
}

/** 原始 HTTP 请求：fetch 不允许改 Host / Origin / Sec-Fetch-* 头，这里要伪造它们。 */
function request (port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

const postJson = (port, p, data, headers = {}) => request(port, { method: 'POST', path: p, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })

test.after(() => rmSync(tmpDir, { recursive: true, force: true }))

test('web server: pages, headers, and the browser module graph', async (t) => {
  const s = await startServer()
  t.after(s.stop)

  const home = await request(s.port)
  assert.equal(home.status, 200)
  assert.match(home.headers['content-security-policy'], /script-src 'self'/)
  assert.equal(home.headers['x-frame-options'], 'DENY')

  // app.js 及其递归 import 的模块必须都能以 JS 类型加载（曾经 /templates.mjs 404，导致整页交互失效）
  const seen = new Set()
  const queue = ['/app.js']
  while (queue.length) {
    const url = queue.shift()
    if (seen.has(url)) continue
    seen.add(url)
    const r = await request(s.port, { path: url })
    assert.equal(r.status, 200, `${url} → ${r.status}`)
    assert.match(r.headers['content-type'], /javascript/, url)
    for (const m of r.body.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      queue.push(new URL(m[1], `http://x${url}`).pathname)
    }
  }
  assert.ok(seen.has('/templates.mjs') && seen.has('/fmt.mjs'), `module graph: ${[...seen]}`)

  // 目录穿越
  assert.equal((await request(s.port, { path: '/api/frame?path=../../etc/passwd' })).status, 403)
  assert.equal((await request(s.port, { path: '/..%2f..%2fpackage.json' })).status, 404)
})

test('web server: DNS-rebinding Host headers are rejected', async (t) => {
  const s = await startServer()
  t.after(s.stop)
  assert.equal((await request(s.port, { headers: { host: 'evil.example' } })).status, 403)
  assert.equal((await request(s.port, { headers: { host: `localhost:${s.port}` } })).status, 200)
})

test('web server: cross-site writes are rejected, same-origin writes work', async (t) => {
  const s = await startServer()
  t.after(s.stop)
  const origin = `http://127.0.0.1:${s.port}`

  // 跨站表单 / no-cors fetch 只能发 text/plain：必须被拒
  const plain = await request(s.port, { method: 'POST', path: '/api/capture', headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, body: '{"content":"pwned"}' })
  assert.equal(plain.status, 415)
  assert.equal((await postJson(s.port, '/api/capture', { content: 'pwned' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await postJson(s.port, '/api/capture', { content: 'pwned' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await postJson(s.port, '/api/research', { storyId: 'x' }, { origin: 'null' })).status, 403)

  const ok = await postJson(s.port, '/api/capture', { content: '同源写入', kind: 'idea' }, { origin, 'sec-fetch-site': 'same-origin' })
  assert.equal(ok.status, 200, ok.body)
  assert.equal(JSON.parse(ok.body).capture.content, '同源写入')

  // 输入校验
  assert.equal((await postJson(s.port, '/api/capture', { content: 'x', kind: 'evil' }, { origin })).status, 400)
  assert.equal((await postJson(s.port, '/api/state', { refId: 'story:x', level: 'pwned' }, { origin })).status, 400)

  const listed = await postJson(s.port, '/api/captures', { limit: 5 }, { origin })
  assert.equal(JSON.parse(listed.body).captures.length, 1)
})

test('web server: ingest refuses internal URLs (SSRF)', async (t) => {
  const s = await startServer()
  t.after(s.stop)
  const origin = `http://127.0.0.1:${s.port}`
  for (const url of ['http://127.0.0.1:22/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'file:///etc/passwd', 'http://[::1]/']) {
    const r = await postJson(s.port, '/api/ingest', { urls: [url] }, { origin })
    assert.equal(r.status, 400, `${url} → ${r.status} ${r.body}`)
  }
  const ok = await postJson(s.port, '/api/ingest', { urls: ['https://example.com/article'] }, { origin })
  assert.equal(ok.status, 200, ok.body)
  assert.equal(JSON.parse(ok.body).queued[0].status, 'queued')
})

test('web server: token mode requires the token on every request', async (t) => {
  const s = await startServer({ WINNOW_WEB_TOKEN: 's3cret-token' })
  t.after(s.stop)
  assert.equal((await request(s.port)).status, 401)
  assert.equal((await request(s.port, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await request(s.port, { headers: { authorization: 'Bearer s3cret-token' } })).status, 200)

  const login = await request(s.port, { path: '/?token=s3cret-token&sort=claims' })
  assert.equal(login.status, 303)
  assert.equal(login.headers.location, '/?sort=claims')
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  assert.match(String(login.headers['set-cookie']), /HttpOnly/)
  assert.match(String(login.headers['set-cookie']), /SameSite=Strict/)
  assert.equal((await request(s.port, { headers: { cookie } })).status, 200)
  // 令牌模式下 POST 仍受跨站规则约束
  assert.equal((await postJson(s.port, '/api/capture', { content: 'x' }, { cookie, origin: 'https://evil.example' })).status, 403)
})
