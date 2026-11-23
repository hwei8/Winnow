// label.mjs — 交互标注器（同一终端里 y/n/u 逐条过，随时退出、随时续标）
//
// 设计取舍
//   * 默认不显示模型分数：先看分数再标，标出来的就是"模型的影子"，bench 会自证。
//     想看分数就加 --show-score，但那批标签要单独记（label_meta.blind=false）。
//   * 每标一条立刻落盘：标注是唯一不可再生的资源，不能因为一次 Ctrl-C 白干。
//
// 用法
//   node src/cli/label.mjs --task=link                 # 续标（从第一条未标注开始）
//   node src/cli/label.mjs --task=link --show-score    # 带分数标注
//   node src/cli/label.mjs --task=link --stats         # 只看进度
//   node src/cli/label.mjs --task=link --set=link:0012=same --hard=1
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { BENCH_DIR } from '../shared/config.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const s = a.replace(/^--/, '')
  const i = s.indexOf('=')
  return i < 0 ? [s, '1'] : [s.slice(0, i), s.slice(i + 1)]
}))
const TASK = args.task || 'link'
const FILE = args.file || path.join(BENCH_DIR, `${TASK}.v1.jsonl`)
if (!existsSync(FILE)) {
  console.error(`no dataset: ${FILE}\n先跑 npm run bench:build -- --task=${TASK}`)
  process.exit(2)
}

const load = () => readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const save = (rows) => writeFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
let rows = load()

if (args.stats) {
  const byLabel = {}
  for (const r of rows) byLabel[r.label || 'unlabelled'] = (byLabel[r.label || 'unlabelled'] || 0) + 1
  console.log(JSON.stringify({ file: FILE, rows: rows.length, ...byLabel }, null, 1))
  process.exit(0)
}

// 非交互：一次改一条，脚本化补标/纠错用
if (args.set) {
  const [id, label] = String(args.set).split('=')
  const row = rows.find((r) => r.id === id)
  if (!row) { console.error(`no such id: ${id}`); process.exit(2) }
  if (!['same', 'diff', 'unsure'].includes(label)) { console.error('label must be same|diff|unsure'); process.exit(2) }
  row.label = label
  if (args.hard !== undefined) row.hard = args.hard === '1' || args.hard === 'true'
  row.label_meta = { blind: !args['show-score'], at: new Date().toISOString() }
  save(rows)
  console.log(`set ${id} → ${label}${row.hard ? ' (hard)' : ''}`)
  process.exit(0)
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
const when = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—')

const queue = rows.filter((r) => !r.label)
if (!queue.length) { console.log('全部标完了 🎉'); process.exit(0) }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((resolve) => rl.question(q, resolve))

console.log(`${FILE}\n待标 ${queue.length} 条（已标 ${rows.length - queue.length}）。y=同一事件  n=不同  u=说不清  s=跳过  h=标为硬负例  q=退出\n`)

let i = 0
for (const row of queue) {
  const a = row.a || {}
  const b = row.b || {}
  console.log('─'.repeat(78))
  console.log(`#${row.id}  [${++i}/${queue.length}]  余弦 ${row.features?.cos ?? '—'}  相隔 ${row.features?.dtDays ?? '—'} 天${row.features?.selfItem ? '  (同一条目自己的 Story)' : ''}`)
  if (args['show-score']) console.log(`  模型：same_event ${row.scores?.same_event ?? '—'}  affinity ${row.scores?.fact_affinity ?? '—'}`)
  console.log(`\nA  ${when(a.ts)}  ${clip(a.title, 90)}`)
  console.log(`   ${clip(a.text, 700)}\n`)
  console.log(`B  ${when(b.ts)}  ${clip(b.title, 90)}`)
  console.log(`   ${clip(b.text, 700)}\n`)
  let ans = ''
  while (!ans) {
    ans = (await ask('同一事件？[y/n/u/s/q] ')).trim().toLowerCase()
    if (ans === 'q') { save(rows); rl.close(); console.log('已保存，退出。'); process.exit(0) }
    if (!['y', 'n', 'u', 's', 'h'].includes(ans)) ans = ''
  }
  if (ans === 's') continue
  if (ans === 'h') {
    row.label = 'diff'
    row.hard = true
  } else {
    row.label = ans === 'y' ? 'same' : ans === 'n' ? 'diff' : 'unsure'
  }
  row.label_meta = { blind: !args['show-score'], at: new Date().toISOString() }
  save(rows)
  console.log(`  → ${row.label}${row.hard ? '（hard）' : ''}\n`)
}

save(rows)
rl.close()
console.log('全部标完了 🎉')
