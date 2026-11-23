// cli/apply-consolidate.mjs — 对存在追加堆积的 Story 执行节合并（真实应用）
import { openDb } from '../shared/db.mjs'
import { consolidateSections } from '../domains/story/consolidate.mjs'

const db = openDb()
const stories = db.prepare(`SELECT x.story_id, COUNT(*) n FROM story_section x JOIN story s ON s.id=x.story_id
  WHERE x.heading LIKE '最新进展%' AND (s.status IS NULL OR s.status!='duplicate')
  GROUP BY x.story_id HAVING n >= 2 ORDER BY n DESC`).all()
console.log('stories with append piles:', stories.length)
let ok = 0, skip = 0, rb = 0
for (const s of stories) {
  const beforeEach = { sections: db.prepare('SELECT COUNT(*) c FROM story_section WHERE story_id=?').get(s.story_id).c, chars: db.prepare('SELECT length(body_md) n FROM story WHERE id=?').get(s.story_id).n }
  const r = await consolidateSections({ db, storyId: s.story_id })
  const after = { sections: db.prepare('SELECT COUNT(*) c FROM story_section WHERE story_id=?').get(s.story_id).c, chars: db.prepare('SELECT length(body_md) n FROM story WHERE id=?').get(s.story_id).n }
  if (r.ok) { ok++; console.log('  OK  ', s.story_id, '| sections', beforeEach.sections, '→', after.sections, '| chars', beforeEach.chars, '→', after.chars, '| cov', r.coverage) }
  else if (r.skipped) { skip++ }
  else { rb++; console.log('  ROLLBACK', s.story_id, JSON.stringify(r).slice(0, 140)) }
}
console.log(JSON.stringify({ total: stories.length, ok, skipped: skip, rolledBack: rb }))
db.close()
