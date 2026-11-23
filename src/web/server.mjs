// server.mjs —— 记忆底座 P0 只读浏览服务器
//
//   node web/server.mjs            # 默认 0.0.0.0:3083
//   PORT=3083 HOST=0.0.0.0 node web/server.mjs
//
// 只用 Node 24 内置模块（node:http / node:sqlite / node:fs / node:path / node:url）。
// 数据层全部只读，见 queries.mjs。页面首屏由服务端渲染，浏览器只负责交互增强。

import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

import { getStats, getStream, getStory, getStoryFacts, getEntity, getLatestBriefing, getStances, getAnnotationStats, getSearchPage, getClaimIssues, getAudit, getTopics, getTopicPage, getLatestBeat, search, getItem, SUMMARY_ROOT, DB_PATH } from './queries.mjs'
import { createCapture, setKnowledgeState, addAnnotation, listCaptures, createResearch, toggleInterest, runBeat, enqueueIngest } from './write.mjs'
import { spawn } from 'node:child_process'
import pathMod from 'node:path'
import { headerHtml, streamMain, storyMain, entityMain, memoryMain, briefMain, stanceMain, searchMain, claimsMain, auditMain, topicsMain, topicMain, errorMain } from './views/templates.mjs'
import { esc } from './views/fmt.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(HERE, 'public')
const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 3083)
const SUMMARY_PREFIX = path.resolve(SUMMARY_ROOT) + path.sep
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
}

// ── 基础工具 ────────────────────────────────────────────────────────────
function baseHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra
  }
}

function sendHtml(res, status, html, extra = {}) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, baseHeaders({
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-cache',
    ...extra
  }))
  res.end(body)
}

function sendJson(res, status, data, extra = {}) {
  const body = Buffer.from(JSON.stringify(data), 'utf8')
  res.writeHead(status, baseHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extra
  }))
  res.end(body)
}

function sendText(res, status, text, extra = {}) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, baseHeaders({
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    ...extra
  }))
  res.end(body)
}

