// cli/db.mjs — 数据库运维命令：初始化 / 统计 / 备份 / 压缩
//
//   node src/cli/db.mjs --init        # 建空库（已存在则拒绝，除非 --force）
//   node src/cli/db.mjs --stats       # 表行数概览
//   node src/cli/db.mjs --backup      # 用 VACUUM INTO 做一致性快照
//   node src/cli/db.mjs --vacuum      # 回收空间
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DB_PATH, OUT_DIR } from '../shared/config.mjs'
import { freshDb, openDb } from '../shared/db.mjs'
import { SCHEMA_VERSION } from '../shared/schema.mjs'

const has = (flag) => process.argv.includes(flag)
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)

if (has('--init')) {
  if (existsSync(DB_PATH) && !has('--force')) {
    console.error(`refusing to overwrite ${DB_PATH} (use --force)`)
    process.exit(1)
  }
  const db = freshDb()
  console.log(JSON.stringify({ ok: true, db: DB_PATH, schema: SCHEMA_VERSION, tables: db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c }))
  db.close()
} else if (has('--stats')) {
  const db = openDb()
  const version = db.prepare('PRAGMA user_version').get().user_version
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  const rows = {}
  for (const { name } of tables) {
    try { rows[name] = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c } catch { rows[name] = null }
  }
  console.log(JSON.stringify({ db: DB_PATH, schema: version, tables: rows }, null, 1))
  db.close()
} else if (has('--backup')) {
  mkdirSync(path.join(OUT_DIR, 'backup'), { recursive: true })
  const target = path.join(OUT_DIR, 'backup', `p0-${stamp()}.db`)
  const db = openDb()
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  db.close()
  console.log(JSON.stringify({ ok: true, target }))
} else if (has('--vacuum')) {
  const db = openDb()
  db.exec('VACUUM')
  db.close()
  console.log(JSON.stringify({ ok: true, db: DB_PATH }))
} else {
  console.log('usage: db.mjs --init|--stats|--backup|--vacuum')
}
