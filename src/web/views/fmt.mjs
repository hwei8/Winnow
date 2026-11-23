// web/views/fmt.mjs —— 纯函数格式化工具
// 零依赖，浏览器（/fmt.mjs）与 Node（服务端）共用同一份实现，保证 SSR 与客户端渲染一致。

export const TZ = 'Asia/Shanghai'

const DATE_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
})
const DATETIME_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
})

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** HTML 转义；null/undefined → 空串 */
export function esc(v) {
  if (v === null || v === undefined) return ''
  return String(v).replace(/[&<>"']/g, (c) => ESC_MAP[c])
}

/** 数字或 null（避免把 NaN / undefined 塞进 JSON） */
export function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 时间戳归一化成 unix 秒。
 * 库里同一列可能同时存在 epoch 秒（整数）和 ISO 文本（抽取/聚类脚本写入方式不同），
 * 这里统一收口，避免排序和展示错乱。
 */
export function toTs(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (!s) return null
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 1000)
}

/** 秒 → mm:ss（超过 1 小时用 h:mm:ss）；无效值 → 空串 */
export function mmss(sec) {
  const s = num(sec)
  if (s === null) return ''
  const total = Math.max(0, Math.floor(s))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`
}

/** 时间段 → "0:12–0:35"，缺失一侧也能降级显示 */
export function timeRangeLabel(start, end) {
  const a = mmss(start)
  const b = mmss(end)
  if (!a && !b) return ''
  if (!a) return `–${b}`
  if (!b) return a
  if (a === b) return a
  return `${a}–${b}`
}

/** 视频时长（>=1h 也走 h:mm:ss） */
export function durationLabel(sec) {
  return mmss(sec)
}

const KIND_MAP = {
  fact: ['事实', 'k-fact'],
  number: ['数字', 'k-number'],
  opinion: ['观点', 'k-opinion'],
  decision: ['决策', 'k-decision'],
  quote: ['引述', 'k-quote'],
  prediction: ['预测', 'k-prediction']
}

/** claim kind → { label, cls }；未知 kind 归入 other */
export function kindMeta(kind) {
  const key = String(kind ?? '').toLowerCase()
  const hit = KIND_MAP[key]
  if (hit) return { label: hit[0], cls: hit[1] }
  return { label: kind ? String(kind) : '其他', cls: 'k-other' }
}

/** confidence → 0..100 的整数百分比；null → null */
export function confPct(confidence) {
  const c = num(confidence)
  if (c === null) return null
  return Math.round(Math.max(0, Math.min(1, c)) * 100)
}

/** confidence → "0.90" / "—" */
export function confLabel(confidence) {
  const c = num(confidence)
  return c === null ? '—' : c.toFixed(2)
}

/** story.status → 中文标签 */
export function statusLabel(status) {
  const s = String(status ?? '').toLowerCase()
  if (s === 'active') return '多源事件'
  if (s === 'single') return '单源'
  if (s === 'merged') return '已合并'
  if (s === 'split') return '已拆分'
  return status ? String(status) : '—'
}

/** entity.type → 中文标签 */
export function typeLabel(type) {
  const map = {
    uploader: 'UP主', concept: '概念', product: '产品', org: '组织',
    person: '人物', place: '地点', event: '事件', topic: '主题'
  }
  const t = String(type ?? '').toLowerCase()
  return map[t] ?? (type ? String(type) : '未知')
}

/** unix 秒 → "2026-05-05"（固定 Asia/Shanghai，避免时区漂移） */
export function dateLabel(ts) {
  const t = toTs(ts)
  if (t === null) return ''
  const d = new Date(t * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return DATE_FMT.format(d)
}

/** unix 秒 → "2026-05-05 14:30" */
export function dateTimeLabel(ts) {
  const t = toTs(ts)
  if (t === null) return ''
  const d = new Date(t * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return DATETIME_FMT.format(d)
}

/** unix 秒 → "3 天前" 这类相对时间 */
export function relLabel(ts, now = Date.now()) {
  const t = toTs(ts)
  if (t === null || t <= 0) return ''
  const diff = Math.round(now / 1000 - t)
  if (diff < 0) return '刚刚'
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  const days = Math.floor(diff / 86400)
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

/** 播放量 → "14.9 万" */
export function viewLabel(n) {
  const v = num(n)
  if (v === null) return ''
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`
  return String(v)
}

/** 大数字加千分位 */
export function countLabel(n) {
  const v = num(n)
  if (v === null) return '—'
  return v.toLocaleString('zh-CN')
}

/** 截断长文本（用于卡片） */
export function clip(text, max = 120) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

/** /api/frame 的 URL */
export function frameUrl(path) {
  if (!path) return null
  return `/api/frame?path=${encodeURIComponent(path)}`
}
