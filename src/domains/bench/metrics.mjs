// bench/metrics.mjs — 纯函数：混淆矩阵、Wilson 区间、阈值扫描、可靠性分箱
//
// 为什么单独抽出来：这些数字后面要进 docs 与 thresholds.json 的 provenance，
// 必须能被单测钉住，而不是散在 CLI 里 print。

/** 二分类混淆矩阵。score 是"判为同一事件"的分数，≥ threshold 判 positive。 */
export function confusion (rows, threshold) {
  let tp = 0; let fp = 0; let tn = 0; let fn = 0
  for (const r of rows) {
    const pred = r.score >= threshold
    const actual = r.label === 'same'
    if (pred && actual) tp++
    else if (pred && !actual) fp++
    else if (!pred && actual) fn++
    else tn++
  }
  const precision = tp + fp ? tp / (tp + fp) : 0
  const recall = tp + fn ? tp / (tp + fn) : 0
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  const fpr = fp + tn ? fp / (fp + tn) : 0
  return { tp, fp, tn, fn, precision, recall, f1, fpr, n: rows.length }
}

/** 硬负样本误报率：只统计标了 hard 的负例。 */
export function hardNegativeFpr (rows, threshold) {
  const hard = rows.filter((r) => r.label === 'diff' && r.hard)
  if (!hard.length) return { n: 0, fp: 0, fpr: null, lower: null, upper: null }
  const fp = hard.filter((r) => r.score >= threshold).length
  const ci = wilson(fp, hard.length)
  return { n: hard.length, fp, fpr: fp / hard.length, lower: ci.lower, upper: ci.upper }
}

/** Wilson 分数区间（比例的小样本置信区间，比正态近似稳）。 */
export function wilson (k, n, z = 1.96) {
  if (!n) return { p: 0, lower: 0, upper: 0 }
  const p = k / n
  const denom = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return {
    p,
    lower: Math.max(0, (centre - spread) / denom),
    upper: Math.min(1, (centre + spread) / denom)
  }
}

/** 阈值扫描。row 里只有 label / score 时也能跑。 */
export function sweep (rows, thresholds) {
  return thresholds.map((t) => {
    const c = confusion(rows, t)
    const hard = hardNegativeFpr(rows, t)
    return { threshold: t, ...c, hard }
  })
}

/** 均匀阈值序列：min..max 步长 step（含端点）。 */
export function grid (min, max, step) {
  const out = []
  for (let v = min; v <= max + 1e-9; v += step) out.push(+v.toFixed(2))
  return out
}

/**
 * 可靠性曲线：把预测值分箱，看"说 0.8 的样本里真正有多少是同一事件"。
 * 判定器是不是概率，就看这张表——对角线以上/以下都说明分数不是概率。
 */
export function reliability (rows, bins = 10) {
  const out = []
  for (let i = 0; i < bins; i++) {
    const lo = i / bins
    const hi = (i + 1) / bins
    const bucket = rows.filter((r) => r.score >= lo && (i === bins - 1 ? r.score <= hi : r.score < hi))
    if (!bucket.length) { out.push({ lo, hi, n: 0, predicted: null, observed: null }); continue }
    out.push({
      lo,
      hi,
      n: bucket.length,
      predicted: +(bucket.reduce((s, r) => s + r.score, 0) / bucket.length).toFixed(3),
      observed: +(bucket.filter((r) => r.label === 'same').length / bucket.length).toFixed(3)
    })
  }
  return out
}

/** Calibration error（ECE，按样本数加权）—— 一个数字描述"分数离概率有多远"。 */
export function ece (bins) {
  const total = bins.reduce((s, b) => s + b.n, 0)
  if (!total) return null
  return +bins.reduce((s, b) => s + (b.n / total) * Math.abs((b.observed ?? 0) - (b.predicted ?? 0)), 0).toFixed(3)
}

/** 在给定约束下选阈值：precision 下限 + 硬负 FPR 上限，取 recall 最高者。 */
export function pickThreshold (rows, thresholds, { minPrecision = 0.9, maxHardFpr = 0.15 } = {}) {
  const rowsOut = sweep(rows, thresholds)
  const ok = rowsOut.filter((r) => r.precision >= minPrecision && (r.hard.fpr === null || r.hard.fpr <= maxHardFpr))
  if (!ok.length) return null
  return ok.sort((a, b) => b.recall - a.recall || b.f1 - a.f1)[0]
}
