// cli/beat.mjs — Beat Reporter CLI
//   node beat.mjs --map                 # 覆盖地图
//   node beat.mjs --topic=英伟达        # 单主题详情
//   node beat.mjs --add=半导体 --weight=2
//   node beat.mjs --report [--send]     # 兴趣缺口报告（可推 Telegram）
import { openDb } from '../shared/db.mjs'
import { coverageMap, topicDetail, beatReport, addInterest, listInterests } from '../domains/insights/beat.mjs'
import { sendMessage, toPlainText } from '../providers/telegram.mjs'

const arg = (n, d = null) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d }
const db = openDb()

if (process.argv.includes('--map')) {
  console.log(JSON.stringify(coverageMap(db, { limit: 30 }), null, 1))
} else if (arg('topic')) {
  console.log(JSON.stringify(topicDetail(db, arg('topic')), null, 1))
} else if (arg('add')) {
  console.log(JSON.stringify(addInterest(db, arg('add'), Number(arg('weight', '1')))))
} else if (process.argv.includes('--interests')) {
  console.log(JSON.stringify(listInterests(db), null, 1))
} else if (process.argv.includes('--report')) {
  const r = await beatReport(db)
  let md = `# Beat 报告 ${r.generated_at.slice(0, 10)}\n\n`
  for (const f of r.findings) {
    md += `## ${f.topic}\n`
    md += `- 覆盖：${f.coverage.stories} 个 Story / ${f.coverage.claims} claim / ${f.coverage.sources} 个源` + (f.coverage.last_days != null ? ` / 最近 ${f.coverage.last_days} 天前` : '') + `\n`
    if (f.coverage.gap) md += `- 缺口：${f.coverage.gap}\n`
    if (f.headline_only.length) md += `- 只知道标题：${f.headline_only.map(h => h.title).join('；')}\n`
    if (f.missing.length) md += `- 未收录文章：\n${f.missing.map(m => `    - ${m.title}（${m.at}）${m.url}`).join('\n')}\n`
    if (f.suggestions.length) md += `- 建议：${f.suggestions.join('；')}\n`
    md += '\n'
  }
  console.log(md)
  if (process.argv.includes('--send')) {
    const s = await sendMessage(toPlainText(md), { chatId: arg('chat') })
    console.error('telegram sent:', JSON.stringify(s))
  }
} else {
  console.log('usage: node beat.mjs --map | --topic=名称 | --add=主题 | --interests | --report [--send]')
}
db.close()
