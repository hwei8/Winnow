// web/public/app.js —— 交互增强层
//
// 页面首屏内容由服务端直接渲染（curl 可见），这里只负责：
//   * 全局搜索（/api/search）
//   * 记忆流无限滚动（/api/stream 分页追加，复用 templates.mjs 的卡片渲染）
//   * 事件页 claim 排序切换
//   * 证据截图大图、转写预览抽屉
//   * 卡片 topic 点击 → 直接搜索

import {
  streamCardsHtml, renderStoryClaims, searchResultsHtml, searchLoadingHtml, transcriptHtml
} from '/templates.mjs'

const bootEl = document.getElementById('boot')
let boot = {}
try {
  boot = JSON.parse(bootEl?.textContent || '{}')
} catch {
  boot = {}
}

const page = document.body.dataset.page || 'stream'

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// 证据缩略图加载失败就移除（替代模板里的内联 onerror：CSP 禁止内联脚本）
document.addEventListener('error', (e) => {
  const img = e.target
  if (img instanceof HTMLImageElement && img.closest('.thumb')) img.closest('.thumb').remove()
}, true)

/* ── 小工具 ─────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel)

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

let toastTimer = null
function toast(message, ms = 2600) {
  const el = $('#toast')
  if (!el) return
  el.textContent = message
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, ms)
}

/* ── 全局搜索 ──────────────────────────────────────────────── */

function setupSearch() {
  const form = $('#search-form')
  const input = $('#search-input')
  const panel = $('#search-panel')
  if (!form || !input || !panel) return

  let timer = null
  let seq = 0

  const close = () => { panel.hidden = true }

  async function run(q) {
    const query = String(q || '').trim()
    if (!query) { close(); return }
    const mine = ++seq
    panel.hidden = false
    panel.innerHTML = searchLoadingHtml(query)
    try {
      const data = await fetchJson(`/api/search?q=${encodeURIComponent(query)}&limit=30`)
      if (mine !== seq) return
      panel.innerHTML = searchResultsHtml(data)
    } catch {
      if (mine !== seq) return
      panel.innerHTML = `<div class="sp-head"><span>搜索失败</span><button class="sp-close" type="button">×</button></div>
        <p class="sp-empty">请求 /api/search 出错，请稍后再试。</p>`
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    run(input.value)
  })

  input.addEventListener('input', () => {
    clearTimeout(timer)
    const value = input.value
    timer = setTimeout(() => run(value), 320)
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur() }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault()
      input.focus()
      input.select()
    }
    if (e.key === 'Escape') {
      close()
      closeLightbox()
      closeDrawer()
    }
  })

  // 点击面板外关闭
  document.addEventListener('click', (e) => {
    if (panel.hidden) return
    if (panel.contains(e.target) || form.contains(e.target)) return
    close()
  })

  if (panel) {
    panel.addEventListener('click', (e) => {
      if (e.target.closest('.sp-close')) close()
    })
  }

  // 卡片/标签上的 data-q：点标签直接搜索
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]')
    if (!chip) return
    e.preventDefault()
    const q = chip.dataset.q || ''
    input.value = q
    input.focus()
    run(q)
  })

  // 支持 /?q=xxx 直接带搜索词打开
  const initial = new URLSearchParams(location.search).get('q')
  if (initial) {
    input.value = initial
    run(initial)
  }
}

/* ── 记忆流无限滚动 ────────────────────────────────────────── */

function setupStream() {
  const stream = $('#stream')
  const moreRow = $('#more-row')
  const moreBtn = $('#load-more')
  const moreHint = $('#more-hint')
  const sentinel = $('#stream-sentinel')
  const emptyEl = $('#stream-empty')
  if (!stream || !boot.stream) return

  const state = {
    offset: Array.isArray(boot.stream.stories) ? boot.stream.stories.length : 0,
    limit: boot.stream.limit || 20,
    sort: boot.stream.sort || 'recent',
    total: boot.stream.total || 0,
    hasMore: Boolean(boot.stream.has_more),
    loading: false
  }

  const syncFooter = (notify = false) => {
    if (!moreRow) return
    if (state.hasMore) {
      moreRow.hidden = false
      if (moreHint) moreHint.textContent = `已显示 ${state.offset} / ${state.total}`
    } else {
      moreRow.hidden = true
      if (moreHint) moreHint.textContent = ''
      if (notify && state.offset > 0) toast(`已加载全部 ${state.total} 个事件`)
    }
    if (emptyEl) emptyEl.hidden = state.offset > 0
  }

  async function loadMore() {
    if (state.loading || !state.hasMore) return
    state.loading = true
    if (moreHint) moreHint.textContent = '加载中…'
    try {
      const data = await fetchJson(
        `/api/stream?offset=${state.offset}&limit=${state.limit}&sort=${encodeURIComponent(state.sort)}`
      )
      const stories = Array.isArray(data.stories) ? data.stories : []
      if (stories.length) {
        stream.insertAdjacentHTML('beforeend', streamCardsHtml(stories))
        state.offset += stories.length
      }
      state.total = data.total ?? state.total
      state.hasMore = Boolean(data.has_more) && stories.length > 0
    } catch {
      toast('加载更多失败，请重试')
      state.hasMore = true
    } finally {
      state.loading = false
      syncFooter(true)
    }
  }

  state.hasMore = Boolean(boot.stream.has_more)
  syncFooter()

  moreBtn?.addEventListener('click', loadMore)

  if ('IntersectionObserver' in window && sentinel) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMore()
        }
      },
      { rootMargin: '600px 0px' }
    )
    io.observe(sentinel)
  }

  // sort 切换：优先原地切换（链接仍可用，无 JS 时走服务端 SSR）
  document.querySelectorAll('[data-sort]').forEach((link) => {
    link.addEventListener('click', async (e) => {
      const next = link.dataset.sort
      if (!next || next === state.sort) return
      e.preventDefault()
      state.sort = next
      state.offset = 0
      state.hasMore = true
      stream.innerHTML = ''
      document.querySelectorAll('[data-sort]').forEach((l) => l.classList.toggle('active', l === link))
      history.replaceState(null, '', `/?sort=${encodeURIComponent(next)}`)
      await loadMore()
    })
  })
}

