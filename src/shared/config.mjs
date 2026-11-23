// 配置与环境：所有路径、环境变量、密钥解析的唯一入口。
//
// 约定
//   * 代码里不出现任何绝对路径；路径一律从这里取。
//   * 运行时状态（数据库、产物、日志）在仓库根的 data/ 与 out/，均已 gitignore。
//   * 密钥优先读环境变量；环境变量缺失时才回落到 .secrets/（本地开发用，已 gitignore）。

import { readFileSync, existsSync } from 'node:fs'
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
export const DATA_DIR = path.resolve(ROOT, env('IM_DATA_DIR', 'data'))
export const OUT_DIR = path.resolve(ROOT, env('IM_OUT_DIR', 'out'))
export const CONFIG_DIR = path.join(ROOT, 'config')
export const SECRETS_DIR = path.join(ROOT, '.secrets')

// ── 数据库 ──────────────────────────────────────────────────────────────
export const DB_PATH = path.resolve(ROOT, env('IM_DB', path.join(DATA_DIR, 'p0.db')))

// ── 旧语料根（仅用于历史 frame 截图路径；新库不需要）─────────────────────
const SUMMARY_CANDIDATES = [env('SUMMARY_ROOT'), path.join(ROOT, 'Summary')].filter(Boolean)
export const SUMMARY_ROOT = SUMMARY_CANDIDATES.find((p) => existsSync(p)) || SUMMARY_CANDIDATES[0]

// ── Web ─────────────────────────────────────────────────────────────────
export const WEB_HOST = env('HOST', '0.0.0.0')
export const WEB_PORT = envInt('PORT', 3083)

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
export const dataPath = (...parts) => path.join(DATA_DIR, ...parts)
