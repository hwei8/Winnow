// cli/pipeline.mjs — 一键流水线：抓取 → 抽取 → 归簇 → 链接判定 → 建档/重写/合并 → QA → 回归报告
//
// 用法：
//   node src/cli/pipeline.mjs --urls=URL1,URL2                 # 指定 URL
//   node src/cli/pipeline.mjs --feed=hn --limit=8              # HN 首页自动发现
//   node src/cli/pipeline.mjs --feed=hn --limit=8 --urls=...   # 两者合并
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { provenanceOf } from '../shared/thresholds.mjs'
import { openDb, ROOT, nowIso } from '../shared/db.mjs'
import { outFile, localDate } from '../shared/config.mjs'

const HERE = import.meta.dirname
// 子进程输出可能很长：execFileSync 默认 1MB 缓冲，超出会被杀掉并误报失败
const MAX_BUFFER = 64 * 1024 * 1024
const arg = (name, def = '') => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : def
}
const URLS_ARG = arg('urls').split(',').map(s => s.trim()).filter(Boolean)
const FEED = arg('feed')
const ADAPTER = arg('adapter')
const ADAPTER_SOURCE = arg('source')
const LIMIT = Number(arg('limit', '8'))
const SEARCH_ON = process.argv.includes('--search') || arg('search') === '1'
const HOT_N = Number(arg('hot', '0'))
const MAX_URLS = Number(arg('max-urls', '16'))
const RUN_ID = 'run:' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)

// 1) 采集：adapter 模式（先 collect 再处理已有条目）或 URL 模式
async function collectViaAdapter () {
  const { execFileSync } = await import('node:child_process')
  const args = [path.join(HERE, 'collect.mjs'), `--adapter=${ADAPTER}`, `--limit=${LIMIT}`]
  if (ADAPTER_SOURCE) args.push(`--source=${ADAPTER_SOURCE}`)
  try {
    const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
    const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) || '{}')
    return parsed
  } catch (e) {
    return { error: String(e.stderr || e.message).slice(0, 200), saved: [] }
  }
}

// 1a) 调外部发现工具（search_discover / hot_track），解析其最后一行 JSON
function runTool (script, extra = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, script), '--json', ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = out.trim().split('\n').filter(l => l.trim().startsWith('{'))
    return JSON.parse(lines.at(-1) || '{}')
  } catch (e) {
    return { error: String(e.stderr || e.message).slice(0, 200), urls: [] }
  }
}

// 1b) URL 发现（无 adapter 时）
async function discover () {
  const urls = [...URLS_ARG]
  if (SEARCH_ON) {
    const r = runTool('discover.mjs')
    const add = (r.urls || []).filter(u => !urls.includes(u))
    urls.push(...add)
    console.log(`[pipeline] search: ${add.length} urls${r.error ? ' (error: ' + r.error.slice(0, 60) + ')' : ''}`)
  }
  if (HOT_N > 0) {
    const r = runTool('hot.mjs', ['--promote', String(HOT_N)])
    const add = (r.urls || []).filter(u => !urls.includes(u))
    urls.push(...add)
    console.log(`[pipeline] hot: ${add.length} urls${r.error ? ' (error: ' + r.error.slice(0, 60) + ')' : ''}`)
  }
  if (FEED === 'hn') {
    try {
      const r = await fetch(`https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${LIMIT * 2}`)
      const d = await r.json()
      const seen = new Set(urls)
      for (const h of d.hits || []) {
        if (!h.url || seen.has(h.url)) continue
        if (/twitter\.com|x\.com|youtube\.com|github\.com\/.*\/issues/.test(h.url)) continue
        urls.push(h.url); seen.add(h.url)
        if (urls.length >= LIMIT) break
      }
    } catch (e) { console.error('feed discover failed:', e.message) }
  }
  return urls.slice(0, Math.max(MAX_URLS, URLS_ARG.length))
}