/* ── 事件页：claim 排序切换 ────────────────────────────────── */

function setupClaimModes() {
  const root = $('#claims-root')
  if (!root || !boot.story) return
  document.querySelectorAll('[data-claim-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.claimMode === 'time' ? 'time' : 'item'
      document.querySelectorAll('[data-claim-mode]').forEach((b) => b.classList.toggle('active', b === btn))
      root.innerHTML = renderStoryClaims(boot.story, mode)
    })
  })
}

/* ── 证据大图 ──────────────────────────────────────────────── */

function openLightbox(url, caption) {
  const box = $('#lightbox')
  const img = $('#lb-img')
  const cap = $('#lb-cap')
  if (!box || !img) return
  img.src = url
  if (cap) cap.textContent = caption || ''
  box.hidden = false
  document.body.style.overflow = 'hidden'
}

function closeLightbox() {
  const box = $('#lightbox')
  if (!box || box.hidden) return
  box.hidden = true
  const img = $('#lb-img')
  if (img) img.removeAttribute('src')
  document.body.style.overflow = ''
}

function setupLightbox() {
  document.addEventListener('click', (e) => {
    const thumb = e.target.closest('.thumb')
    if (thumb) {
      e.preventDefault()
      openLightbox(thumb.dataset.full, thumb.dataset.cap)
      return
    }
    const box = $('#lightbox')
    if (box && !box.hidden) closeLightbox()
  })
}

/* ── 转写预览抽屉 ──────────────────────────────────────────── */

function openDrawer(html) {
  const drawer = $('#drawer')
  const inner = $('#drawer-inner')
  if (!drawer || !inner) return
  inner.innerHTML = html
  drawer.hidden = false
  document.body.style.overflow = 'hidden'
}

function closeDrawer() {
  const drawer = $('#drawer')
  if (!drawer || drawer.hidden) return
  drawer.hidden = true
  document.body.style.overflow = ''
}

async function showTranscript(itemId) {
  openDrawer('<div class="drawer-body"><p class="empty-inline">正在加载转写…</p></div>')
  try {
    const data = await fetchJson(`/api/item/${encodeURIComponent(itemId)}`)
    openDrawer(transcriptHtml(data))
  } catch {
    openDrawer(`<div class="drawer-body"><p class="empty-inline">转写加载失败（/api/item/${escHtml(itemId)}）。</p></div>`)
  }
}

function setupDrawer() {
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-transcript]')
    if (trigger) {
      e.preventDefault()
      showTranscript(trigger.dataset.transcript)
      return
    }
    if (e.target.closest('.drawer-close')) { closeDrawer(); return }
    if (e.target.closest('#drawer') === null && !e.target.closest('.drawer')) {
      // 点击抽屉之外的任何地方：关闭（大图不受影响）
      const drawer = $('#drawer')
      if (drawer && !drawer.hidden) closeDrawer()
    }
  })
}

/* ── 深链接定位（#claim-xxx / #item-xxx）──────────────────── */

function focusHashTarget() {
  let raw = String(location.hash || '').replace(/^#/, '')
  try {
    raw = decodeURIComponent(raw)
  } catch {
    /* hash 本身含 % 时保留原样 */
  }
  if (!raw) return
  const el = document.getElementById(raw)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 2600)
}

/* ── 启动 ──────────────────────────────────────────────────── */

setupSearch()
setupLightbox()
setupDrawer()

