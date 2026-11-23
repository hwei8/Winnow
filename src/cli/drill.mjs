// cli/drill.mjs — 降级演练：模拟依赖中断，验证 fallback 是否生效
//   node drill.mjs            # 全部场景
//   node drill.mjs --scenario=embed|jev|telegram
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const scenario = (() => { const h = process.argv.find(a => a.startsWith('--scenario=')); return h ? h.split('=')[1] : 'all' })()
const results = []

function run (name, script, env) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: HERE, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 })
  return { name, ok: r.status === 0, ms: Date.now() - t0, out: (r.stdout || '').trim().slice(0, 300), err: (r.stderr || '').trim().slice(0, 300) }
}

if (scenario === 'all' || scenario === 'embed') {
  results.push(run('embed-openrouter', `
    const m = await import('../providers/embed.mjs');
    const v = await m.embedBatch(['降级演练测试文本']);
    console.log('provider=' + m.embedInfo().provider + ' dims=' + v[0].length);
  `, {}))
  results.push(run('embed-local-fallback', `
    const m = await import('../providers/embed.mjs');
    const v = await m.embedBatch(['降级演练测试文本']);
    console.log('fallback dims=' + v[0].length);
  `, { EMBED_PROVIDER: 'local', EMBED_BASE_URL: 'http://127.0.0.1:1/v1/embeddings' }))
}
if (scenario === 'all' || scenario === 'jev') {
  results.push(run('jev-fallback', `
    const m = await import('../providers/jev.mjs');
    const r = await m.noulBatch({ items: ['A 发布新芯片', 'A 推出新处理器'] }, ['同一事件？']);
    console.log('provider=' + (r.model || 'unknown') + ' noul=' + JSON.stringify(r.probabilities));
  `, { JEV_ZEN_URL: 'http://127.0.0.1:1/systemone' }))
}
if (scenario === 'all' || scenario === 'telegram') {
  results.push(run('telegram-failure-handled', `
    const m = await import('../providers/telegram.mjs');
    try { await m.sendMessage('drill'); console.log('unexpected-success'); process.exit(3) }
    catch (e) { console.log('handled: ' + String(e.message).slice(0, 60)) }
  `, { TELEGRAM_BOT_TOKEN: 'invalid', TELEGRAM_CHAT_ID: '1' }))
}
console.log(JSON.stringify(results, null, 1))
if (results.some(r => !r.ok)) process.exitCode = 1
