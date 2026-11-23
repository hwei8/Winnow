// providers/telegram.mjs — Telegram 投递（Claw bot）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from '../shared/db.mjs'

function config () {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { bot_token: process.env.TELEGRAM_BOT_TOKEN, chat_id: process.env.TELEGRAM_CHAT_ID }
  }
  const file = process.env.TELEGRAM_CONFIG || path.join(ROOT, '.secrets', 'telegram.json')
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  if (!cfg.bot_token || !cfg.chat_id) throw new Error('telegram config missing bot_token/chat_id')
  return cfg
}

const MAX = 3500

export function chunkText (text, max = MAX) {
  const out = []
  let cur = ''
  for (const line of String(text).split('\n')) {
    if ((cur + '\n' + line).length > max) { if (cur) out.push(cur); cur = line }
    else cur = cur ? cur + '\n' + line : line
  }
  if (cur) out.push(cur)
  return out
}

export async function sendMessage (text, { chatId = null, parseMode = 'HTML' } = {}) {
  const cfg = config()
  const target = chatId || cfg.chat_id
  const results = []
  for (const chunk of chunkText(text)) {
    const res = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text: chunk, parse_mode: parseMode, disable_web_page_preview: true }),
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
