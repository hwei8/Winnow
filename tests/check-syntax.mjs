// tests/check-syntax.mjs — 静态检查（npm run check，CI 也跑）
//
//   1. 每个 .mjs/.js 都能通过 `node --check`（语法）；
//   2. 每个相对 import / 动态 import 都指向存在的文件；
//   3. 用 path.join(HERE|ROOT, '…*.mjs') 拼出来交给子进程的脚本路径都存在。
//
// 第 2、3 条专门防"挪目录后路径没跟着改"这类问题：这类错误语法检查发现不了，
// 只有跑到那条分支才会崩（曾经的 /templates.mjs 404、worker_ingest.mjs 不存在都属于此类）。

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIRS = ['src', 'tests']
const files = []
function walk (dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(mjs|js)$/.test(name)) files.push(p)
  }
}
for (const d of DIRS) walk(path.join(ROOT, d))

const problems = []
for (const file of files) {
  const rel = path.relative(ROOT, file)
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (e) {
    problems.push(`${rel}: syntax error\n${String(e.stderr).trim()}`)
    continue
  }
  const src = readFileSync(file, 'utf8')
  const isBrowser = rel.startsWith(path.join('src', 'web', 'public'))
  // 静态与动态 import 的相对路径
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[1])
    if (!existsSync(target)) problems.push(`${rel}: import not found: ${m[1]}`)
  }
  // 浏览器模块的绝对 import 由 web/server.mjs 提供：必须在 public/ 或 VIEW_MODULES 里
  if (isBrowser) {
    const server = readFileSync(path.join(ROOT, 'src/web/server.mjs'), 'utf8')
    for (const m of src.matchAll(/\bfrom\s*['"](\/[^'"]+)['"]/g)) {
      const inPublic = existsSync(path.join(ROOT, 'src/web/public', m[1]))
      const inViews = server.includes(`'${m[1]}':`)
      if (!inPublic && !inViews) problems.push(`${rel}: browser import ${m[1]} is not served by web/server.mjs`)
    }
  }
  // 交给子进程的脚本路径（ROOT/HERE 拼出的 .mjs），以及相对源码目录读取的数据文件（HERE 拼出的带扩展名路径）
  for (const m of src.matchAll(/\b\w+\.join\((HERE|ROOT|REPO_ROOT)((?:\s*,\s*'[^']*')+)\)/g)) {
    const parts = [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1])
    const last = parts.at(-1)
    const isScript = last.endsWith('.mjs')
    const isHereData = m[1] === 'HERE' && /\.\w+$/.test(last) && !parts[0].startsWith('out')
    if (!isScript && !isHereData) continue
    const base = m[1] === 'HERE' ? path.dirname(file) : ROOT
    const target = path.join(base, ...parts)
    if (!existsSync(target)) problems.push(`${rel}: path not found: ${path.relative(ROOT, target)}`)
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  console.error(`\n✖ ${problems.length} problem(s) in ${files.length} files`)
  process.exit(1)
}
console.log(`✔ ${files.length} files: syntax ok, all relative imports and script paths resolve`)
