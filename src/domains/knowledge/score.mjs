// knowledge/score.mjs — 一对文本「是不是同一件事」的打分原语（运行时与 bench 共用）
//
// 为什么单独一个模块：链接判定以前只有 linkIncoming 一条实现，bench 只能另写一份，
// 两份逻辑迟早分叉，量出来的就不是线上跑的东西。这里把"算分"抽出来，
// linkIncoming 与 `src/cli/bench.mjs` 调的是同一段代码。
//
// 约定
//   * 余弦只用来召回与补强，不冒充概率；判定器不可用时 same_event 为 null。
//   * 事实缺口按"事实身份"（同一 fact id）判，不再用余弦 <0.85 近似。
import { decide } from '../../providers/jev.mjs'
import { th } from '../../shared/thresholds.mjs'

/** 生产用的问句。改问句等于改指标，bench 会一起量到。 */
export const SAME_EVENT_QUESTION = {
  type: 'noul',
  instructions: 'Story A and Story B report the same specific event/topic.',
  criteria: {
    true: 'Same subject and same specific event/topic.',
    false: 'Different events or unrelated topics.'
  }
}

export const GAP_COS = 0.85 // 事实缺口默认值；以 config/thresholds.json 的 facts.gap_cos 为准

export const cos = (a, b) => {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/**
 * 给一对文本打分。
 * @param {object} p
 * @param {{title?:string, body?:string}} p.a 入站侧
 * @param {{title?:string, body?:string}} p.b 已有侧
 * @param {Float32Array} p.vecA 入站侧向量（不传则不算余弦）
 * @param {Float32Array} p.vecB 已有侧向量
 * @param {Array<{id:string, vec?:Float32Array}>} p.factsA 入站事实
 * @param {Array<{id:string, vec?:Float32Array}>} p.factsB 已有侧事实
 * @param {(id:string)=>Float32Array|undefined} [p.factVec] 按 id 取向量（缺省用 factsB 自带的）
 * @param {(args:any)=>Promise<any>} [p.judge] 判定器（测试可注入）
 * @param {number} [p.gapTh] 缺口余弦阈值
 * @returns {Promise<{cos:number|null, same_event:number|null, judged:boolean, fact_affinity:number, affinity_ratio:number, gap:Array<{id:string,best:number}>, facts:number}>}
 */
export async function scorePair ({
  a, b, vecA, vecB, factsA = [], factsB = [], factVec, judge = decide, gapTh = th('facts.gap_cos', GAP_COS)
}) {
  const c = vecA && vecB ? cos(vecA, vecB) : null

  const vecOf = factVec || ((id) => factsB.find((f) => f.id === id)?.vec)
  const gap = []
  const bests = []
  for (const f of factsA) {
    let best = 0
    if (f.vec) {
      for (const pf of factsB) {
        const pv = pf.vec || vecOf(pf.id)
        if (!pv) continue
        const s = cos(f.vec, pv)
        if (s > best) best = s
      }
    }
    bests.push(best)
    if (best < gapTh) gap.push({ id: f.id, best: +best.toFixed(2) })
  }
  const factAffinity = bests.length ? bests.reduce((x, y) => x + y, 0) / bests.length : 0
  const affinityRatio = bests.length ? bests.filter((x) => x >= 0.75).length / bests.length : 0

  let same = null
  try {
    const r = await judge({
      state: {
        a: { title: a?.title || '', body: String(a?.body || '').slice(0, 1500) },
        b: { title: b?.title || '', body: String(b?.body || '').slice(0, 1500) }
      },
      questions: { q: SAME_EVENT_QUESTION }
    })
    same = r?.answers?.q?.noul ?? null
  } catch (e) {
    console.error('[score] judge failed:', String(e?.message || e).slice(0, 80))
  }

  return {
    cos: c === null ? null : +c.toFixed(3),
    same_event: same === null ? null : +same.toFixed(3),
    judged: same !== null,
    fact_affinity: +factAffinity.toFixed(3),
    affinity_ratio: +affinityRatio.toFixed(2),
    gap,
    facts: factsB.length
  }
}

/**
 * 亲和度补强：正文 embedding 对短文会失真，事实层面高度重合时把同一事件概率抬到 0.8。
 * 只在判定器给出结果时生效——没有判定结果就延期，不拿余弦冒充。
 */
export function applyAffinityOverride ({ same_event, judged, fact_affinity, affinity_ratio, cos }) {
  if (!judged || same_event === null) return null
  if ((fact_affinity >= th('link.affinity_min', 0.72) || affinity_ratio >= th('link.affinity_ratio_min', 0.4)) && (cos ?? 1) >= 0.5) return Math.max(same_event, 0.8)
  return same_event
}
