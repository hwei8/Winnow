// cli/daemon.mjs — 每日调度：流水线 → 简报 → 度量（P4 尾巴）
//
//   node daemon.mjs --once                 # 立即跑一轮
//   node daemon.mjs --loop [--at=08:00]    # 每天 at 点跑（后台 nohup）
//   node daemon.mjs --once --steps=pipeline,brief,metrics
//   node daemon.mjs --once --send          # 简报推送 Telegram
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from '../shared/db.mjs'

const HERE = import.meta.dirname
const arg = (n, d = null) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d }
const STEPS = (arg('steps', 'pipeline,brief,metrics')).split(',').map(s => s.trim()).filter(Boolean)
const LOG = path.join(ROOT, 'out', 'daemon.log')
const LOCK = path.join(ROOT, 'out', 'daemon.lock')
mkdirSync(path.join(ROOT, 'out'), { recursive: true })

function log (msg) { const line = `[${new Date().toISOString()}] ${msg}\n`; appendFileSync(LOG, line); console.log(line.trim()) }

function runStep (name) {
  const t0 = Date.now()
  try {
    if (name === 'pipeline') {
      execFileSync(process.execPath, [path.join(HERE, 'pipeline.mjs'), ...(arg('adapter') ? [`--adapter=${arg('adapter')}`, `--limit=${arg('limit', '8')}`] : [])], { cwd: ROOT, encoding: 'utf8', timeout: 60 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] })
    } else if (name === 'brief') {
      const args = [path.join(HERE, 'brief.mjs'), '--out']
      if (process.argv.includes('--send')) args.push('--send')
      execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 30 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] })
    } else if (name === 'metrics') {
      execFileSync(process.execPath, [path.join(HERE, 'metrics.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] })
    } else if (name === 'beat') {
      execFileSync(process.execPath, [path.join(HERE, 'beat.mjs'), '--report'], { cwd: ROOT, encoding: 'utf8', timeout: 30 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    log(`ok ${name} (${Math.round((Date.now() - t0) / 1000)}s)`)
    return true
  } catch (e) {
    log(`ERR ${name}: ${String(e.stderr || e.message).slice(-300)}`)
    return false
  }
}

function runOnce () {
  log(`run start steps=${STEPS.join(',')}`)
  let ok = 0
  for (const s of STEPS) if (runStep(s)) ok++
  log(`run done ${ok}/${STEPS.length}`)
}

function shouldRunNow (at) {
  const [h, m] = at.split(':').map(Number)
  const now = new Date()
  const key = now.toISOString().slice(0, 10)
  let state = {}
  try { state = JSON.parse(readFileSync(LOCK, 'utf8')) } catch {}
  const due = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)
  if (due && state.lastDay !== key) { state.lastDay = key; writeFileSync(LOCK, JSON.stringify(state)); return true }
  return false
}

const at = arg('at', '08:00')
if (process.argv.includes('--loop')) {
  log(`daemon loop started (daily at ${at})`)
  setInterval(() => { try { if (shouldRunNow(at)) runOnce() } catch (e) { log('loop err ' + String(e.message).slice(0, 120)) } }, 60000)
  try { if (shouldRunNow(at)) runOnce() } catch {}
} else {
  runOnce()
}
