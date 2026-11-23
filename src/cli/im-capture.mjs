// cli/im-capture.mjs — 用 Telegram 直接记一条想法（P0 尾巴）
//
//   node im_capture.mjs --once          # 拉一次新消息
//   node im_capture.mjs --loop          # 每 15s 轮询（后台运行）
//   node im_capture.mjs --test "记 明天确认 bge-m3 本地延迟"   # 本地模拟（不调 Telegram）
//
// 规则：以「记」「记：」「capture 」开头 → 去前缀后存为 capture；其余消息忽略。
// 注意：DSH 自己的 Telegram 集成也在轮询 getUpdates，两个消费者会抢更新。
//       如遇 409 Conflict，请停用 DSH 集成或用独立 bot token。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { openDb, ROOT } from '../shared/db.mjs'
import { createCapture } from '../domains/memory/state.mjs'
import { sendMessage } from '../providers/telegram.mjs'

const CFG = JSON.parse(readFileSync(path.join(ROOT, '.secrets', 'telegram.json'), 'utf8'))
const STATE_FILE = path.join(ROOT, '.secrets', 'telegram-offset.json')
const PREFIXES = [/^记[:：\s]+/, /^记忆[:：\s]+/, /^capture\s+/i, /^c\s+/i]
const CHAT_ALLOW = new Set([String(CFG.chat_id)])

function loadState () {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { offset: 0 } }
}
function saveState (s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }

function parseCapture (text) {
  const raw = String(text || '').trim()
  for (const p of PREFIXES) {
    if (p.test(raw)) return raw.replace(p, '').trim()
  }
  return null
}

function handleMessage (msg, db) {
  const chatId = String(msg.chat?.id ?? '')
  if (!CHAT_ALLOW.has(chatId)) return { skipped: 'chat-not-allowed' }
  const content = parseCapture(msg.text)
  if (!content) return { skipped: 'no-prefix' }
  const row = createCapture(db, { kind: 'idea', content, intent: 'telegram', targetType: null, targetId: null })
  return { captured: row.id, content }
}

const db = openDb()

if (process.argv.includes('--test')) {
  const text = process.argv[process.argv.indexOf('--test') + 1] || '记 测试一条'
  const r = handleMessage({ chat: { id: CFG.chat_id }, text, from: { is_bot: false } }, db)
  console.log(JSON.stringify({ test: true, input: text, result: r }, null, 1))
  process.exit(0)
}

async function pollOnce () {
  const state = loadState()
  const url = `https://api.telegram.org/bot${CFG.bot_token}/getUpdates?offset=${state.offset}&timeout=10&allowed_updates=message`
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (res.status === 409) { console.error('[im_capture] 409 Conflict：DSH 集成或其他消费者在轮询，退出'); process.exit(2) }
  const d = await res.json()
  if (!d.ok) { console.error('[im_capture] getUpdates failed:', JSON.stringify(d).slice(0, 200)); return 0 }
  let n = 0
  for (const u of d.result || []) {
    state.offset = Math.max(state.offset, u.update_id + 1)
    const msg = u.message
    if (!msg || msg.from?.is_bot) continue
    const r = handleMessage(msg, db)
    if (r.captured) {
      n++
      await sendMessage(`✅ 已记录：${r.content.slice(0, 80)}`, { chatId: String(msg.chat.id) }).catch(() => {})
    }
  }
  saveState(state)
  return n
}

if (process.argv.includes('--loop')) {
  console.log('[im_capture] loop started')
  for (;;) {
    try { const n = await pollOnce(); if (n) console.log('[im_capture] captured', n) } catch (e) { console.error('[im_capture]', String(e.message).slice(0, 120)) }
    await new Promise(r => setTimeout(r, 15000))
  }
} else {
  const n = await pollOnce()
  console.log(JSON.stringify({ captured: n, offset: loadState().offset }))
}
db.close()
