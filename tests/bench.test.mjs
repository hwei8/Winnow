// tests/bench.test.mjs — 指标是报告的地基：混淆矩阵、Wilson、分箱、阈值选择
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confusion, wilson, hardNegativeFpr, reliability, ece, grid, pickThreshold, sweep } from '../src/domains/bench/metrics.mjs'

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

test('confusion: 基本四格与派生指标', () => {
  const rows = [
    { label: 'same', score: 0.9 },
    { label: 'same', score: 0.65 },
    { label: 'diff', score: 0.8 },
    { label: 'diff', score: 0.3 }
  ]
  const c = confusion(rows, 0.7)
  assert.deepEqual([c.tp, c.fp, c.fn, c.tn], [1, 1, 1, 1])
  assert.ok(near(c.precision, 0.5))
  assert.ok(near(c.recall, 0.5))
  assert.ok(near(c.f1, 0.5))
  assert.ok(near(c.fpr, 0.5))
})

test('wilson: 小样本区间比点估计宽，且夹在 0..1', () => {
  const ci = wilson(7, 10)
  assert.ok(ci.lower < 0.7 && ci.upper > 0.7)
  assert.ok(ci.lower >= 0 && ci.upper <= 1)
  const edge = wilson(0, 5)
  assert.equal(edge.lower, 0)
  assert.ok(edge.upper > 0)
})

test('hardNegativeFpr: 只统计标了 hard 的负例', () => {
  const rows = [
    { label: 'diff', hard: true, score: 0.9 },
    { label: 'diff', hard: true, score: 0.1 },
    { label: 'diff', hard: false, score: 0.95 },
    { label: 'same', score: 0.95 }
  ]
  const r = hardNegativeFpr(rows, 0.7)
  assert.equal(r.n, 2)
  assert.equal(r.fp, 1)
  assert.ok(near(r.fpr, 0.5))
  assert.ok(r.lower < 0.5)
})

test('reliability + ece: 分箱对齐、ECE 为加权平均偏差', () => {
  const rows = [
    { label: 'same', score: 0.05 },
    { label: 'diff', score: 0.05 },
    { label: 'same', score: 0.95 },
    { label: 'same', score: 0.95 }
  ]
  const bins = reliability(rows, 10)
  assert.equal(bins.length, 10)
  const first = bins[0]
  assert.equal(first.n, 2)
  assert.ok(near(first.observed, 0.5))
  const last = bins[9]
  assert.equal(last.n, 2)
  assert.ok(near(last.observed, 1))
  // bin0: |0.5-0.05|=0.45 权重 0.5；bin9: |1-0.95|=0.05 权重 0.5 → ECE 0.25
  assert.ok(Math.abs(ece(bins) - 0.25) < 1e-9)
})

test('grid: 含端点且步长稳定', () => {
  assert.deepEqual(grid(0.2, 0.5, 0.1), [0.2, 0.3, 0.4, 0.5])
})

test('pickThreshold: 无解时返回 null，有解时取 recall 最高', () => {
  const impossible = [{ label: 'same', score: 0.9 }, { label: 'diff', hard: true, score: 0.9 }]
  assert.equal(pickThreshold(impossible, grid(0.2, 0.95, 0.05), { minPrecision: 0.99 }), null)

  const rows = [
    { label: 'same', score: 0.9 },
    { label: 'same', score: 0.86 },
    { label: 'same', score: 0.4 },
    { label: 'diff', hard: true, score: 0.42 }
  ]
  const pick = pickThreshold(rows, grid(0.2, 0.95, 0.05), { minPrecision: 0.9, maxHardFpr: 0.15 })
  assert.ok(pick)
  assert.ok(pick.precision >= 0.9)
  assert.ok(pick.recall >= 0.6)
})

test('sweep: 每行都是独立算的，不是累计', () => {
  const rows = [{ label: 'same', score: 0.9 }, { label: 'diff', score: 0.5 }]
  const out = sweep(rows, [0.4, 0.8])
  assert.equal(out[0].tp, 1)
  assert.equal(out[0].fp, 1)
  assert.equal(out[1].tp, 1)
  assert.equal(out[1].fp, 0)
})
