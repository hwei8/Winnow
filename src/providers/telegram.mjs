// providers/telegram.mjs — Telegram 投递
//
// 配置：TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 环境变量；或 TELEGRAM_CONFIG 指向的 JSON，
// 默认 .secrets/telegram.json（{ "bot_token": "...", "chat_id": "..." }）。
//
// 格式：默认按纯文本发送（不设 parse_mode）。简报里的标题与 LLM 文案可能含 & < >，
// 用 HTML 模式发送会被 Telegram 拒绝（can't parse entities），也会让抓来的文本注入链接。
// 确需 HTML 时传 parseMode: 'HTML'，并自行用 escapeHtml() 处理不可信片段。
import { readFileSync } from 'node:fs'
import { env, secretPath } from '../shared/config.mjs'

export function telegramConfig () {
  const token = env('TELEGRAM_BOT_TOKEN')
  const chatId = env('TELEGRAM_CHAT_ID')
  if (token && chatId) return { bot_token: token.trim(), chat_id: chatId.trim() }
  const file = env('TELEGRAM_CONFIG') || secretPath('telegram.json')
  let cfg
  try { cfg = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    throw new Error(`telegram not configured: set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID or create ${file}`)
  }
  if (!cfg.bot_token || !cfg.chat_id) throw new Error('telegram config missing bot_token/chat_id')
  return cfg
}

const MAX = 3500 // Telegram 上限 4096，留余量

export function escapeHtml (s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 按行切块；单行超过上限时硬切，保证每块都不超过 max。 */
export function chunkText (text, max = MAX) {
  const out = []
  let cur = ''
  for (const raw of String(text).split('\n')) {
    const pieces = []
    for (let i = 0; i < raw.length || i === 0; i += max) pieces.push(raw.slice(i, i + max))
    for (const line of pieces) {
      if (cur && (cur + '\n' + line).length > max) { out.push(cur); cur = line } else cur = cur ? cur + '\n' + line : line
    }
  }
  if (cur) out.push(cur)
  return out
}

export async function sendMessage (text, { chatId = null, parseMode = null } = {}) {
  const cfg = telegramConfig()
  const target = chatId || cfg.chat_id
  const results = []
  for (const chunk of chunkText(text)) {
    const payload = { chat_id: target, text: chunk, disable_web_page_preview: true }
    if (parseMode) payload.parse_mode = parseMode
    const res = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    })
    const d = await res.json()
    if (!d.ok) throw new Error(`telegram error: ${JSON.stringify(d).slice(0, 200)}`)
    results.push({ message_id: d.result.message_id, chars: chunk.length })
  }
  return { ok: true, chunks: results.length, target, results }
}

// 简报 Markdown → Telegram 友好的纯文本（去掉 #、保留列表）
export function toPlainText (markdown) {
  return String(markdown)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
