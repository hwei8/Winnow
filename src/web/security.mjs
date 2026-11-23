// web/security.mjs — Web 准入与跨站防护的纯函数（server.mjs 使用，测试可直接导入）

import { timingSafeEqual } from 'node:crypto'

/** Host 头 → 小写主机名（去端口；支持 [IPv6]:port）。 */
export function hostnameOf (hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase()
  if (!h) return ''
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'))
  const i = h.lastIndexOf(':')
  return i > 0 && h.indexOf(':') === i ? h.slice(0, i) : h
}

/** 常量时间比较令牌。 */
export function tokenEquals (given, token) {
  if (!token || !given) return false
  const a = Buffer.from(String(given))
  const b = Buffer.from(String(token))
  return a.length === b.length && timingSafeEqual(a, b)
}

export function cookieValue (cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) { try { return decodeURIComponent(v.join('=')) } catch { return null } }
  }
  return null
}

/**
 * 写接口的跨站检查。返回 null 表示放行，否则 { status, error }。
 *   * 必须是 application/json：跨站 <form> 与"简单请求"只能发 text/plain / form 编码，
 *     要发 JSON 必须过 CORS 预检，而本服务不回应预检 → 浏览器拦下。
 *   * Sec-Fetch-Site 存在时必须是 same-origin（或 none：用户直接发起）。
 *   * Origin 存在时必须与 Host 一致；'null'（沙箱 iframe / file://）一律拒绝。
 * 命令行客户端（curl）不带 Origin / Sec-Fetch-Site，按 JSON 规则放行。
 */
export function writeRequestError (headers = {}) {
  const ct = String(headers['content-type'] || '').toLowerCase()
  if (!ct.startsWith('application/json')) return { status: 415, error: 'content-type must be application/json' }
  const site = headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return { status: 403, error: 'cross-site request rejected' }
  const origin = headers.origin
  if (origin === 'null') return { status: 403, error: 'opaque origin rejected' }
  if (origin) {
    let originHost = null
    try { originHost = new URL(origin).host.toLowerCase() } catch { /* 非法 Origin */ }
    if (originHost !== String(headers.host || '').toLowerCase()) return { status: 403, error: 'cross-origin request rejected' }
  }
  return null
}
