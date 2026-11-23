// tests/score.test.mjs — 打分原语：判定器可注入，余弦只补强不冒充概率
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scorePair, applyAffinityOverride } from '../src/domains/knowledge/score.mjs'
import { th, provenanceOf } from '../src/shared/thresholds.mjs'

const vec = (...xs) => {
  const v = new Float32Array(4)
  xs.forEach((x, i) => { v[i] = x })
  return v
}
const norm = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / n)
}

test('scorePair: 判定器给出分数就记 judged', async () => {
  const judge = async () => ({ answers: { q: { noul: 0.92 } } })
  const a = norm([1, 0, 0, 0])
  const b = norm([1, 0, 0, 0])
  const r = await scorePair({
    a: { title: 'A', body: 'x' },
    b: { title: 'B', body: 'y' },
    vecA: a,
    vecB: b,
    factsA: [{ id: 'F1', vec: norm([1, 0, 0, 0]) }],
    factsB: [{ id: 'F1', vec: norm([1, 0, 0, 0]) }],
    judge
  })
  assert.equal(r.judged, true)
  assert.equal(r.same_event, 0.92)
  assert.equal(r.cos, 1)
  assert.equal(r.gap.length, 0)
  assert.equal(r.fact_affinity, 1)
})

test('scorePair: 判定器抛错时 judged=false，不拿余弦冒充', async () => {
  const judge = async () => { throw new Error('dead') }
  const r = await scorePair({
    a: { title: 'A', body: '' },
    b: { title: 'B', body: '' },
    vecA: vec(1, 0, 0, 0),
    vecB: vec(1, 0, 0, 0),
    judge
  })
  assert.equal(r.judged, false)
  assert.equal(r.same_event, null)
  assert.equal(applyAffinityOverride({ ...r, cos: r.cos }), null)
})

test('scorePair: 缺口按余弦阈值算，低于阈值才进 gap', async () => {
  const r = await scorePair({
    a: { title: 'A' },
    b: { title: 'B' },
    factsA: [{ id: 'F1', vec: norm([1, 0, 0, 0]) }, { id: 'F2', vec: norm([0, 1, 0, 0]) }],
    factsB: [{ id: 'F1', vec: norm([1, 0, 0, 0]) }],
    judge: async () => ({ answers: { q: { noul: 0.7 } } })
  })
  assert.deepEqual(r.gap.map((g) => g.id), ['F2'])
  assert.ok(r.fact_affinity < 0.6)
})

test('applyAffinityOverride: 事实高度重合且余弦 ≥0.5 抬到 0.8，否则保留原值', () => {
  const base = { same_event: 0.3, judged: true, fact_affinity: 0.8, affinity_ratio: 0.1, cos: 0.6 }
  assert.equal(applyAffinityOverride(base), 0.8)
  assert.equal(applyAffinityOverride({ ...base, cos: 0.3 }), 0.3)
  assert.equal(applyAffinityOverride({ ...base, fact_affinity: 0.1, affinity_ratio: 0.0 }), 0.3)
  assert.equal(applyAffinityOverride({ ...base, judged: false }), null)
})

test('thresholds: 缺字段回落默认值，不抛错', () => {
  // 已标定的键读文件里的值（0.70 → 0.60 是 bench 定的），未标定的键回落传入默认值
  assert.equal(typeof th('link.same_event_min', 0.7), 'number')
  assert.equal(th('no.such.key', 42), 42)
  assert.ok(['calibrated', 'uncalibrated'].includes(provenanceOf('link').state))
  assert.equal(provenanceOf('no.such.group').state, 'unknown')
})
