// 配置与环境：所有路径、环境变量、密钥解析的唯一入口。
//
// 约定
//   * 代码里不出现任何绝对路径；路径一律从这里取。
//   * 运行时状态（数据库、产物、日志）在仓库根的 data/ 与 out/，均已 gitignore。
//   * 密钥优先读环境变量；环境变量缺失时才回落到 .secrets/（本地开发用，已 gitignore）。

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** 读取仓库根的 .env（不覆盖已存在的环境变量），只执行一次。 */
function loadEnvFile () {
  const file = path.join(ROOT, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}
loadEnvFile()

/** 读环境变量（带默认值），空字符串视为未设置。 */
export function env (name, fallback = undefined) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

/** 新名字优先，回落到更名前的旧名字（兼容期用；下个大版本移除）。 */
export function envLegacy (name, legacy, fallback = undefined) {
  const v = env(name)
  return v !== undefined ? v : env(legacy, fallback)
}

export function envInt (name, fallback) {
  const v = Number(env(name))
  return Number.isFinite(v) ? v : fallback
}

export function envBool (name, fallback = false) {
  const v = env(name)
  if (v === undefined) return fallback
  return /^(1|true|yes|on)$/i.test(v)
}

// ── 目录 ────────────────────────────────────────────────────────────────
export const DATA_DIR = path.resolve(ROOT, envLegacy('WINNOW_DATA_DIR', 'IM_DATA_DIR', 'data'))
export const OUT_DIR = path.resolve(ROOT, envLegacy('WINNOW_OUT_DIR', 'IM_OUT_DIR', 'out'))
export const CONFIG_DIR = path.join(ROOT, 'config')
export const SECRETS_DIR = path.join(ROOT, '.secrets')

// ── 数据库 ──────────────────────────────────────────────────────────────
export const DB_PATH = path.resolve(ROOT, envLegacy('WINNOW_DB', 'IM_DB', path.join(DATA_DIR, 'winnow.db')))

// ── 旧语料根（仅用于历史 frame 截图路径；新库不需要）─────────────────────
const SUMMARY_CANDIDATES = [env('SUMMARY_ROOT'), path.join(ROOT, 'Summary')].filter(Boolean)
export const SUMMARY_ROOT = SUMMARY_CANDIDATES.find((p) => existsSync(p)) || SUMMARY_CANDIDATES[0]

// ── Web ─────────────────────────────────────────────────────────────────
// 默认只监听本机：写接口没有登录，暴露到局域网需要显式设置 HOST 并配置 WINNOW_WEB_TOKEN。
export const WEB_HOST = env('HOST', '127.0.0.1')
export const WEB_PORT = envInt('PORT', 3083)
/** 可选访问令牌：设置后所有请求都必须携带（Authorization: Bearer / cookie / ?token=）。 */
export const WEB_TOKEN = env('WINNOW_WEB_TOKEN', null)

/** 对外可访问的 Web 根地址（简报里的链接用）；不设则输出站内相对路径。 */
export const PUBLIC_URL = (env('WINNOW_PUBLIC_URL', '') || '').replace(/\/+$/, '')

// ── 时区 ────────────────────────────────────────────────────────────────
// 与 web/views/fmt.mjs 的 TZ 保持一致（那份要在浏览器里跑，不能 import 本文件）
export const TZ = env('WINNOW_TZ', 'Asia/Shanghai')
/** 指定时区的日期 YYYY-MM-DD（toISOString 是 UTC，东八区早上 8 点前会算成前一天）。 */
export function localDate (d = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

// ── LLM ─────────────────────────────────────────────────────────────────
export const LLM_CHAT_MODEL = env('LLM_CHAT_MODEL', 'deepseek-v4.1-flash')

// ── 密钥 ────────────────────────────────────────────────────────────────
/** 密钥文件路径（相对仓库根或 .secrets/）。 */
export function secretPath (name) {
  return path.isAbsolute(name) ? name : path.join(SECRETS_DIR, name)
}

/** 读密钥：环境变量优先，其次 .secrets/<file>；都没有时返回 null。 */
export function readSecret (envName, fileName) {
  const fromEnv = env(envName)
  if (fromEnv) return fromEnv.trim()
  try { return readFileSync(secretPath(fileName), 'utf8').trim() } catch { return null }
}

export const outPath = (...parts) => path.join(OUT_DIR, ...parts)
/** 产物文件路径：同 outPath，但保证父目录存在（新克隆的仓库没有 out/）。 */
export function outFile (...parts) {
  const p = outPath(...parts)
  mkdirSync(path.dirname(p), { recursive: true })
  return p
}
export const dataPath = (...parts) => path.join(DATA_DIR, ...parts)
