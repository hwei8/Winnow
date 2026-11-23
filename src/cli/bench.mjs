// bench.mjs — 给标注集打分、扫阈值、出报告（并可选写回 thresholds.json）
//
// 关键点：打分的代码路径与线上完全一致（knowledge/score.mjs）。
// 报告里的每一行都能被复现：同一份 jsonl + 同一个 seed → 同样的数字。
//
// 用法
//   node src/cli/bench.mjs --task=link                 # 打分 + 报告（结果缓存进 jsonl）
//   node src/cli/bench.mjs --task=link --rescore       # 忽略缓存重打
//   node src/cli/bench.mjs --task=link --promote=final # 把推荐阈值写进 config/thresholds.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { BENCH_DIR, CONFIG_DIR } from '../shared/config.mjs'
import { embedBatch } from '../providers/embed.mjs'
import { scorePair, applyAffinityOverride } from '../domains/knowledge/score.mjs'
import { runPool } from '../shared/pool.mjs'
import { sweep, grid, reliability, ece, pickThreshold, confusion, hardNegativeFpr } from '../domains/bench/metrics.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const s = a.replace(/^--/, '')
  const i = s.indexOf('=')
  return i < 0 ? [s, '1'] : [s.slice(0, i), s.slice(i + 1)]
}))
const TASK = args.task || 'link'
const FILE = args.file || path.join(BENCH_DIR, `${TASK}.v1.jsonl`)
if (!existsSync(FILE)) {
  console.error(`no dataset: ${FILE}`)
  process.exit(2)
}

const rows = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const todo = args.rescore ? rows : rows.filter((r) => !r.scores)
if (todo.length) {
  console.log(`打分 ${todo.length} 条…`)
  // 先把所有要 embed 的文本去重，一次性算完；事实向量按 id 复用
  const texts = new Set()
  for (const r of todo) {
    texts.add(`${r.a.title}\n${String(r.a.text).slice(0, 1800)}`)
    texts.add(`${r.b.title}\n${String(r.b.text).slice(0, 1800)}`)
  }
  const uniq = [...texts]
  const vecs = await embedBatch(uniq)
  const vecOf = new Map(uniq.map((t, i) => [t, vecs[i]]))

  // 打分需要的事实向量：fact id → canonical_text（从库里取，缺的现算）
  const { openDb } = await import('../shared/db.mjs')
  const db = openDb()
  const factIds = [...new Set(todo.flatMap((r) => [...(r.factsA || []), ...(r.factsB || [])]))]
  const factRows = factIds.length
    ? db.prepare(`SELECT id, canonical_text FROM fact WHERE id IN (${factIds.map(() => '?').join(',')})`).all(...factIds)
    : []
  const fvecs = await embedBatch(factRows.map((f) => f.canonical_text))
  const fvec = new Map(factRows.map((f, i) => [f.id, fvecs[i]]))
  db.close()

  const tasks = todo.map((r) => async () => {
    const keyA = `${r.a.title}\n${String(r.a.text).slice(0, 1800)}`
    const keyB = `${r.b.title}\n${String(r.b.text).slice(0, 1800)}`
    const sc = await scorePair({
      a: { title: r.a.title, body: r.a.text },
      b: { title: r.b.title, body: r.b.text },
      vecA: vecOf.get(keyA),
      vecB: vecOf.get(keyB),
      factsA: (r.factsA || []).map((id) => ({ id, vec: fvec.get(id) })),
      factsB: (r.factsB || []).map((id) => ({ id, vec: fvec.get(id) }))
    })
    const final = applyAffinityOverride({ ...sc, cos: sc.cos })
    return { ...sc, final }
  })
  const { results, ms } = await runPool(tasks, { concurrency: Number(args.concurrency || 6), label: 'bench' })
  results.forEach((res, i) => {
    const r = todo[i]
    if (!res.ok) { r.scores = { error: res.error }; return }
    r.scores = {
      same_event: res.value.same_event,
      final: res.value.final,
      cos: res.value.cos,
      fact_affinity: res.value.fact_affinity,
      affinity_ratio: res.value.affinity_ratio,
      gap: res.value.gap.length,
      factsB: res.value.facts
    }
  })
  // 只把 scores 合并回文件：标注可能正在另一个终端里进行，不能拿开局时的快照覆盖标签
  const fresh = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byId = new Map(fresh.map((r) => [r.id, r]))
  for (const r of todo) {
    const f = byId.get(r.id)
    if (f) f.scores = r.scores
  }
  writeFileSync(FILE, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`打分完成 ${(ms / 1000).toFixed(0)}s`)
}

// ---------- 评估 ----------
const labelled = rows.filter((r) => (r.label === 'same' || r.label === 'diff') && r.scores && !r.scores.error)
const unsure = rows.filter((r) => r.label === 'unsure').length
const unlabelled = rows.filter((r) => !r.label).length
if (!labelled.length) {
  console.log(JSON.stringify({ file: FILE, rows: rows.length, labelled: 0, unlabelled, unsure }, null, 1))
  process.exit(0)
}
const pos = labelled.filter((r) => r.label === 'same').length
const hard = labelled.filter((r) => r.label === 'diff' && r.hard).length
const thr = grid(0.2, 0.95, 0.05)

