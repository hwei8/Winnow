// cli/verify-web.mjs —— Web 端 HTTP 验收（零依赖，只读）
//
//   node src/web/server.mjs &            # 先起服务
//   node src/cli/verify-web.mjs          # 默认 http://127.0.0.1:3083
//   BASE=http://127.0.0.1:3083 node src/cli/verify-web.mjs
//
// 覆盖：11 个页面 + 9 个 GET 接口 + 404 / 405 / 参数校验 / 目录穿越防护 / HTML 转义。
// 只做读取，不写库；任何一条 POST 用例都用非法参数，确保不会落库。

const BASE = process.env.BASE || 'http://127.0.0.1:3083'

let pass = 0
let fail = 0
const failures = []

const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`) }
const bad = (name, detail = '') => { fail++; failures.push(`${name}${detail ? ` ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`) }
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail))

async function http (p, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(BASE + p, { redirect: 'manual', ...opts })
  const body = await res.text()
  return { status: res.status, headers: res.headers, body, ms: Math.round(performance.now() - t0) }
}
const json = async (p) => { const r = await http(p); return { ...r, data: (() => { try { return JSON.parse(r.body) } catch { return null } })() } }
const page = async (p) => http(p)

function section (title) {
  console.log(`\n${title}`)
}

// ── 页面 ────────────────────────────────────────────────
section('页面')
const pages = [
  ['/', '无限流'],
  ['/memory', '我要记住的'],
  ['/topics', '覆盖地图'],
  ['/search?q=ai', '搜索'],
  ['/claims', '数据质量'],
  ['/audit', '审计'],
  ['/stance', '立场'],
  ['/brief', '简报']
]
for (const [p, label] of pages) {
  const r = await page(p)
  check(`${label} ${p}`, r.status === 200 && r.body.includes('</html>'), `${r.status} ${r.ms}ms`)
}

// 详情页需要真实 id：从流里取一条，从 Story JSON 里取实体
const stream = await json('/api/stream?limit=3')
check('/api/stream 正常', stream.status === 200 && Array.isArray(stream.data?.stories), `${stream.status}`)
const stories = stream.data?.stories || []
check('流里有 Story', stories.length > 0, `${stories.length} 条`)

const sid = stories[0]?.id
if (sid) {
  const sp = await page(`/story/${encodeURIComponent(sid)}`)
  check('Story 页 200', sp.status === 200 && sp.body.includes('</html>'), `${sp.ms}ms`)
  check('Story 页含标题', sp.body.includes('<title>'))

  const sj = await json(`/api/story/${encodeURIComponent(sid)}`)
  check('/api/story/:id 结构', sj.status === 200 && !!sj.data?.story?.id, `${sj.status}`)
  const ent = sj.data?.story?.entities?.[0]?.id || sj.data?.entities?.[0]?.id
  if (ent) {
    const ep = await page(`/entity/${encodeURIComponent(ent)}`)
    check('实体页 200', ep.status === 200 && ep.body.includes('</html>'), `${ep.ms}ms`)
  } else {
    ok('实体页（无实体可测，跳过）')
  }

  const facts = await json(`/api/story/${encodeURIComponent(sid)}/facts`)
  check('/api/story/:id/facts', facts.status === 200, `${facts.status}`)

  const itemId = sj.data?.story?.items?.[0]?.id
  if (itemId) {
    const ip = await page(`/api/item/${encodeURIComponent(itemId)}`)
    check('/api/item/:id 可用', [200, 404].includes(ip.status), `${ip.status}`)
  }
}

const topic = await page('/topic/AI')
check('主题页（有数据或无数据都不许 5xx）', topic.status < 500, `${topic.status}`)

// ── 接口 ────────────────────────────────────────────────
section('接口')
const stats = await json('/api/stats')
check('/api/stats', stats.status === 200 && typeof stats.data?.stories === 'number', JSON.stringify(stats.data).slice(0, 60))

const s2 = await json('/api/search?q=nvidia')
check('/api/search', s2.status === 200, `${s2.status}`)

// ── 错误路径 ────────────────────────────────────────────
section('错误路径')
const nf = await page('/no-such-page-xyz')
check('未知页面 → 404', nf.status === 404, `${nf.status}`)
const nfApi = await json('/api/nope')
check('未知接口 → 404 JSON', nfApi.status === 404 && !!nfApi.data?.error, `${nfApi.status}`)
const nfStory = await json('/api/story/does-not-exist')
check('不存在的 Story → 404', nfStory.status === 404, `${nfStory.status}`)

const put = await http('/api/capture', { method: 'PUT' })
check('不支持的方法 → 405', put.status === 405, `${put.status}`)

const emptyCapture = await http('/api/capture', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}'
})
check('空 capture → 400', emptyCapture.status === 400, `${emptyCapture.status}`)

const badJson = await http('/api/capture', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{not json'
})
check('坏 JSON → 400', badJson.status === 400, `${badJson.status}`)

// 目录穿越：截图接口只允许 SUMMARY_ROOT 内的图片
const traverse = await json('/api/frame?path=../../../../etc/passwd')
check('frame 目录穿越被拦', [400, 403, 404].includes(traverse.status), `${traverse.status}`)
const nonImage = await json('/api/frame?path=/etc/hostname')
check('frame 非图片被拦', [400, 403, 404].includes(nonImage.status), `${nonImage.status}`)

// ── 静态资源与转义 ──────────────────────────────────────
section('静态与转义')
const css = await http('/style.css')
check('/style.css', css.status === 200 && (css.headers.get('content-type') || '').includes('text/css'), `${css.status}`)
const js = await http('/app.js')
check('/app.js', js.status === 200 && (js.headers.get('content-type') || '').includes('javascript'), `${js.status}`)
const fav = await http('/favicon.ico')
check('/favicon.ico', [200, 204].includes(fav.status), `${fav.status}`)

const xss = await page(`/search?q=${encodeURIComponent('<script>alert(1)</script>')}`)
check('搜索页不回显未转义脚本', xss.status === 200 && !xss.body.includes('<script>alert(1)</script>'), `${xss.status}`)

// ── 汇总 ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
