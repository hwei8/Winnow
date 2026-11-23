// cli/realign.mjs — 锚点重对齐：句子 ↔ 故事事实（embedding + Jev），修复丢失/错位的锚点
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openDb } from '../shared/db.mjs'
import { decide } from '../providers/jev.mjs'
import { embedBatch } from '../providers/embed.mjs'

const db = openDb()
const ONLY = process.env.STORIES ? process.env.STORIES.split(',') : null
const embed = embedBatch
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d }

const stories = ONLY || db.prepare(`SELECT s.id, s.title, s.body_md FROM story s WHERE s.body_md IS NOT NULL AND s.body_md!=''
  AND (s.status IS NULL OR s.status!='duplicate')`).all().map(r => r.id)
console.log('candidate stories:', stories.length)
let fixed = 0
for (const sid of stories) {
  const story = db.prepare('SELECT id,title,body_md FROM story WHERE id=?').get(sid)
  if (!story) continue
  const anchors = db.prepare('SELECT COUNT(*) c FROM story_fact WHERE story_id=?').get(sid).c
  const available = db.prepare(`SELECT COUNT(DISTINCT f.id) c FROM story_item si JOIN claim c ON c.item_id=si.item_id JOIN fact f ON f.id=c.fact_id WHERE si.story_id=?`).get(sid).c
  if (!available || anchors >= Math.max(3, available * 0.6)) continue
  const facts = db.prepare(`SELECT DISTINCT f.id,f.canonical_text FROM story_item si JOIN claim c ON c.item_id=si.item_id JOIN fact f ON f.id=c.fact_id
    WHERE si.story_id=? AND COALESCE(c.status,'')!='meta'`).all(sid)
  if (facts.length < 2) continue
  const sents = []
  const re = /[^。！？\n]+[。！？]?/g
  let m
  while ((m = re.exec(story.body_md))) {
    const raw = m[0], start = m.index, text = raw.trim()
    if (text.length < 12 || text.startsWith('#')) continue
    const lead = raw.indexOf(text)
    sents.push({ text, start: start + lead, end: start + lead + text.length })
  }
  if (!sents.length) continue
  const factVecs = await embed(facts.map(f => f.canonical_text))
  const sentVecs = await embed(sents.map(s => s.text))
  const pairs = []
  sents.forEach((s, i) => {
    facts.map((f, j) => ({ f, cos: cos(sentVecs[i], factVecs[j]) })).sort((a, b) => b.cos - a.cos).slice(0, 3).filter(x => x.cos >= 0.55).forEach(t => pairs.push({ s: i, f: t.f, cos: t.cos }))
  })
  const state = { pairs: pairs.map((p, k) => ({ n: k, sentence: sents[p.s].text.slice(0, 180), fact: p.f.canonical_text.slice(0, 180) })) }
  const questions = {}
  pairs.forEach((p, k) => { questions['q' + k] = { type: 'noul', instructions: `Pair ${k}: the sentence asserts the same information as the fact.`, criteria: { true: 'Same subject/attribute/value; wording may differ.', false: 'Related but does not state it.' } } })
  let answers = {}
  if (pairs.length) { try { const r = await decide({ state, questions, timeoutMs: 120000 }); answers = r.answers || {} } catch {} }
  const accepted = pairs.filter((p, k) => (answers['q' + k]?.noul ?? 0) >= 0.6)
  if (!accepted.length) continue
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM story_fact WHERE story_id=?').run(sid)
    const ins = db.prepare('INSERT OR REPLACE INTO story_fact(story_id,fact_id,section_id,char_start,char_end,role,order_idx) VALUES (?,?,?,?,?,?,?)')
    accepted.forEach((p, order) => ins.run(sid, p.f.id, null, sents[p.s].start, sents[p.s].end, 'asserts', order))
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); continue }
  fixed++
  console.log('  realigned:', sid, '| anchors', anchors, '→', accepted.length, '| facts available', available)
}
console.log('fixed stories:', fixed)
db.close()