if (page === 'stream') setupStream()
document.addEventListener('click', async (e) => {
  const ing = e.target.closest('[data-ingest]')
  if (!ing) return
  ing.disabled = true
  ing.textContent = '已入队…'
  try {
    await fetch('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: [ing.dataset.ingest] }) })
    fetch('/api/ingest-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
  } catch { ing.disabled = false }
})

if (page === 'topic') {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-interest]')
    if (!btn) return
    try {
      const r = await fetch('/api/interest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: btn.dataset.interest }) })
      if (r.ok) location.reload()
    } catch {}
  })
}

if (page === 'search') {
  const form = document.getElementById('search-page-form')
  form?.addEventListener('submit', (e) => {
    e.preventDefault()
    const q = document.getElementById('search-page-input')?.value?.trim()
    if (q) location.href = `/search?q=${encodeURIComponent(q)}`
  })
}

if (page === 'memory') {
  const form = document.getElementById('capture-form')
  form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const content = document.getElementById('cap-content')?.value?.trim()
    if (!content) return
    const body = {
      kind: document.getElementById('cap-kind')?.value || 'idea',
      content,
      intent: document.getElementById('cap-intent')?.value?.trim() || null,
      reviewAt: document.getElementById('cap-review')?.value || null
    }
    try {
      const r = await fetch('/api/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (r.ok) location.reload()
    } catch {}
  })
}

if (page === 'story') {
  setupClaimModes()
  focusHashTarget()
  window.addEventListener('hashchange', focusHashTarget)
}

/* ── Story 事实锚点：悬停/点击显示事实与证据 ──────────────────── */
async function initStoryFacts() {
  const article = document.querySelector('.story-body')
  if (!article) return
  const storyId = article.dataset.storyId || ''
  if (!storyId) return
  let facts = null
  async function loadFacts() {
    if (facts) return facts
    try {
      const data = await fetchJson(`/api/story/${encodeURIComponent(storyId)}/facts`)
      facts = new Map((data.facts || []).map((f) => [f.id, f]))
    } catch {
      facts = new Map()
    }
    return facts
  }
  const panel = $('#fact-panel')
  function showPanel(factId) {
    if (!panel || !facts) return
    const f = facts.get(factId)
    if (!f) return
    const idEl = panel.querySelector('.fact-panel-id')
    const textEl = panel.querySelector('.fact-panel-text')
    const supportEl = panel.querySelector('.fact-panel-support')
    const evEl = panel.querySelector('.fact-panel-evidence')
    if (idEl) idEl.textContent = `${f.id} · ${f.support} 个来源`
    if (textEl) textEl.textContent = f.text
    if (supportEl) supportEl.textContent = f.category ? `分类：${f.category}` : ''
    if (evEl) {
      evEl.innerHTML = (f.evidence || []).map((ev) => {
        const src = ev.item_title ? `<a href="${escapeHtml(ev.item_url || '#')}" target="_blank" rel="noopener">${escapeHtml(ev.item_title)}</a>` : '<span class="dim">来源未知</span>'
        return `<li><p class="ev-text">${escapeHtml(ev.text)}</p><p class="ev-src">${src}${ev.source ? ` · ${escapeHtml(ev.source)}` : ''}</p></li>`
      }).join('') || '<li class="dim">无证据</li>'
    }
    panel.hidden = false
  }
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  }
  article.addEventListener('mouseover', (e) => {
    const zone = e.target.closest('.fz')
    if (!zone) return
    const ids = (zone.dataset.facts || '').split(',').filter(Boolean)
    if (!ids.length) return
    loadFacts().then(() => showPanel(ids[0]))
  })
  article.addEventListener('click', (e) => {
    const zone = e.target.closest('.fz')
    if (!zone) return
    e.preventDefault()
    const ids = (zone.dataset.facts || '').split(',').filter(Boolean)
    if (!ids.length) return
    loadFacts().then(() => showPanel(ids[0]))
  })
  document.querySelectorAll('[data-fact]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.preventDefault()
      loadFacts().then(() => showPanel(chip.dataset.fact))
    })
  })
  panel?.querySelector('.fact-panel-close')?.addEventListener('click', () => { panel.hidden = true })
}

if (page === 'story') {
  initStoryFacts().catch(() => {})
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-annot]')
    if (btn) {
      const comment = document.getElementById('annot-comment')?.value?.trim() || null
      try {
        const r = await fetch('/api/annotation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetType: btn.dataset.annot, targetId: btn.dataset.annotId, kind: btn.dataset.annotKind, comment }) })
        if (r.ok) location.reload()
      } catch {}
      return
    }
    const res = e.target.closest('[data-research]')
    if (res) {
      res.disabled = true
      res.textContent = '生成中…'
      try {
        const r = await fetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storyId: res.dataset.research, force: true, kind: res.dataset.researchKind || 'deep' }) })
        if (r.ok) location.reload()
      } catch { res.disabled = false }
    }
  })
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="mark-seen"]')
    if (!btn) return
    btn.disabled = true
    try {
      await fetch('/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'story', refId: btn.dataset.story, level: 'seen' }) })
      location.reload()
    } catch { btn.disabled = false }
  })
}