function tableFor (key) {
  const data = labelled.map((r) => ({ label: r.label, hard: !!r.hard, score: r.scores[key] ?? 0 }))
  return { data, rows: sweep(data, thr) }
}
const rawT = tableFor('same_event')
const finalT = tableFor('final')

const fmt = (t) => `| ≥${t.threshold.toFixed(2)} | ${t.tp} | ${t.fp} | ${t.fn} | ${t.precision.toFixed(3)} | ${t.recall.toFixed(3)} | ${t.f1.toFixed(3)} | ${t.hard.fpr === null ? '—' : t.hard.fpr.toFixed(3)} |`
const table = (rowsIn) => ['| 阈值 | TP | FP | FN | P | R | F1 | 硬负FPR |', '|---|---|---|---|---|---|---|---|', ...rowsIn.map(fmt)].join('\n')

const relRaw = reliability(rawT.data, 10)
const relFinal = reliability(finalT.data, 10)
const recRaw = pickThreshold(rawT.data, thr, { minPrecision: 0.9, maxHardFpr: 0.15 })
const recFinal = pickThreshold(finalT.data, thr, { minPrecision: 0.9, maxHardFpr: 0.15 })

// 线上现状：链接判定用 same_event ≥ 0.7
const prod = confusion(rawT.data, 0.7)
const prodHard = hardNegativeFpr(rawT.data, 0.7)

const lines = []
lines.push(`# bench · ${TASK}`, '')
lines.push(`- 数据集：\`${path.relative(process.cwd(), FILE)}\`（${rows.length} 条，已标 ${labelled.length}｜正例 ${pos}｜负例 ${labelled.length - pos}｜硬负 ${hard}｜说不清 ${unsure}｜未标 ${unlabelled}）`)
lines.push(`- 打分：\`knowledge/score.mjs\`（与线上同一条代码路径），判定器 \`${process.env.JEV_PROVIDER || 'openrouter'}\``)
lines.push(`- 生成时间：${new Date().toISOString()}`, '')
lines.push('## 线上现状（same_event ≥ 0.70）', '')
lines.push(`P ${prod.precision.toFixed(3)} / R ${prod.recall.toFixed(3)} / F1 ${prod.f1.toFixed(3)}；硬负误报 ${prodHard.fp}/${prodHard.n} = ${(prodHard.fpr ?? 0).toFixed(3)}（95% CI ${(prodHard.lower ?? 0).toFixed(2)}–${(prodHard.upper ?? 0).toFixed(2)}）`, '')
lines.push('## 原始分数（same_event）', '', table(rawT.rows), '')
lines.push('## 亲和度补强后（final）', '', table(finalT.rows), '')
lines.push('## 可靠性（原始分数是不是概率）', '', `ECE = ${ece(relRaw)}`, '', '| 分箱 | n | 平均预测 | 实际正例率 |', '|---|---|---|---|', ...relRaw.map((b) => `| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${b.predicted ?? '—'} | ${b.observed ?? '—'} |`), '')
lines.push('## 推荐阈值', '')
lines.push(recRaw ? `- 原始分数：**${recRaw.threshold}**（P ${recRaw.precision.toFixed(3)} / R ${recRaw.recall.toFixed(3)} / F1 ${recRaw.f1.toFixed(3)} / 硬负FPR ${recRaw.hard.fpr === null ? '—' : recRaw.hard.fpr.toFixed(3)}）` : '- 原始分数：没有阈值同时满足 P≥0.90 与硬负FPR≤0.15')
lines.push(recFinal ? `- 补强后：**${recFinal.threshold}**（P ${recFinal.precision.toFixed(3)} / R ${recFinal.recall.toFixed(3)} / F1 ${recFinal.f1.toFixed(3)} / 硬负FPR ${recFinal.hard.fpr === null ? '—' : recFinal.hard.fpr.toFixed(3)}）` : '- 补强后：没有阈值同时满足 P≥0.90 与硬负FPR≤0.15')
lines.push('', '> 约束：precision ≥ 0.90（宁可漏并，不可错并）与硬负 FPR ≤ 0.15，取 recall 最高者。')

const reportPath = path.join(BENCH_DIR, `report-${TASK}-${new Date().toISOString().slice(0, 10)}.md`)
mkdirSync(BENCH_DIR, { recursive: true })
writeFileSync(reportPath, lines.join('\n') + '\n')
console.log(lines.slice(0, 12).join('\n'))
console.log(`\n报告：${reportPath}`)

if (args.promote) {
  const pickFinal = args.promote === 'final'
  const rec = pickFinal ? recFinal : recRaw
  const p = path.join(CONFIG_DIR, 'thresholds.json')
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  cfg.link = cfg.link || {}
  cfg.link = {
    ...cfg.link,
    [`${pickFinal ? 'final' : 'same_event'}_min`]: rec ? rec.threshold : null,
    provenance: {
      task: TASK,
      dataset: path.relative(process.cwd(), FILE),
      labelled: labelled.length,
      positives: pos,
      hard_negatives: hard,
      report: path.relative(process.cwd(), reportPath),
      chosen: rec ? { threshold: rec.threshold, precision: rec.precision, recall: rec.recall, f1: rec.f1, hard_fpr: rec.hard.fpr } : null,
      at: new Date().toISOString()
    }
  }
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n')
  console.log(`已写入 ${p}`)
}
