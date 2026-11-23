// shared/pool.mjs — 全局并发池（限流 + 429 感知），默认并发 10（opencode 单账号上限）
export async function runPool (tasks, { concurrency = Number(process.env.EXTRACT_CONCURRENCY || 10), label = 'pool' } = {}) {
  const results = new Array(tasks.length)
  let next = 0, done = 0
  const started = Date.now()
  async function worker (wid) {
    while (true) {
      const i = next++
      if (i >= tasks.length) return
      try { results[i] = { ok: true, value: await tasks[i]() } } catch (e) { results[i] = { ok: false, error: e.message } }
      done++
      if (done % 10 === 0) console.error(`  [${label}] ${done}/${tasks.length} ${((Date.now() - started) / 1000).toFixed(1)}s`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, (_, w) => worker(w)))
  return { results, ms: Date.now() - started, concurrency, throughputPerMin: +(tasks.length / ((Date.now() - started) / 60000)).toFixed(1) }
}
