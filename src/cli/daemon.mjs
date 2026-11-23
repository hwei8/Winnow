// cli/daemon.mjs — 每日调度：流水线 → 简报 → 度量
//
//   node src/cli/daemon.mjs --once                 # 立即跑一轮
//   node src/cli/daemon.mjs --loop [--at=08:00]    # 每天本地时间 at 点跑（后台 nohup）
//   node src/cli/daemon.mjs --once --steps=pipeline,brief,metrics
//   node src/cli/daemon.mjs --once --send          # 简报推送 Telegram
//
// 单实例：out/daemon.pid 用 O_EXCL 创建；持有者进程已退出时自动接管。
// 当天是否已跑记录在 out/daemon.state.json，日期按本地时区计算（与 --at 的小时一致）。
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from '../shared/db.mjs'
import { outFile, localDate } from '../shared/config.mjs'

const HERE = import.meta.dirname
const MAX_BUFFER = 64 * 1024 * 1024 // 子进程输出超过默认 1MB 会被杀掉并误报失败
const arg = (n, d = null) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d }
const STEPS = (arg('steps', 'pipeline,brief,metrics')).split(',').map(s => s.trim()).filter(Boolean)
const LOG = outFile('daemon.log')
const PID_FILE = outFile('daemon.pid')
const STATE_FILE = outFile('daemon.state.json')

function log (msg) { const line = `[${new Date().toISOString()}] ${msg}\n`; appendFileSync(LOG, line); console.log(line.trim()) }

// --at 按系统本地时间解释（getHours），当天键也必须用同一时区；toISOString 是 UTC，
// 东八区 08:00 前会算成前一天，导致一天跑两次。
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const localDayKey = (d = new Date()) => localDate(d, SYSTEM_TZ)

function isAlive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** 获取单实例锁；已有存活实例时返回 false。 */
function acquireLock () {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(PID_FILE, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      const release = () => { try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE) } catch {} }
      process.on('exit', release)
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0) })
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const holder = Number(readFileSync(PID_FILE, 'utf8').trim())
      if (holder && isAlive(holder)) return false
      try { unlinkSync(PID_FILE) } catch {} // 过期锁：持有者已退出
    }
  }
  return false
}

function runStep (name) {
  const t0 = Date.now()
  const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }
  try {
    if (name === 'pipeline') {
      execFileSync(process.execPath, [path.join(HERE, 'pipeline.mjs'), ...(arg('adapter') ? [`--adapter=${arg('adapter')}`, `--limit=${arg('limit', '8')}`] : [])], { ...opts, timeout: 60 * 60 * 1000 })
    } else if (name === 'brief') {
      const args = [path.join(HERE, 'brief.mjs'), '--out']
      if (process.argv.includes('--send')) args.push('--send')
      execFileSync(process.execPath, args, { ...opts, timeout: 30 * 60 * 1000 })
    } else if (name === 'metrics') {
      execFileSync(process.execPath, [path.join(HERE, 'metrics.mjs')], { ...opts, timeout: 10 * 60 * 1000 })
    } else if (name === 'beat') {
      execFileSync(process.execPath, [path.join(HERE, 'beat.mjs'), '--report'], { ...opts, timeout: 30 * 60 * 1000 })
    } else {
      log(`ERR unknown step ${name}`)
      return false
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
  const key = localDayKey(now)
  let state = {}
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch {
    // 升级兼容：旧版把状态写在 daemon.lock（UTC 日期），读一次避免升级当天重复跑
    try { state = JSON.parse(readFileSync(outFile('daemon.lock'), 'utf8')) } catch {}
  }
  const due = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)
  if (due && state.lastDay !== key) { state.lastDay = key; writeFileSync(STATE_FILE, JSON.stringify(state)); return true }
  return false
}

if (!acquireLock()) {
  console.error(`another daemon is running (see ${PID_FILE}); exiting`)
  process.exit(1)
}

const at = arg('at', '08:00')
if (!/^\d{1,2}:\d{2}$/.test(at)) { console.error('--at must be HH:MM'); process.exit(2) }
if (process.argv.includes('--loop')) {
  log(`daemon loop started (daily at ${at} local time)`)
  // execFileSync 会阻塞事件循环：上一轮没跑完时定时器不会重入
  setInterval(() => { try { if (shouldRunNow(at)) runOnce() } catch (e) { log('loop err ' + String(e.message).slice(0, 120)) } }, 60000)
  try { if (shouldRunNow(at)) runOnce() } catch (e) { log('loop err ' + String(e.message).slice(0, 120)) }
} else {
  runOnce()
}
