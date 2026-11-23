import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { isPrivateAddress, checkUrlSyntax, assertPublicUrl, safeFetchText } from '../src/shared/net.mjs'

test('isPrivateAddress classifies loopback / private / metadata / public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.188', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip)
  }
})

test('checkUrlSyntax rejects dangerous urls before anything is queued', () => {
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/', 'http://localhost:3083/', 'http://foo.localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.0.1/', 'https://user:pw@example.com/', 'http://printer.local/', 'not a url']) {
    assert.throws(() => checkUrlSyntax(u), undefined, u)
  }
  assert.equal(checkUrlSyntax('https://example.com/a?b=1').hostname, 'example.com')
})

test('assertPublicUrl blocks hostnames that resolve to private addresses', async () => {
  await assert.rejects(assertPublicUrl('http://127.0.0.1.nip.io.invalid/'), /dns lookup failed|private/)
  await assert.rejects(assertPublicUrl('http://localhost/'), /blocked host/)
})

test('safeFetchText refuses private targets, and caps body size + redirect hops when allowed', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('x'.repeat(50000)); return }
    if (req.url.startsWith('/loop')) { res.writeHead(302, { location: '/loop' }); res.end(); return }
    if (req.url === '/hop') { res.writeHead(301, { location: '/big' }); res.end(); return }
    res.writeHead(404); res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  await assert.rejects(safeFetchText(`${base}/big`), /blocked private address/)

  process.env.WINNOW_ALLOW_PRIVATE_FETCH = '1'
  t.after(() => { delete process.env.WINNOW_ALLOW_PRIVATE_FETCH })
  const r = await safeFetchText(`${base}/hop`, { maxBytes: 1000 })
  assert.equal(r.text.length, 1000)
  assert.equal(r.truncated, true)
  assert.equal(r.url, `${base}/big`)
  await assert.rejects(safeFetchText(`${base}/loop`), /too many redirects/)
  await assert.rejects(safeFetchText(`${base}/missing`), /HTTP 404/)
})
