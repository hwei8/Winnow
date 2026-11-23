// 出站抓取的安全护栏：只允许公网 http(s)，逐跳校验重定向，限制响应体大小。
//
// 威胁模型：入库 URL 来自 RSS 条目、搜索结果、Web 端「一键入库」——都不可信。
// 不加护栏时，任何人能让抓取器去请求 127.0.0.1 / 169.254.169.254 / 局域网设备，
// 并把响应正文存进库里、显示在 Web 上（SSRF + 数据外泄）。
//
// 已知局限：DNS 校验与真正连接之间存在 TOCTOU（DNS rebinding）。个人工具可接受；
// 真要防，需要自定义 dispatcher 固定解析结果。
//
// 本地开发确需抓内网地址时，设置 WINNOW_ALLOW_PRIVATE_FETCH=1。

import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { envBool } from './config.mjs'

const MAX_REDIRECTS = 5
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

function ipv4ToInt (ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }))

/** 是否为非公网地址（回环 / 私网 / 链路本地 / 保留 / 组播）。 */
export function isPrivateAddress (ip) {
  const family = net.isIP(ip)
  if (family === 4) {
    const n = ipv4ToInt(ip)
    return V4_BLOCKS.some(({ base, mask }) => (n & mask) === (base & mask))
  }
  if (family === 6) {
    const s = ip.toLowerCase()
    if (s === '::' || s === '::1') return true
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true // 十六进制写法的映射地址：一律拒绝
    if (/^f[cd]/.test(s)) return true // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(s)) return true // fe80::/10 链路本地
    if (/^ff/.test(s)) return true // 组播
    if (s.startsWith('64:ff9b:')) return true // NAT64，可能指向内网 v4
    return false
  }
  return true // 不是合法 IP：按不安全处理
}

const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i

/** 只做语法级检查（同步）：协议、凭据、字面量 IP、localhost 类主机名。 */
export function checkUrlSyntax (raw) {
  let u
  try { u = new URL(String(raw)) } catch { throw new Error('invalid url') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) urls are allowed')
  if (u.username || u.password) throw new Error('urls with credentials are not allowed')
  if (envBool('WINNOW_ALLOW_PRIVATE_FETCH')) return u
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (BLOCKED_HOST.test(host)) throw new Error(`blocked host: ${host}`)
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`blocked private address: ${host}`)
  return u
}

/** 完整检查（异步）：语法 + DNS 解析后的所有地址都必须是公网。 */
export async function assertPublicUrl (raw) {
  const u = checkUrlSyntax(raw)
  if (envBool('WINNOW_ALLOW_PRIVATE_FETCH')) return u
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return u
  let addrs
  try { addrs = await lookup(host, { all: true, verbatim: true }) } catch (e) { throw new Error(`dns lookup failed: ${host}`) }
  if (!addrs.length) throw new Error(`dns lookup failed: ${host}`)
  const bad = addrs.find(a => isPrivateAddress(a.address))
  if (bad) throw new Error(`blocked: ${host} resolves to private address ${bad.address}`)
  return u
}

/** 读取响应体，最多 maxBytes；超出则截断（HTML 截断仍可抽正文）。 */
async function readCapped (res, maxBytes) {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size))
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.length
  }
  return { text: Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'), truncated }
}

/**
 * 安全抓取文本：每一跳都校验目标地址，手动跟随重定向，限制大小与超时。
 * 返回 { text, status, url, contentType, truncated }；非 2xx 抛错。
 */
export async function safeFetchText (raw, { headers = {}, timeout = 25000, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const signal = AbortSignal.timeout(timeout)
  let current = String(raw)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current)
    const res = await fetch(current, { headers, signal, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {})
      current = new URL(res.headers.get('location'), current).toString()
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error('HTTP ' + res.status)
    }
    const { text, truncated } = await readCapped(res, maxBytes)
    return { text, status: res.status, url: current, contentType: res.headers.get('content-type') || '', truncated }
  }
  throw new Error('too many redirects')
}
