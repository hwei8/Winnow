// cli/brief.mjs — 生成今日简报（CLI）
//   node src/cli/brief.mjs              # 生成并打印
//   node src/cli/brief.mjs --hours=48 --count=12 --out   # 写文件 out/briefs/
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT } from '../shared/db.mjs'
import { generateBriefing } from '../domains/delivery/brief.mjs'
import { sendMessage, toPlainText } from '../providers/telegram.mjs'
import { outFile } from '../shared/config.mjs'

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d }
const db = openDb()
const hours = Number(arg('hours', '24'))
const count = Number(arg('count', '12'))
const b = await generateBriefing(db, { hours, count })
console.log(b.markdown)
if (process.argv.includes('--out')) {
  const dir = outFile('briefs')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `brief-${b.date}.md`)
  writeFileSync(file, b.markdown)
  console.error('written:', file)
}
if (process.argv.includes('--send')) {
  const r = await sendMessage(toPlainText(b.markdown), { chatId: arg('chat', null) })
  console.error('telegram sent:', JSON.stringify(r))
}
console.log(JSON.stringify({ id: b.id, date: b.date, stats: b.stats }))
db.close()
