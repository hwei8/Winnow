// cli/export.mjs — 知识库导出（Markdown + JSON）
//   node src/cli/export.mjs [--out=out/export] [--limit=0]
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT, nowIso } from '../shared/db.mjs'
import { OUT_DIR, localDate } from '../shared/config.mjs'

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d }
const db = openDb()
const day = localDate()
const outDir = path.resolve(ROOT, arg('out', path.join(OUT_DIR, 'export')), day)
mkdirSync(path.join(outDir, 'stories'), { recursive: true })

const stories = db.prepare(`SELECT id,title,category,body_md,first_seen_ts,last_update_ts,status,story_kind FROM story ORDER BY last_update_ts DESC`).all()
const facts = db.prepare('SELECT id,canonical_text,support_count,first_seen,last_updated,superseded_by FROM fact').all()
const captures = db.prepare('SELECT * FROM capture ORDER BY created_at DESC').all()
const annotations = db.prepare('SELECT * FROM annotation ORDER BY at DESC').all()
const stances = db.prepare('SELECT * FROM stance').all()
const knowledge = db.prepare('SELECT * FROM knowledge_state').all()

writeFileSync(path.join(outDir, 'stories.json'), JSON.stringify(stories, null, 1))
writeFileSync(path.join(outDir, 'facts.json'), JSON.stringify(facts, null, 1))
writeFileSync(path.join(outDir, 'captures.json'), JSON.stringify(captures, null, 1))
writeFileSync(path.join(outDir, 'annotations.json'), JSON.stringify(annotations, null, 1))
writeFileSync(path.join(outDir, 'stances.json'), JSON.stringify(stances, null, 1))
writeFileSync(path.join(outDir, 'knowledge_state.json'), JSON.stringify(knowledge, null, 1))

const byDay = {}
for (const s of stories) {
  const d = s.first_seen_ts ? localDate(new Date(s.first_seen_ts * 1000)) : 'unknown'
  ;(byDay[d] ||= []).push(s)
}
for (const [d, list] of Object.entries(byDay)) {
  const md = list.map(s => `# ${s.title}\n\n- id: ${s.id}\n- 分类: ${s.category || '—'}\n- 状态: ${s.status || 'active'}${s.story_kind ? ' / ' + s.story_kind : ''}\n\n${s.body_md || '（无正文）'}\n`).join('\n---\n\n')
  writeFileSync(path.join(outDir, 'stories', `${d}.md`), md)
}
const index = { exported_at: nowIso(), stories: stories.length, facts: facts.length, captures: captures.length, annotations: annotations.length, stances: stances.length, knowledge_state: knowledge.length, files: ['stories.json', 'facts.json', 'captures.json', 'annotations.json', 'stances.json', 'knowledge_state.json', 'stories/'] }
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1))
console.log(JSON.stringify({ outDir, ...index }, null, 1))
db.close()
