// 数据库连接与通用数据工具。
//
// 路径与配置来自 shared/config.mjs；schema 的唯一权威定义在 shared/schema.mjs。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR, DB_PATH, ROOT, SUMMARY_ROOT } from './config.mjs'
import { applySchema } from './schema.mjs'

export { DB_PATH, ROOT, SUMMARY_ROOT, DATA_DIR }

/** 打开写连接（WAL + NORMAL），必要时建目录。 */
export function openDb (dbPath = DB_PATH) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  // 多个写进程（daemon / worker / web）并存：等锁而不是立刻 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 10000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA cache_size = -64000')
  return db
}

/** 重建空库（会删除现有文件），用于初始化与测试。 */
export function freshDb (dbPath = DB_PATH) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  const db = openDb(dbPath)
  applySchema(db)
  return db
}

export const nowIso = () => new Date().toISOString()

// ASR 术语损坏程度：每千字异常拉丁 token 数
export function oddTokenDensity (text) {
  const odd = text.match(/\b[A-Za-z]{2,}[0-9]|[0-9][A-Za-z]{2,}|[A-Z]{3,}/g) || []
  return odd.length / Math.max(1, text.length / 1000)
}

// Whisper 语种漂移：繁体字占比
const TRAD = /[個們這說會來時對後發現實為與國學經過還開關]/
export function scriptVariant (text) {
  let trad = 0
  const sample = text.slice(0, 30000)
  for (const ch of sample) if (TRAD.test(ch)) trad++
  const ratio = trad / Math.max(1, sample.length)
  return ratio > 0.004 ? 'hant' : 'hans'
}
