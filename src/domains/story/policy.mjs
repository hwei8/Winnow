// story/policy.mjs — 判断一个 Update 是否需要重写 Story（P0–P4 五档）
//
// 判据：
//   P0 事实被推翻/撤稿 → 立即重写 + supersede + 更正标注
//   P1 主线/Lede 改变、新阶段/新主体 → 重写（或 split 子 Story）
//   P2 累积过多（缺口≥8 / 已有2+更新节 / 追加占比>30%）→ 合并重写
//   P3 一般增量 → 追加"最新进展"
//   P4 完全覆盖 → 不动作（duplicate）
import { decide } from '../../providers/jev.mjs'

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '')
const tri = (s) => { const x = norm(s); const t = new Set(); for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3)); return t }
const jac = (a, b) => { const A = tri(a), B = tri(b); if (!A.size || !B.size) return 0; let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n) }
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const toVec = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

export async function classifyUpdate ({ db, parentId, newFactIds, itemTitle = '' }) {
  const parent = db.prepare('SELECT id,title,body_md FROM story WHERE id=?').get(parentId)
  if (!parent) return { severity: 'P4', action: 'none', reasons: ['parent-missing'] }
  const newFacts = db.prepare(`SELECT id,canonical_text FROM fact WHERE id IN (${newFactIds.map(() => '?').join(',')})`).all(...newFactIds)
  const exclude = new Set(newFactIds)
  const oldFacts = db.prepare(`SELECT DISTINCT f.id,f.canonical_text,c.embedding FROM story_fact sf
    JOIN fact f ON f.id=sf.fact_id JOIN fact_claim fc ON fc.fact_id=f.id JOIN claim c ON c.id=fc.claim_id
    WHERE sf.story_id=? AND c.embedding IS NOT NULL`).all(parentId).filter(f => !exclude.has(f.id))
  const oldVec = new Map(); for (const f of oldFacts) if (!oldVec.has(f.id)) oldVec.set(f.id, toVec(f.embedding))
  const newEmbed = db.prepare(`SELECT c.embedding FROM fact_claim fc JOIN claim c ON c.id=fc.claim_id WHERE fc.fact_id=? AND c.embedding IS NOT NULL LIMIT 1`).get(newFacts[0]?.id || '')
  const covered = new Set()
  {
    // 只把已正文覆盖的事实算作 covered；role='update' 的是待并入的缺口事实
    const parentFactIds = new Set(db.prepare("SELECT fact_id FROM story_fact WHERE story_id=? AND (role IS NULL OR role != 'update')").all(parentId).map(r => r.fact_id))
    for (const nf of newFacts) if (parentFactIds.has(nf.id)) covered.add(nf.id)
  }
  let gapCount = newFacts.length
  const reasons = []
  if (!gapCount) return { severity: 'P4', action: 'none', reasons: ['no-new-facts'] }

  // 1) 与已有事实的相似对（cos ≥ 0.55），判断矛盾/过时
  const pairs = []
  const uncovered = []
  for (const nf of newFacts) {
    const nvc0 = db.prepare(`SELECT c.embedding FROM fact_claim fc JOIN claim c ON c.id=fc.claim_id WHERE fc.fact_id=? AND c.embedding IS NOT NULL LIMIT 1`).get(nf.id)
    if (nvc0) {
      const nv0 = toVec(nvc0.embedding)
      let best = 0
      for (const v of oldVec.values()) { const s = cos(nv0, v); if (s > best) best = s }
      if (!covered.has(nf.id) && best < 0.85) uncovered.push(nf)
    }
  }
  gapCount = uncovered.length
  for (const nf of newFacts.slice(0, 12)) {
    const nvc = db.prepare(`SELECT c.embedding FROM fact_claim fc JOIN claim c ON c.id=fc.claim_id WHERE fc.fact_id=? AND c.embedding IS NOT NULL LIMIT 1`).get(nf.id)
    if (!nvc) continue
    const nv = toVec(nvc.embedding)
    const near = [...oldVec.entries()].map(([id, v]) => ({ id, cos: cos(nv, v) })).sort((a, b) => b.cos - a.cos).slice(0, 2).filter(x => x.cos >= 0.55)
    for (const t of near) pairs.push({ newFact: nf, oldFactId: t.id, cos: +t.cos.toFixed(2) })
  }

  const questions = {}
  const state = { pairs: [] }
  for (const p of pairs) {
    const old = oldFacts.find(f => f.id === p.oldFactId)
    const idx = state.pairs.length
    state.pairs.push({ n: idx, old: old.canonical_text.slice(0, 160), new: p.newFact.canonical_text.slice(0, 160) })
    questions[`c${idx}`] = { type: 'noul', instructions: `Pair ${idx}: the new fact contradicts the old fact (both cannot be true).`, criteria: { true: 'Same subject/attribute but incompatible values or opposite outcomes.', false: 'Compatible; different aspect or an update of the same direction.' } }
    questions[`s${idx}`] = { type: 'noul', instructions: `Pair ${idx}: the new fact supersedes the old fact (old is outdated: a later stage or newer value replaced it).`, criteria: { true: 'The new fact describes a later stage/official replacement of what the old fact said.', false: 'They can coexist or the new one is merely additional.' } }
  }
  // 2) 撤稿/更正关键词 + 3) Lede/结构变化
  const bodyHead = parent.body_md.slice(0, 1500)
  const state2 = { story_title: parent.title, story_head: bodyHead, new_facts: newFacts.slice(0, 12).map(f => f.canonical_text.slice(0, 140)) }
  const q2 = {
    retraction: { type: 'noul', instructions: 'The new facts explicitly correct or retract something previously reported (e.g. "earlier reports were wrong", official denial, revised figure).', criteria: { true: 'Explicit correction/retraction of earlier reporting or figures.', false: 'New development or additional information, not a correction.' } },
    lede: { type: 'noul', instructions: 'The new facts change the mainline of the story or would require rewriting the opening (new phase, new principal actor, or the dramatic situation reversed).', criteria: { true: 'The story’s main point/opening must change (e.g. CEO under investigation → board moving to oust CEO).', false: 'Additional detail that fits the existing narrative.' } },
    split: { type: 'noul', instructions: 'The new facts describe a distinct sub-event that deserves its own separate story rather than being merged into this one.', criteria: { true: 'Distinct event (e.g. a separate lawsuit, a new unrelated incident) with its own lead.', false: 'Same event continued; belongs in this story.' } }
  }
  let answers = {}
  let degraded = null
  try { const r = await decide({ state: { ...state, ...state2 }, questions: { ...questions, ...q2 } }); answers = r.answers || {} } catch (e) {
    // Jev 不可用时所有概率都是 0，分级会悄悄落到 P3/P4。保留这种降级行为（不阻塞流水线），
    // 但要让调用方和日志看得见：结果带 degraded，并写进 reasons。
    degraded = String(e.message).slice(0, 120)
    console.error('[policy] Jev unavailable, classification degraded:', degraded)
  }

  let contradictions = 0, supersedes = []
  pairs.forEach((p, i) => {
    if ((answers[`c${i}`]?.noul ?? 0) >= 0.7) contradictions++
    if ((answers[`s${i}`]?.noul ?? 0) >= 0.7) supersedes.push({ old: p.oldFactId, new: p.newFact.id })
  })
  const retraction = answers.retraction?.noul ?? 0
  let lede = answers.lede?.noul ?? 0
  const split = answers.split?.noul ?? 0
  // 状态变更启发式：宣布/关闭/停止/辞职/罢免/起诉/终止 等事件动词，作用于故事主体 → 视为 Lede 变化
  const STATE_WORDS = /(罢免|辞职|解雇|离职|关闭|停产|停工|终止|叫停|破产|退市|被起诉|起诉|逮捕|获释|收购完成|获批)/
  // 中文字符级重合（中文标题没有空格，按字符集合判断主体相关）
  const titleChars = new Set([...String(parent.title)].filter(c => /[\u4e00-\u9fa5A-Za-z]/u.test(c)))
  const titleSim = newFacts.slice(0, 8).some(f => {
    const factChars = new Set([...String(f.canonical_text)].filter(c => /[\u4e00-\u9fa5A-Za-z]/u.test(c)))
    let hit = 0; for (const c of titleChars) if (factChars.has(c)) hit++
    return titleChars.size >= 3 && hit / titleChars.size >= 0.45
  })
  if (lede < 0.7 && titleSim && newFacts.some(f => STATE_WORDS.test(f.canonical_text))) lede = Math.max(lede, 0.72)

  // 4) QA 风险 / 累积
  const updateSections = (parent.body_md.match(/^## 最新进展/gm) || []).length
  const appendEst = newFacts.reduce((a, f) => a + Math.min(120, f.canonical_text.length + 20), 0)
  const appendRatio = appendEst / Math.max(1, parent.body_md.length)
  const dupRisk = newFacts.slice(0, 8).filter(f => {
    const sents = parent.body_md.split(/[。！？\n]+/).filter(s => s.trim().length > 12)
    return sents.some(s => jac(f.canonical_text, s) >= 0.6)
  }).length / Math.max(1, Math.min(8, newFacts.length))

  // 分级
  let severity = 'P3', action = 'append'
  if (retraction >= 0.7 || contradictions > 0) { severity = 'P0'; action = 'rewrite'; reasons.push(retraction >= 0.7 ? 'retraction/correction' : `contradicts ${contradictions} existing fact(s)`) }
  else if (split >= 0.7) { severity = 'P1'; action = 'split'; reasons.push('distinct sub-event (split)') }
  else if (lede >= 0.55) { severity = 'P1'; action = 'rewrite'; reasons.push('mainline/lede changes') }
  else if (updateSections >= 2) { severity = 'P2'; action = 'consolidate'; reasons.push(`append pile (sections=${updateSections}) → consolidate`) }
  else if (appendRatio > 0.30 || gapCount >= Math.max(6, Math.round(oldVec.size * 0.05))) { severity = 'P2'; action = 'rewrite'; reasons.push(`accumulation (appendRatio=${appendRatio.toFixed(2)}, gap=${gapCount}, thr=${Math.max(6, Math.round(oldVec.size * 0.05))})`) }
  else if (dupRisk >= 0.5) { severity = 'P2'; action = 'rewrite'; reasons.push(`duplication risk ${dupRisk.toFixed(2)}`) }
  else if (gapCount === 0) { severity = 'P4'; action = 'none'; reasons.push('fully covered') }
  else reasons.push('incremental append')
  if (degraded) reasons.push(`degraded: jev unavailable (${degraded})`)

  return { severity, action, reasons, degraded: !!degraded, contradictions, supersedes, retraction: +retraction.toFixed(2), lede: +lede.toFixed(2), split: +split.toFixed(2), gapCount, appendRatio: +appendRatio.toFixed(2), updateSections, dupRisk: +dupRisk.toFixed(2) }
}