// 2) 执行步骤
function runStep (script, env = {}) {
  const t0 = Date.now()
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, script)], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe']
    })
    return { script, ok: true, ms: Date.now() - t0, out: out.slice(-4000) }
  } catch (e) {
    return { script, ok: false, ms: Date.now() - t0, out: String(e.stdout || '').slice(-4000), err: String(e.stderr || e.message).slice(-2000) }
  }
}

// 3) 主流程
const db = openDb()
let urls = []
let collected = null
if (ADAPTER) {
  collected = await collectViaAdapter()
  console.log(`[pipeline] adapter=${ADAPTER} collected: ${collected?.saved?.length ?? 0} items`)
} else {
  urls = await discover()
}
console.log(`[pipeline] run ${RUN_ID} | urls: ${urls.length} | items: ${collected?.saved?.length ?? 0}`)
const steps = []
if (collected?.saved?.length) steps.push(runStep('ingest.mjs', { ITEMS: collected.saved.join(',') }))
else if (urls.length) steps.push(runStep('ingest.mjs', { URLS: urls.join(',') }))
steps.push(runStep('finalize.mjs'))
steps.push(runStep('apply-policy.mjs'))
steps.push(runStep('apply-consolidate.mjs'))
steps.push(runStep('qa.mjs'))
steps.forEach(s => console.log(`  ${s.ok ? 'OK ' : 'ERR'} ${s.script} ${s.ms}ms`))

// 4) 汇总
const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const decisions = db.prepare(`SELECT action, COUNT(*) n FROM ingest_decision WHERE decided_at >= ? GROUP BY action`).all(since)
const severities = db.prepare(`SELECT severity, action, COUNT(*) n FROM story_update WHERE at >= ? AND severity IS NOT NULL GROUP BY severity, action`).all(since)
const qaAll = db.prepare(`SELECT COUNT(*) c, ROUND(AVG(score),1) avg, ROUND(MIN(score),1) mn, ROUND(MAX(score),1) mx FROM story_qa`).get()
const qaActive = db.prepare(`SELECT COUNT(*) c, ROUND(AVG(score),1) avg, ROUND(MIN(score),1) mn, ROUND(MAX(score),1) mx
  FROM story_qa q JOIN story s ON s.id=q.story_id
  WHERE (s.status IS NULL OR s.status!='duplicate') AND (s.story_kind IS NULL OR s.story_kind='story')`).get()
const activeScores = db.prepare(`SELECT q.score FROM story_qa q JOIN story s ON s.id=q.story_id
  WHERE (s.status IS NULL OR s.status!='duplicate') AND (s.story_kind IS NULL OR s.story_kind='story') ORDER BY q.score`).all().map(r => r.score)
const medianActive = activeScores.length ? activeScores[Math.floor(activeScores.length / 2)] : 0
const activeDist = db.prepare(`SELECT CASE WHEN score>=90 THEN '90+' WHEN score>=80 THEN '80-89' WHEN score>=70 THEN '70-79' ELSE '<70' END b, COUNT(*) n FROM story_qa GROUP BY b`).all()
const low = db.prepare(`SELECT q.story_id, q.score, q.coverage, q.dup_rate, s.title FROM story_qa q JOIN story s ON s.id=q.story_id
  WHERE q.score < 70 AND s.status != 'duplicate' AND s.story_kind != 'snippet' ORDER BY q.score ASC LIMIT 8`).all()
const anomalies = db.prepare(`SELECT COUNT(*) c FROM story_qa WHERE coverage > 1 OR coverage < 0.2`).get().c
// 卡住的流水线项与关键事实的单源份额：报告里必须有，否则"延期/拆分"永远静默
// 阈值状态进报告：未标定的阈值每天在报告里露一次脸，免得它悄悄变成"事实"
const thState = ['link', 'facts', 'policy', 'rewrite']
  .map((k) => `${k}=${provenanceOf(k).state || 'unknown'}`)
  .join('｜')
