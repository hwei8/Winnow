// 语法检查：对所有源码做 node --check（CI 与本地 pre-commit 用）。
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, acc)
    else if (p.endsWith('.mjs') || p.endsWith('.js')) acc.push(p)
  }
  return acc
}

const files = ['src', 'scripts', 'tests'].flatMap((d) => {
  try { return walk(d) } catch { return [] }
})
let failed = 0
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.status !== 0) { failed++; console.error(`✗ ${file}\n${r.stderr}`) }
}
console.log(`${files.length - failed}/${files.length} files OK`)
process.exit(failed ? 1 : 0)