/** JSON 嵌进 <script> 时把危险字符转义，避免提前闭合标签 */
function jsonForInlineScript(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const SHELLS = { index: 'index.html', story: 'story.html', entity: 'entity.html' }

/** 读取 shell 模板并一次性替换占位符（单趟替换，避免内容里的占位符被二次替换） */
async function renderPage({ shellName, page, title, main, boot }) {
  const tpl = await readFile(path.join(PUBLIC_DIR, SHELLS[shellName]), 'utf8')
  const stats = safeStats()
  const values = {
    TITLE: esc(title),
    PAGE: esc(page),
    HEADER: headerHtml(stats),
    MAIN: main,
    BOOT: jsonForInlineScript(boot)
  }
  return tpl.replace(/\{\{(TITLE|PAGE|HEADER|MAIN|BOOT)\}\}/g, (_, key) => values[key] ?? '')
}

let statsCache = { at: 0, value: null }
function safeStats() {
  const now = Date.now()
  if (statsCache.value && now - statsCache.at < 5000) return statsCache.value
  try {
    statsCache = { at: now, value: getStats() }
    return statsCache.value
  } catch {
    return statsCache.value ?? { items: 0, stories: 0, claims: 0, entities: 0, segments: 0, frames: 0 }
  }
}

function decodeParam(raw) {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

// ── 静态文件 ────────────────────────────────────────────────────────────
const STATIC_NAME_RE = /^\/[A-Za-z0-9._-]+$/

async function serveStatic(pathname, req, res) {
  if (!STATIC_NAME_RE.test(pathname)) return false
  const ext = path.extname(pathname).toLowerCase()
  const mime = MIME[ext]
  if (!mime) return false
  const filePath = path.join(PUBLIC_DIR, pathname.slice(1))
  // 双保险：解析后必须仍在 public 目录内
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return false
  let info
  try {
    info = await stat(filePath)
  } catch {
    return false
  }
  if (!info.isFile()) return false
  res.writeHead(200, baseHeaders({
    'content-type': mime,
    'content-length': info.size,
    'cache-control': 'no-cache'
  }))
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res)
  return true
}

// ── /api/frame：证据截图（防目录穿越）───────────────────────────────────
async function serveFrame(req, res, url) {
  const raw = url.searchParams.get('path')
  if (!raw) return sendJson(res, 400, { error: '缺少 path 参数' })

  const resolved = path.resolve(raw)
  if (resolved.includes('\0')) return sendJson(res, 400, { error: '非法路径' })
  // 必须落在 SUMMARY_ROOT 之内（path.resolve 已消解 ../）
  if (!resolved.startsWith(SUMMARY_PREFIX)) {
    return sendJson(res, 403, { error: '路径不在允许的目录内' })
  }
  const ext = path.extname(resolved).toLowerCase()
  const mime = MIME[ext]
  if (!mime || !mime.startsWith('image/')) return sendJson(res, 403, { error: '只允许读取图片文件' })

  let info
  try {
    info = await stat(resolved)
  } catch {
    return sendJson(res, 404, { error: '截图不存在' })
  }
  if (!info.isFile()) return sendJson(res, 404, { error: '截图不存在' })
  if (info.size > 32 * 1024 * 1024) return sendJson(res, 413, { error: '文件过大' })

  res.writeHead(200, baseHeaders({
    'content-type': mime,
    'content-length': info.size,
    'cache-control': 'public, max-age=3600'
  }))
  if (req.method === 'HEAD') {
    res.end()
    return undefined
  }
  return createReadStream(resolved)
    .on('error', () => res.destroy())
    .pipe(res)
}

// ── 页面路由 ────────────────────────────────────────────────────────────
async function handleStreamPage(req, res, url) {
  const sort = url.searchParams.get('sort') === 'claims' ? 'claims' : 'recent'
  const filter = url.searchParams.get('filter') === 'unseen' ? 'unseen' : 'all'
  const data = getStream({ offset: 0, limit: 20, sort, filter })
  const html = await renderPage({
    shellName: 'index',
    page: 'stream',
    title: '记忆流 · 记忆底座 P0',
    main: streamMain(data),
    boot: { page: 'stream', stream: data, stats: safeStats() }
  })
  sendHtml(res, 200, html)
}

async function handleMemoryPage(req, res) {
  const captures = listCaptures({ limit: 50 })
  const due = await Promise.resolve().then(() => {
    try { return getDueCaptures() } catch { return [] }
  })
  const html = await renderPage({
    shellName: 'index',
    page: 'memory',
    title: '记忆 · 记忆底座',
    main: memoryMain({ captures, due }),
    boot: { page: 'memory' }
  })
  sendHtml(res, 200, html)
}

function getDueCaptures () {
  const now = new Date().toISOString()
  return listCaptures({ limit: 200 }).filter(c => c.review_at && c.review_at <= now && c.status !== 'archived')
}

async function handleStoryPage(req, res, storyId) {
  const data = getStory(storyId)
  if (!data) {
    const html = await renderPage({
      shellName: 'index',
      page: 'story',
      title: '事件不存在 · 记忆底座 P0',
      main: errorMain({ title: '事件不存在', detail: `查不到 story id：${storyId}` }),
      boot: { page: 'story' }
    })
    sendHtml(res, 404, html)
    return
  }
  const html = await renderPage({
    shellName: 'story',
    page: 'story',
    title: `${data.story.title} · 记忆底座 P0`,
    main: storyMain(data),
    boot: { page: 'story', story: data, stats: safeStats() }
  })
  sendHtml(res, 200, html)
}

async function handleEntityPage(req, res, entityId) {
  const data = getEntity(entityId)
  if (!data) {
    const html = await renderPage({
      shellName: 'entity',
      page: 'entity',
      title: '实体不存在 · 记忆底座 P0',
      main: errorMain({ title: '实体不存在', detail: `查不到 entity id：${entityId}` }),
      boot: { page: 'entity' }
    })
    sendHtml(res, 404, html)
    return
  }
  const html = await renderPage({
    shellName: 'entity',
    page: 'entity',
    title: `${data.entity.name} · 记忆底座 P0`,
    main: entityMain(data),
    boot: { page: 'entity', entity: data, stats: safeStats() }
  })
  sendHtml(res, 200, html)
}

// ── API 路由 ────────────────────────────────────────────────────────────
async function readBody (req, limit = 64 * 1024) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(new Error('invalid json')) } })
    req.on('error', reject)
  })
}
async function handleWrite (req, res, pathname) {
  try {
    const body = await readBody(req)
    if (pathname === '/api/capture') {
      const row = createCapture(body)
      sendJson(res, 200, { ok: true, capture: row })
      return
    }
    if (pathname === '/api/state') {
      const row = setKnowledgeState(body)
      sendJson(res, 200, { ok: true, state: row })
      return
    }
    if (pathname === '/api/annotation') {
      const row = addAnnotation(body)
      sendJson(res, 200, { ok: true, annotation: row })
      return
    }
    if (pathname === '/api/interest') {
      sendJson(res, 200, { ok: true, ...toggleInterest({ topic: body.topic, weight: Number(body.weight || 1) }) })
      return
    }
    if (pathname === '/api/ingest-run') {
      const child = spawn(process.execPath, [pathMod.join(ROOT, 'worker_ingest.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore' })
      child.unref()
      sendJson(res, 202, { ok: true, started: true, pid: child.pid })
      return
    }
    if (pathname === '/api/ingest') {
      const urls = Array.isArray(body.urls) ? body.urls : [body.url].filter(Boolean)
      const queued = urls.map(u => enqueueIngest(u))
      sendJson(res, 200, { ok: true, queued })
      return
    }
    if (pathname === '/api/beat') {
      const r = await runBeat()
      sendJson(res, 200, { ok: true, beat: r })
      return
    }
    if (pathname === '/api/research') {
      const row = await createResearch({ storyId: body.storyId, force: !!body.force, kind: body.kind === 'contrast' ? 'contrast' : 'deep' })
      sendJson(res, 200, { ok: true, research: row })
      return
    }
    if (pathname === '/api/captures') {
      sendJson(res, 200, { captures: listCaptures({ status: body.status || null, limit: Number(body.limit || 20) }) })
      return
    }
    sendJson(res, 404, { error: 'unknown write endpoint' })
  } catch (e) {
    sendJson(res, 400, { error: String(e.message).slice(0, 120) })
  }
}

function handleApi(req, res, url, pathname) {
  const p = pathname

  if (p === '/api/stats') {
    sendJson(res, 200, getStats())
    return true
  }

  if (p === '/api/stream') {
    const q = url.searchParams
    sendJson(res, 200, getStream({
      offset: q.get('offset') ?? 0,
      limit: q.get('limit') ?? 20,
      sort: q.get('sort') ?? 'recent'
    }))
    return true
  }

  if (p === '/api/search') {
    const q = url.searchParams.get('q') ?? ''
    const limit = url.searchParams.get('limit') ?? 30
    sendJson(res, 200, search(q, limit))
    return true
  }

  if (p === '/api/frame') {
    serveFrame(req, res, url).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: '读取截图失败' })
      else res.destroy()
    })
    return true
  }

  const storyFactsMatch = /^\/api\/story\/(.+)\/facts$/.exec(p)
  if (storyFactsMatch) {
    const id = decodeParam(storyFactsMatch[1])
    if (id === null) return sendJson(res, 400, { error: 'id 编码非法' }), true
    const data = getStoryFacts(id)
    if (!data) sendJson(res, 404, { error: 'story not found', id })
    else sendJson(res, 200, data)
    return true
  }

  const storyMatch = /^\/api\/story\/(.+)$/.exec(p)
  if (storyMatch) {
    const id = decodeParam(storyMatch[1])
    if (id === null) return sendJson(res, 400, { error: 'id 编码非法' }), true
    const data = getStory(id)
    if (!data) sendJson(res, 404, { error: 'event not found', id })
    else sendJson(res, 200, data)
    return true
  }

  const entityMatch = /^\/api\/entity\/(.+)$/.exec(p)
  if (entityMatch) {
    const id = decodeParam(entityMatch[1])
    if (id === null) return sendJson(res, 400, { error: 'id 编码非法' }), true
    const data = getEntity(id)
    if (!data) sendJson(res, 404, { error: 'entity not found', id })
    else sendJson(res, 200, data)
    return true
  }

  const itemMatch = /^\/api\/item\/(.+)$/.exec(p)
  if (itemMatch) {
    const id = decodeParam(itemMatch[1])
    if (id === null) return sendJson(res, 400, { error: 'id 编码非法' }), true
    const data = getItem(id)
    if (!data) sendJson(res, 404, { error: 'item not found', id })
    else sendJson(res, 200, data)
    return true
  }

  sendJson(res, 404, { error: 'unknown api', path: p })
  return true
}