const deferred = db.prepare("SELECT COUNT(*) c FROM ingest_decision WHERE action='deferred'").get().c
const splitPending = db.prepare("SELECT COUNT(*) c FROM story_update WHERE action='split_pending'").get().c
const factSources = db.prepare('SELECT COUNT(*) c FROM fact WHERE source_count >= 2').get().c
const totals = {
  stories: db.prepare('SELECT COUNT(*) c FROM story').get().c,
  withBody: db.prepare("SELECT COUNT(*) c FROM story WHERE body_md IS NOT NULL AND body_md != ''").get().c,
  active: db.prepare("SELECT COUNT(*) c FROM story WHERE (status IS NULL OR status!='duplicate') AND (story_kind IS NULL OR story_kind='story')").get().c,
  duplicate: db.prepare("SELECT COUNT(*) c FROM story WHERE status='duplicate'").get().c,
  snippet: db.prepare("SELECT COUNT(*) c FROM story WHERE story_kind='snippet'").get().c,
  facts: db.prepare('SELECT COUNT(*) c FROM fact').get().c
}
const reportPath = outFile('reports', `daily-${localDate()}.md`)
mkdirSync(path.dirname(reportPath), { recursive: true })
const md = `# 每日回归报告 ${localDate()}

- 运行 ID：${RUN_ID}
- 输入：${ADAPTER ? `adapter=${ADAPTER}（采集 ${collected?.saved?.length ?? 0} 条）` : `URL ${urls.length} 条`}${SEARCH_ON ? '（含搜索发现）' : ''}${HOT_N ? `（含热榜 Top ${HOT_N}）` : ''}
- 采集健康：${collected ? JSON.stringify({ list: collected.refs, saved: collected.health?.saved, errors: collected.health?.errors }) : '—'}
- 步骤：${steps.map(s => `${s.ok ? '✅' : '❌'} ${s.script.replace('.mjs', '')}`).join(' · ')}

## 判定分布（本次）
${decisions.length ? decisions.map(d => `- ${d.action}: ${d.n}`).join('\n') : '- 无'}

## 策略分级（本次）
${severities.length ? severities.map(s => `- ${s.severity}/${s.action}: ${s.n}`).join('\n') : '- 无'}

## 全库状态
- Story：${totals.stories}（有正文 ${totals.withBody}｜活跃 ${totals.active}｜重复 ${totals.duplicate}｜片段 ${totals.snippet}）
- 事实：${totals.facts}（其中被 ≥2 个独立源证实：${factSources}）
- QA（全部）：${qaAll.c} 篇｜均分 ${qaAll.avg}｜min ${qaAll.mn}｜max ${qaAll.mx}
- 卡住的判定：延期 ${deferred}｜该拆未拆 ${splitPending}
- 阈值状态：${thState}
- QA（活跃）：${qaActive.c} 篇｜均分 **${qaActive.avg}**｜中位 **${medianActive}**｜min ${qaActive.mn}｜max ${qaActive.mx}
- QA 分布（全部）：${activeDist.map(d => `${d.b}: ${d.n}`).join('｜')}
- 覆盖率异常（>1 或 <0.2）：${anomalies}

## 低分 Story（活跃，<70）
${low.length ? low.map(l => `- ${l.score}｜${l.title.slice(0, 40)}（覆盖 ${l.coverage}，重复 ${l.dup_rate}）`).join('\n') : '- 无'}
`
writeFileSync(reportPath, md)
db.prepare('INSERT OR REPLACE INTO pipeline_run(id,started_at,finished_at,urls,new_stories,updates,duplicates,severity_json,qa_json,report_path) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run(RUN_ID, new Date().toISOString(), new Date().toISOString(), urls.length,
    decisions.find(d => d.action === 'new')?.n || 0, decisions.find(d => d.action === 'update')?.n || 0,
    decisions.find(d => d.action === 'duplicate')?.n || 0, JSON.stringify(severities), JSON.stringify({ all: qaAll, active: qaActive }), reportPath)
console.log('[pipeline] report:', reportPath)
console.log(JSON.stringify({ decisions, severities, qaAll, qaActive, totals, report: reportPath }, null, 1))
db.close()
