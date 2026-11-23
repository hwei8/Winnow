// cli/capture.mjs — 私人记忆捕获与知识状态（CLI）
//
// 用法：
//   node src/cli/capture.mjs "想法内容" --kind=idea --intent="为什么存" --review=2026-12-01
//   node src/cli/capture.mjs --list [--status=inbox] [--limit=20]
//   node src/cli/capture.mjs --due                     # 到复核期的记忆
//   node src/cli/capture.mjs --seen story:story:rss:... # 标记看过（推进水位）
//   node src/cli/capture.mjs --known story:...          # 标记已知
import { openDb } from '../shared/db.mjs'
import { createCapture, listCaptures, dueCaptures, setState, pendingUpdates } from '../domains/memory/state.mjs'

const db = openDb()
const argv = process.argv.slice(2)
const flag = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : null
}
const has = (name) => argv.includes(`--${name}`)
const text = argv.find(a => !a.startsWith('--'))

if (has('list')) {
  const rows = listCaptures(db, { status: flag('status'), limit: Number(flag('limit') || 20) })
  console.log(JSON.stringify(rows, null, 1))
} else if (has('due')) {
  console.log(JSON.stringify(dueCaptures(db), null, 1))
} else if (flag('seen') || flag('known')) {
  const ref = flag('known') || flag('seen')
  const level = flag('known') ? 'known' : 'seen'
  const st = setState(db, { scope: 'story', refId: ref, level })
  const p = pendingUpdates(db, ref)
  console.log(JSON.stringify({ state: st, pending_before: p.count }, null, 1))
} else if (text) {
  const row = createCapture(db, {
    kind: flag('kind') || 'idea',
    content: text,
    intent: flag('intent'),
    reviewAt: flag('review'),
    targetType: flag('target') ? flag('target').split(':')[0] : null,
    targetId: flag('target') || null
  })
  console.log(JSON.stringify(row, null, 1))
} else {
  console.log('usage: node capture.mjs "内容" [--kind=idea] [--intent=...] [--review=YYYY-MM-DD] [--target=story:...]')
  console.log('       node capture.mjs --list | --due | --seen story:ID | --known story:ID')
}
db.close()