// ── 请求分发 ────────────────────────────────────────────────────────────
async function route(req, res) {
  const started = Date.now()
  let url
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  } catch {
    sendText(res, 400, 'bad request')
    return
  }
  const pathname = url.pathname

  try {
    if (req.method === 'POST') {
      await handleWrite(req, res, pathname)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD, POST' })
      return
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204, baseHeaders({ 'cache-control': 'public, max-age=86400' }))
      res.end()
      return
    }

    if (pathname.startsWith('/api/')) {
      handleApi(req, res, url, pathname)
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      await handleStreamPage(req, res, url)
      return
    }

    if (pathname === '/memory') {
      await handleMemoryPage(req, res)
      return
    }

    if (pathname === '/topics') {
      const html = await renderPage({
        shellName: 'index', page: 'topics', title: '覆盖地图 · 记忆底座',
        main: topicsMain({ topics: getTopics(), beat: getLatestBeat() }), boot: { page: 'topics' }
      })
      sendHtml(res, 200, html)
      return
    }

    const topicPage = /^\/topic\/(.+)$/.exec(pathname)
    if (topicPage) {
      const name = decodeParam(topicPage[1])
      const data = name && getTopicPage(name)
      if (!data) {
        sendHtml(res, 404, await renderPage({ shellName: 'index', page: 'topics', title: '主题不存在', main: errorMain({ title: '主题不存在', detail: String(name) }), boot: { page: 'topics' } }))
        return
      }
      const html = await renderPage({ shellName: 'index', page: 'topic', title: `${name} · 记忆底座`, main: topicMain(data), boot: { page: 'topic' } })
      sendHtml(res, 200, html)
      return
    }

    if (pathname === '/search') {
      const q = url.searchParams.get('q') || ''
      const html = await renderPage({
        shellName: 'index', page: 'search', title: q ? `搜索 ${q} · 记忆底座` : '搜索 · 记忆底座',
        main: searchMain(getSearchPage(q)), boot: { page: 'search' }
      })
      sendHtml(res, 200, html)
      return
    }

    if (pathname === '/claims') {
      const html = await renderPage({
        shellName: 'index', page: 'claims', title: '数据质量 · 记忆底座',
        main: claimsMain(getClaimIssues()), boot: { page: 'claims' }
      })
      sendHtml(res, 200, html)
      return
    }

    if (pathname === '/audit') {
      const html = await renderPage({
        shellName: 'index', page: 'audit', title: '审计 · 记忆底座',
        main: auditMain(getAudit()), boot: { page: 'audit' }
      })
      sendHtml(res, 200, html)
      return
    }

    if (pathname === '/stance') {
      const html = await renderPage({
        shellName: 'index', page: 'stance', title: '我的立场 · 记忆底座',
        main: stanceMain({ stances: getStances(), stats: getAnnotationStats() }), boot: { page: 'stance' }
      })
      sendHtml(res, 200, html)
      return
    }

    if (pathname === '/brief') {
      const brief = getLatestBriefing()
      const html = await renderPage({
        shellName: 'index',
        page: 'brief',
        title: '今日简报 · 记忆底座',
        main: briefMain(brief),
        boot: { page: 'brief' }
      })
      sendHtml(res, 200, html)
      return
    }

    const storyPage = /^\/story\/(.+)$/.exec(pathname)
    if (storyPage) {
      const id = decodeParam(storyPage[1])
      if (id === null) {
        sendText(res, 400, 'bad id')
        return
      }
      await handleStoryPage(req, res, id)
      return
    }

    const entityPage = /^\/entity\/(.+)$/.exec(pathname)
    if (entityPage) {
      const id = decodeParam(entityPage[1])
      if (id === null) {
        sendText(res, 400, 'bad id')
        return
      }
      await handleEntityPage(req, res, id)
      return
    }

    if (await serveStatic(pathname, req, res)) return

    const html = await renderPage({
      shellName: 'index',
      page: 'stream',
      title: '页面不存在 · 记忆底座 P0',
      main: errorMain({ title: '页面不存在', detail: `没有这个地址：${pathname}` }),
      boot: { page: 'stream' }
    })
    sendHtml(res, 404, html)
  } catch (err) {
    console.error(`[error] ${req.method} ${pathname}`, err)
    if (!res.headersSent) {
      if (pathname.startsWith('/api/')) sendJson(res, 500, { error: 'internal error' })
      else sendText(res, 500, '服务端错误，请查看日志')
    } else {
      res.destroy()
    }
  } finally {
    const ms = Date.now() - started
    if (ms > 3000) console.warn(`[slow] ${req.method} ${pathname} ${ms}ms`)
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[fatal-route]', err)
    if (!res.headersSent) sendText(res, 500, '服务端错误')
    else res.destroy()
  })
})

