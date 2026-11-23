// shared/thresholds.mjs — 阈值集中在一处：config/thresholds.json
//
// 为什么不是常量：阈值原来散在 4 个模块里，改一个数字要翻 5 个文件，而且没人知道
// 某个数字是哪来的。这里统一读取，每条阈值在 json 里都带 provenance（数据集/样本量/时间）。
// 文件缺失或字段缺失时回落到代码里的默认值——阈值不该成为启动依赖。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from './config.mjs'

let cache = null

export function allThresholds () {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'thresholds.json'), 'utf8'))
  } catch {
    cache = {}
  }
  return cache
}

/** 读一个阈值：th('link.same_event_min', 0.7)。数字以外的结构也能读。 */
export function th (key, fallback) {
  const parts = key.split('.')
  let cur = allThresholds()
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return fallback
    cur = cur[p]
  }
  return cur === null || cur === undefined ? fallback : cur
}

/** 测试用：改完 json 后丢缓存（也用于 bench --promote 后立即生效）。 */
export function resetThresholds () { cache = null }

/** 给报告用的 provenance 摘要：state 是 calibrated 还是 uncalibrated。 */
export function provenanceOf (group) {
  return allThresholds()?.[group]?.provenance || { state: 'unknown' }
}
