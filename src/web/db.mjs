// 只读连接与 SQL 辅助（Web 层共用）。
//
// 约定：只读连接，绝不建表/写库；语句缓存按 SQL 文本复用。

import { DatabaseSync } from 'node:sqlite'
import { DB_PATH, SUMMARY_ROOT } from '../shared/config.mjs'

export { DB_PATH, SUMMARY_ROOT }

export const STREAM_LIMIT_DEFAULT = 20
export const STREAM_LIMIT_MAX = 50
export const CARD_CLAIMS = 5
export const STORY_CLAIMS_MAX = 800
export const ENTITY_CLAIMS_MAX = 600

// ── 连接管理 ────────────────────────────────────────────────────────────
let db = null
const stmtCache = new Map()

function openConn() {
  const conn = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    conn.exec('PRAGMA busy_timeout = 4000')
  } catch {
    /* 只读连接上个别 PRAGMA 不可用，忽略 */
  }
  return conn
}

function conn() {
  if (!db) db = openConn()
  return db
}

export function closeDb() {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  db = null
  stmtCache.clear()
}

function openStatementsEmpty() {
  stmtCache.clear()
}

export function statement(sql) {
  let stmt = stmtCache.get(sql)
  if (!stmt) {
    stmt = conn().prepare(sql)
    stmtCache.set(sql, stmt)
  }
  return stmt
}

// 写进程（extractor）可能正在提交 WAL：失败时丢弃连接重开一次再试。
export function all(sql, params = []) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return statement(sql).all(...params)
    } catch (err) {
      if (attempt >= 2) throw err
      closeDb()
      openStatementsEmpty()
    }
  }
}

export function one(sql, params = []) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return statement(sql).get(...params) ?? null
    } catch (err) {
      if (attempt >= 2) throw err
      closeDb()
      openStatementsEmpty()
    }
  }
}

export const inList = (n) => Array.from({ length: n }, () => '?').join(',')

// 同一列可能混存 epoch 秒与 ISO 文本（不同脚本写入方式不同），
// 用 typeof 分支在 SQL 侧统一成 unix 秒，保证排序/比较正确。
export const TS = (expr) =>
  `CASE WHEN typeof(${expr}) = 'text' THEN CAST(strftime('%s', ${expr}) AS INTEGER) ELSE CAST(${expr} AS INTEGER) END`

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