server.requestTimeout = 30000
server.headersTimeout = 20000
server.keepAliveTimeout = 5000

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  else socket.destroy()
})

// 兜底：不让单个请求的异常拖垮长时间运行的服务
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err))
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err))

function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address)
    }
  }
  return out
}

server.listen(PORT, HOST, () => {
  const addrs = lanAddresses()
  const stats = safeStats()
  console.log('记忆底座 P0 · 只读浏览服务')
  console.log(`  监听：${HOST}:${PORT}`)
  for (const ip of addrs.length ? addrs : ['127.0.0.1']) {
    console.log(`  http://${ip}:${PORT}/`)
  }
  console.log(`  本地：http://127.0.0.1:${PORT}/`)
  console.log(`  数据库：${process.env.P0_DB || DB_PATH}（只读）`)
  console.log(`  数据量：${stats.items} 条目 / ${stats.stories} 事件 / ${stats.claims} claim / ${stats.entities} 实体`)
})

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请先停掉旧进程或用 PORT=xxxx 启动。`)
    process.exit(1)
  }
  console.error('[server error]', err)
})

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`)
  server.close(() => {
    try {
      // 只读连接，关闭即可
      import('./queries.mjs').then((m) => m.closeDb?.()).catch(() => {})
    } finally {
      process.exit(0)
    }
  })
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
