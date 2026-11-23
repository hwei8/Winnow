// cli/translate-titles.mjs — 英文 story 标题翻译成中文（保留原文到 title_original）
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT } from '../shared/db.mjs'
import { chat, extractJson } from '../providers/llm.mjs'

const db = openDb()
const rows = db.prepare('SELECT id,title FROM story').all().filter(r => !/[\u4e00-\u9fa5]/.test(r.title || ''))
console.log('to translate:', rows.length)
const B = 20
const tasks = []
for (let i = 0; i < rows.length; i += B) tasks.push(rows.slice(i, i + B))

const upd = db.prepare("UPDATE story SET title_original=COALESCE(title_original, title), title=? WHERE id=?")
let done = 0
for (const batch of tasks) {
  const list = batch.map((r, k) => `${k}. ${r.title}`).join('\n')
  let arr = null
  for (let t = 1; t <= 3 && !arr; t++) {
    const r = await chat({
      json: true, maxTokens: 8000,
      messages: [{ role: 'user', content: `把下面的英文新闻标题翻译成简洁的中文标题（不超过 24 字）。要求：忠实原意、保留专有名词（公司/产品/人名可用中文译名或保留英文）、不要加"据报道"之类。只输出 JSON：{"titles":["..."]}，长度=${batch.length}\n\n${list}` }]
    })
    const p = extractJson(r.content)
    if (p && Array.isArray(p.titles) && p.titles.length === batch.length) arr = p.titles
  }
  if (!arr) { console.error('batch failed', batch[0].title.slice(0, 30)); continue }
  db.exec('BEGIN IMMEDIATE')
  try {
    batch.forEach((row, k) => {
      let t = String(arr[k] || '').trim().replace(/^["“]|["”]$/g, '')
      if (t.length < 2) return
      upd.run(t.slice(0, 60), row.id)
      done++
    })
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); console.error(e.message.slice(0, 60)) }
}
console.log(JSON.stringify({ translated: done, total: rows.length }, null, 1))
db.close()
