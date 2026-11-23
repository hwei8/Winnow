// web/views/templates.mjs —— HTML 片段生成器
//
// 重要：这是纯字符串拼装模块，**服务端与浏览器共用同一份**。
//   * 服务端 SSR 首屏（curl 能看到真实内容）
//   * 浏览器无限滚动 / 排序切换时用它渲染后续内容
// 因此不存在"SSR 一套、客户端一套"的重复实现。
// 所有插值都必须经过 esc()。

import { esc, clip, safeUrl } from './fmt.mjs'

/* ── 基础零件 ─────────────────────────────────────────────────── */

const arrayOf = (v) => (Array.isArray(v) ? v : [])

/** 置信度小圆点（5 档） */
export function dotsHtml(pct) {
  const p = typeof pct === 'number' && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null
  const filled = p === null ? 0 : Math.round(p / 20)
  let html = `<span class="dots" title="置信度 ${p === null ? '—' : `${p}%`}">`
  for (let i = 0; i < 5; i += 1) html += `<i class="${i < filled ? 'on' : ''}"></i>`
  return `${html}</span>`
}

/** kind 徽标 */
export function kindHtml(claim) {
  const cls = claim?.kind_cls || 'k-other'
  const label = claim?.kind_label || claim?.kind || '其他'
  return `<span class="kind ${esc(cls)}">${esc(label)}</span>`
}

function timeHtml(claim) {
  if (!claim?.time_label) return ''
  return `<span class="time" title="证据时间范围">${esc(claim.time_label)}</span>`
}

function verifiedHtml(claim) {
  if (!claim?.verified) return ''
  return `<span class="verified" title="证据已人工校验">✓</span>`
}

function frameThumbHtml(claim) {
  if (!claim?.frame_url) return ''
  const cap = claim.time_label || ''
  return `<button class="thumb" type="button" data-full="${esc(claim.frame_url)}" data-cap="${esc(cap)}" title="点击查看大图">
      <img src="${esc(claim.frame_url)}" alt="证据截图 ${esc(cap)}" loading="lazy">
      <span class="thumb-cap">${esc(cap)}</span>
    </button>`
}

function evidenceHtml(claim) {
  if (!claim?.excerpt) return ''
  return `<details class="ev">
      <summary>证据原文${claim.segment_from !== null && claim.segment_from !== undefined ? `（seg ${esc(claim.segment_from)}）` : ''}</summary>
      <blockquote>${esc(claim.excerpt)}</blockquote>
    </details>`
}

function entitiesHtml(claim, limit = 4) {
  const list = arrayOf(claim?.entities).slice(0, limit)
  if (!list.length) return ''
  const chips = list
    .filter((e) => e && e.id)
    .map((e) => `<a class="ent-chip" href="/entity/${encodeURIComponent(e.id)}" title="${esc(e.name)}">${esc(e.name)}</a>`)
    .join('')
  return chips ? `<div class="claim-ents">${chips}</div>` : ''
}

/* ── 顶部栏 ───────────────────────────────────────────────────── */

export function headerHtml(stats = {}) {
  const counter = (n, label) => `<span class="counter"><b>${esc(n ?? '—')}</b>${esc(label)}</span>`
  return `
  <div class="topbar-inner">
    <a class="brand" href="/" aria-label="回到记忆流">
      <span class="brand-mark">◈</span>
      <span class="brand-text">Winnow</span>
    </a>
    <nav class="topnav">
      <a class="topnav-link" href="/">记忆流</a>
      <a class="topnav-link" href="/brief">简报</a>
      <a class="topnav-link" href="/memory">记忆</a>
      <a class="topnav-link" href="/stance">立场</a>
      <a class="topnav-link" href="/claims">质量</a>
      <a class="topnav-link" href="/audit">审计</a>
      <a class="topnav-link" href="/topics">覆盖</a>
    </nav>
    <form class="search" id="search-form" role="search" autocomplete="off">
      <input id="search-input" name="q" type="search" placeholder="搜索 claim（中文全文检索，回车）" aria-label="搜索 claim" />
      <kbd class="hint-kbd">/</kbd>
      <button class="search-btn" type="submit" aria-label="搜索">搜索</button>
    </form>
    <div class="counters" title="库内总量">
      ${counter(stats.items, '条目')}
      ${counter(stats.stories, '事件')}
      ${counter(stats.claims, 'claim')}
      ${counter(stats.entities, '实体')}
    </div>
  </div>
  <div class="search-panel" id="search-panel" hidden></div>`
}

/* ── 记忆流卡片 ───────────────────────────────────────────────── */

function cardClaimLine(claim, story) {
  const href = `${story.url}#${encodeURIComponent(`claim-${claim.id}`)}`
  return `<li class="c-claim">
      ${kindHtml(claim)}
      ${dotsHtml(claim.confidence_pct)}
      <a class="c-claim-text" href="${esc(safeUrl(href))}">${esc(clip(claim.text, 132))}</a>
    </li>`
}

export function storyCard(story) {
  const s = story || {}
  const url = s.url || `/story/${encodeURIComponent(s.id || '')}`
  const claims = arrayOf(s.claims)
  const topics = arrayOf(s.topics)
  const items = arrayOf(s.items)
  const showItems = items.length > 1 || (items[0] && items[0].title && items[0].title !== s.title)

  const claimList = claims.length
    ? `<ol class="c-claims">${claims.map((c) => cardClaimLine(c, { url })).join('')}</ol>`
    : `<p class="c-empty">该事件暂未提取到 claim</p>`

  const itemList = showItems
    ? `<ul class="c-items">${items
        .map(
          (it) =>
            `<li><a href="${esc(safeUrl(url))}">${esc(clip(it.title || '未命名条目', 80))}</a>${
              it.author ? `<span class="dim">· ${esc(it.author)}</span>` : ''
            }</li>`
        )
        .join('')}</ul>`
    : ''

  const topicList = topics.length
    ? `<div class="c-topics">${topics
        .map((t) => `<button type="button" class="chip" data-q="${esc(t)}">#${esc(t)}</button>`)
        .join('')}</div>`
    : ''

  return `<article class="card" data-story="${esc(s.id)}">
    <div class="c-head">
      <h2 class="c-title"><a href="${esc(safeUrl(url))}">${esc(s.title || '未命名事件')}</a></h2>
      <div class="c-meta">
        <span class="pill">${esc(s.status_label || '—')}</span>
        ${s.validated ? '<span class="pill pill-ok">已验证</span>' : ''}
        ${s.pending_updates > 0 ? `<span class="pill pill-new">新 ${esc(s.pending_updates)}</span>` : ''}
        <span class="m"><b>${esc(s.item_count ?? 0)}</b> 条目</span>
        <span class="m"><b>${esc(s.claim_count ?? 0)}</b> claim</span>
        <span class="m dim">${s.updated_label ? `更新于 ${esc(s.updated_label)}` : '时间未知'}</span>
      </div>
    </div>
    ${itemList}
    ${claimList}
    ${topicList}
  </article>`
}

export function streamCardsHtml(stories) {
  const list = arrayOf(stories)
  if (!list.length) return ''
  return list.map(storyCard).join('')
}

/* ── 记忆流页面主体 ───────────────────────────────────────────── */

export function streamMain(data) {
  const sort = data?.sort === 'claims' ? 'claims' : 'recent'
  const total = data?.total ?? 0
  const allStories = arrayOf(data?.stories)
  const buckets = [
    { key: 'unseen', title: '未读更新', note: '自你上次阅读以来有新内容' },
    { key: 'today', title: '今天', note: '' },
    { key: 'week', title: '7 天内', note: '' },
    { key: 'older', title: '更早（以下优先级更低）', note: '' }
  ]
  const grouped = buckets.map(b => ({ ...b, stories: allStories.filter(s => (s.bucket || 'older') === b.key) })).filter(b => b.stories.length)
  const cards = grouped.map(b => `<div class="stream-bucket"><h2 class="bucket-title">${esc(b.title)}<span class="dim">${b.note ? ` · ${esc(b.note)}` : ''}</span></h2>${streamCardsHtml(b.stories)}</div>`).join('')
  const cardsFlat = streamCardsHtml(allStories)
  const emptyHtml = `<div class="empty" id="stream-empty"${cards ? ' hidden' : ''}>
      <p class="empty-title">还没有事件数据</p>
      <p class="empty-sub">等抽取流程写入 story / claim 后，这里会出现卡片。</p>
    </div>`
  return `
  <section class="page-head">
    <div>
      <h1 class="page-title">记忆流</h1>
      <p class="page-sub">按事件最新活动倒序 · 共 <b>${esc(total)}</b> 个事件</p>
    </div>
    <div class="seg" role="group" aria-label="排序方式">
      <a class="seg-item${sort === 'recent' ? ' active' : ''}" href="/?sort=recent" data-sort="recent">最近更新</a>
      <a class="seg-item${sort === 'claims' ? ' active' : ''}" href="/?sort=claims" data-sort="claims">claim 最多</a>
      <a class="seg-item${data?.filter === 'unseen' ? ' active' : ''}" href="/?filter=unseen" data-filter="unseen">只看未追平</a>
    </div>
  </section>
  ${data?.filter === 'unseen' && !cardsFlat ? `<div class="notice notice-delta"><b>今天的新增已读完</b> —— 没有未追平的更新了。</div>` : ''}
  <div class="stream" id="stream">${cards || cardsFlat}</div>
  ${emptyHtml}
  <div class="more-row" id="more-row"${data?.has_more ? '' : ' hidden'}>
    <button class="btn" id="load-more" type="button">加载更多</button>
    <span class="more-hint" id="more-hint"></span>
  </div>
  <div id="stream-sentinel" class="sentinel" aria-hidden="true"></div>`
}

/* ── claim 详情（事件页）──────────────────────────────────────── */

function claimBlock(claim, opts = {}) {
  const id = `claim-${claim.id}`
  const showSource = opts.showSource && claim.item_title
  return `<li class="claim" id="${esc(id)}">
    <div class="claim-row">
      <div class="claim-badges">
        ${kindHtml(claim)}
        ${dotsHtml(claim.confidence_pct)}
        <span class="conf-num" title="confidence">${esc(claim.confidence_label ?? '—')}</span>
        ${timeHtml(claim)}
        ${verifiedHtml(claim)}
      </div>
      <p class="claim-text">${esc(claim.text)}</p>
      ${
        claim.subject || claim.predicate || claim.object_text
          ? `<p class="claim-spo"><span class="spo-k">主</span>${esc(claim.subject || '—')}
             <span class="spo-k">谓</span>${esc(claim.predicate || '—')}
             <span class="spo-k">宾</span>${esc(claim.object_text || '—')}</p>`
          : ''
      }
      ${showSource ? `<p class="claim-src"><a href="#${encodeURIComponent(`item-${claim.item_id}`)}">${esc(claim.item_title)}</a>${claim.item_author ? `<span class="dim">· ${esc(claim.item_author)}</span>` : ''}${claim.item_published_label ? `<span class="dim">· ${esc(claim.item_published_label)}</span>` : ''}</p>` : ''}
      <div class="claim-foot">
        ${evidenceHtml(claim)}
        ${entitiesHtml(claim)}
      </div>
    </div>
    <div class="claim-side">${frameThumbHtml(claim)}</div>
  </li>`
}

function legacyHtml(item) {
  const legacy = item?.legacy
  if (!legacy || (!legacy.tldr && !legacy.detailed && !arrayOf(legacy.key_topics).length)) return ''
  const topics = arrayOf(legacy.key_topics)
    .slice(0, 12)
    .map((t) => {
      const time = t && (t.timestamp || t.time || '')
      const title = t && (t.title || t.name || '')
      const desc = t && (t.description || '')
      if (!title && !desc) return ''
      return `<li>${time ? `<time>${esc(time)}</time>` : ''}<b>${esc(title)}</b>${desc ? `<span class="dim">${esc(clip(desc, 160))}</span>` : ''}</li>`
    })
    .filter(Boolean)
    .join('')
  const tags = arrayOf(legacy.tags)
    .map((t) => `<span class="chip chip-static">${esc(typeof t === 'string' ? t : t?.name || '')}</span>`)
    .join('')
  return `<details class="legacy">
      <summary>历史解释（旧 LLM 摘要）</summary>
      <div class="legacy-body">
        ${legacy.tldr ? `<p class="legacy-tldr">${esc(legacy.tldr)}</p>` : ''}
        ${legacy.detailed ? `<div class="legacy-detailed">${esc(legacy.detailed)}</div>` : ''}
        ${topics ? `<ul class="legacy-topics">${topics}</ul>` : ''}
        ${tags ? `<div class="legacy-tags">${tags}</div>` : ''}
        <p class="legacy-meta dim">${legacy.model_guess ? `模型：${esc(legacy.model_guess)}` : ''}${
          legacy.ratio !== null && legacy.ratio !== undefined ? ` · 摘要/转写比 ${esc(legacy.ratio)}` : ''
        }</p>
      </div>
    </details>`
}

function itemHeadHtml(item) {
  const meta = [
    item.author ? `UP：${esc(item.author)}` : '',
    item.published_label ? esc(item.published_label) : '',
    item.duration_label ? `时长 ${esc(item.duration_label)}` : '',
    item.view_label ? `播放 ${esc(item.view_label)}` : '',
    item.segment_count !== null && item.segment_count !== undefined ? `${esc(item.segment_count)} 段` : ''
  ]
    .filter(Boolean)
    .join('<span class="sep">·</span>')
  return `<div class="item-head">
      <h2 class="item-title">
        <a href="#${encodeURIComponent(`item-${item.id}`)}">${esc(item.title)}</a>
        <span class="pill pill-soft">${esc(item.claim_count ?? 0)} claim</span>
      </h2>
      <div class="item-meta">${meta}</div>
      <div class="item-actions">
        <button class="btn btn-xs" type="button" data-transcript="${esc(item.id)}">转写预览</button>
        ${item.url ? `<a class="btn btn-xs" href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">原视频 ↗</a>` : ''}
      </div>
    </div>`
}

function claimsByItemHtml(data) {
  const claims = arrayOf(data.claims)
  const items = arrayOf(data.items)
  const byItem = new Map()
  for (const claim of claims) {
    const key = claim.item_id || '__none__'
    if (!byItem.has(key)) byItem.set(key, [])
    byItem.get(key).push(claim)
  }
  const sections = []
  for (const item of items) {
    const group = byItem.get(item.id) || []
    byItem.delete(item.id)
    const claimsHtml = group.length
      ? `<ul class="claims">${group.map((c) => claimBlock(c)).join('')}</ul>`
      : `<p class="empty-inline">该条目暂未提取到 claim（可能抽取失败或全是元信息声明）。</p>`
    sections.push(`<section class="item-block" id="${esc(`item-${item.id}`)}">
        ${itemHeadHtml(item)}
        ${legacyHtml(item)}
        ${claimsHtml}
      </section>`)
  }
  // 兜底：claim 指向的条目不在 story_item 里（数据不一致时也不能丢内容）
  for (const [itemId, group] of byItem) {
    const label = group[0]?.item_title || itemId || '未知条目'
    sections.push(`<section class="item-block">
        <div class="item-head"><h2 class="item-title">${esc(label)}<span class="pill pill-soft">${group.length} claim</span></h2>
          <div class="item-meta dim">未在事件条目列表中找到该条目</div></div>
        <ul class="claims">${group.map((c) => claimBlock(c)).join('')}</ul>
      </section>`)
  }
  if (!sections.length) {
    return `<p class="empty-inline">该事件没有条目。</p>`
  }
  return sections.join('')
}

function claimsByTimeHtml(data) {
  const claims = arrayOf(data.claims).slice().sort((a, b) => {
    const ta = a.time_start ?? Number.POSITIVE_INFINITY
    const tb = b.time_start ?? Number.POSITIVE_INFINITY
    if (ta !== tb) return ta - tb
    const pa = a.item_published_ts ?? 0
    const pb = b.item_published_ts ?? 0
    if (pa !== pb) return pa - pb
    return String(a.id).localeCompare(String(b.id))
  })
  if (!claims.length) return `<p class="empty-inline">该事件暂未提取到 claim。</p>`
  return `<ul class="claims">${claims.map((c) => claimBlock(c, { showSource: true })).join('')}</ul>`
}

/** 事件页的 claim 区域；mode: 'item' | 'time'（客户端切换排序时复用） */
export function renderStoryClaims(data, mode = 'item') {
  return mode === 'time' ? claimsByTimeHtml(data) : claimsByItemHtml(data)
}


/* ── Topics 页：覆盖地图 ────────────────────────────────── */

const GAP_LABEL = { 'no-story': '无故事', 'single-source': '单一来源', thin: '内容偏薄', stale: '14 天未更新' }

export function topicsMain ({ topics = [], beat = null } = {}) {
  const rows = topics.map(t => `<tr>
    <td><a href="/topic/${encodeURIComponent(t.name)}">${esc(t.name)}</a>${t.interested ? ' <span class="pill pill-ok">关注</span>' : ''}</td>
    <td>${esc(t.stories)}</td><td>${esc(t.claims)}</td><td>${esc(t.sources)}</td>
    <td>${t.last_days != null ? esc(t.last_days) + ' 天前' : '—'}</td>
    <td>${t.gap ? `<span class="pill pill-warn">${esc(GAP_LABEL[t.gap] || t.gap)}</span>` : ''}</td>
  </tr>`).join('')
  const beatHtml = beat ? `<section class="panel"><h2 class="panel-title">Beat 报告（${esc((beat.generated_at || '').slice(0, 16).replace('T', ' '))}）</h2>
    ${beat.findings.map(f => `<div class="beat-item"><b>${esc(f.topic)}</b> <span class="dim">${esc(f.coverage.stories)} Story · ${esc(f.coverage.claims)} claim · ${esc(f.coverage.sources)} 源${f.coverage.gap ? ' · ' + esc(f.coverage.gap) : ''}</span>
      ${f.missing.length ? `<ul class="side-list">${f.missing.map(m => `<li><a href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener noreferrer">${esc(clip(m.title, 50))}</a><span class="dim"> ${esc(m.at || '')}</span> <button class="btn btn-sm" type="button" data-ingest="${esc(m.url)}">入库</button></li>`).join('')}</ul>` : ''}
      ${f.suggestions.length ? `<p class="dim">建议：${esc(f.suggestions.join('；'))}</p>` : ''}</div>`).join('') || '<p class="dim">无兴趣主题，先声明关注。</p>'}
  </section>` : ''
  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>覆盖地图</span></nav>
  <header class="story-head"><h1 class="story-title">覆盖地图</h1>
    <div class="story-meta"><span class="m"><b>${esc(topics.length)}</b> 个主题</span><span class="m dim">缺口标记：单一来源 / 偏薄 / 14 天未更新</span></div>
  </header>
  <div class="story-grid"><div class="main-col">
    <section class="panel"><h2 class="panel-title">主题覆盖</h2>
      <table class="cov-table"><thead><tr><th>主题</th><th>Story</th><th>claim</th><th>源</th><th>最近</th><th>缺口</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="dim">无主题数据</td></tr>'}</tbody></table>
    </section>
    ${beatHtml}
  </div></div>`
}

export function topicMain ({ topic, stories = [], sources = [], interest = null } = {}) {
  const storyRows = stories.map(s => `<li><a href="/story/${encodeURIComponent(s.id)}">${esc(s.title || '未命名')}</a><span class="dim"> ${esc(s.category || '')}</span></li>`).join('')
  const srcRows = sources.map(x => `<li>${esc(x.name)} <span class="dim">${esc(x.n)} 条</span></li>`).join('')
  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><a href="/topics">覆盖地图</a><span class="sep">/</span><span>${esc(topic.name)}</span></nav>
  <header class="story-head"><h1 class="story-title">${esc(topic.name)}</h1>
    <div class="story-meta"><span class="m"><b>${esc(stories.length)}</b> Story</span><span class="m"><b>${esc(sources.reduce((a, x) => a + x.n, 0))}</b> 条目</span>
      <button class="btn btn-sm" type="button" data-interest="${esc(topic.name)}">${interest ? '取消关注' : '关注这个主题'}</button></div>
  </header>
  <div class="story-grid">
    <aside class="side"><section class="panel"><h2 class="panel-title">来源</h2><ul class="side-list">${srcRows || '<li class="dim">无</li>'}</ul></section></aside>
    <div class="main-col"><section class="panel"><h2 class="panel-title">相关 Story</h2><ul class="side-list">${storyRows || '<li class="dim">无</li>'}</ul></section></div>
  </div>`
}

/* ── Search 页 ──────────────────────────────────────────── */

export function searchMain (data) {
  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>搜索</span></nav>
  <header class="story-head"><h1 class="story-title">搜索</h1>
    <form class="search-page-form" id="search-page-form" role="search">
      <input id="search-page-input" name="q" type="search" value="${esc(data?.q || '')}" placeholder="搜索 claim / 条目（中文全文检索）" />
      <button class="btn" type="submit">搜索</button>
    </form>
  </header>
  <div id="search-page-results">${data?.q ? searchResultsHtml(data) : '<p class="dim">输入关键词开始搜索。</p>'}</div>`
}

/* ── Claims 页：数据质量 ───────────────────────────────── */

export function claimsMain ({ contested = [], superseded = [], lowConf = [], totals = {} } = {}) {
  const claimRow = (c) => `<li class="claim claim-compact"><p class="claim-text">${esc(c.text)}</p>
    <p class="claim-src dim">${esc((c.story_title || c.item_title || '来源未知'))}${c.confidence != null ? ` · conf ${Number(c.confidence).toFixed(2)}` : ''}</p></li>`
  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>数据质量</span></nav>
  <header class="story-head"><h1 class="story-title">Claims 数据质量</h1>
    <div class="story-meta">
      <span class="m">claim <b>${esc(totals.claims ?? 0)}</b></span>
      <span class="m">有争议 <b>${esc(totals.contested ?? 0)}</b></span>
      <span class="m">已取代事实 <b>${esc(totals.superseded ?? 0)}</b></span>
      <span class="m">低置信 <b>${esc(totals.lowConf ?? 0)}</b></span>
      <span class="m">缺证据 <b>${esc(totals.noEvidence ?? 0)}</b></span>
    </div>
  </header>
  <div class="story-grid"><div class="main-col">
    <section class="panel"><h2 class="panel-title">有争议（${contested.length}）</h2><ul class="claim-list">${contested.map(claimRow).join('') || '<li class="dim">无</li>'}</ul></section>
    <section class="panel"><h2 class="panel-title">已取代事实（${superseded.length}）</h2><ul class="claim-list">${superseded.map(f => `<li class="claim claim-compact"><p class="claim-text">${esc(f.canonical_text)}</p><p class="claim-src dim">→ 被 ${esc(f.superseded_by || '—')} 取代</p></li>`).join('') || '<li class="dim">无</li>'}</ul></section>
    <section class="panel"><h2 class="panel-title">低置信（${lowConf.length}）</h2><ul class="claim-list">${lowConf.map(claimRow).join('') || '<li class="dim">无</li>'}</ul></section>
  </div></div>`
}

/* ── Audit 页：为什么没推 / 漏了什么 / 源健康 / 账本 ───── */

export function auditMain (data) {
  const a = data || {}
  const adapters = arrayOf(a.adapters).map(x => `<li><span class="pill ${x.ok ? 'pill-ok' : 'pill-bad'}">${x.ok ? 'OK' : 'FAIL'}</span> ${esc(x.adapter)} <span class="dim">${esc(x.latency_ms ?? '—')}ms · ${esc((x.checked_at || '').slice(0, 16).replace('T', ' '))}</span></li>`).join('')
  const skipped = arrayOf(a.skipped).map(p => `<li>${esc(p.title)} <span class="dim">${esc(p.n)} 条更新未入选简报</span></li>`).join('')
  const tokens = arrayOf(a.tokens).map(t => `<li>${esc(t.task)} <span class="dim">${esc(t.n)} 次 · ${esc(t.total ?? 0)} tokens · $${Number(t.cost || 0).toFixed(4)}</span></li>`).join('')
  const days = arrayOf(a.dayTokens).map(d => `<li>${esc(d.d)} <span class="dim">${esc(d.total ?? 0)} tokens</span></li>`).join('')
  const ann = a.annotations || {}
  const consumption = ann.total ? Math.round((ann.effectsApplied / ann.total) * 100) : 0
  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>审计</span></nav>
  <header class="story-head"><h1 class="story-title">审计</h1>
    <div class="story-meta"><span class="m">标注消费率 <b>${consumption}%</b></span><span class="m">标注 <b>${esc(ann.total ?? 0)}</b></span><span class="m">生效 <b>${esc(ann.effectsApplied ?? 0)}</b></span></div>
  </header>
  <div class="story-grid"><div class="main-col">
    <section class="panel"><h2 class="panel-title">源健康</h2><ul class="side-list">${adapters || '<li class="dim">暂无采集记录</li>'}</ul></section>
    <section class="panel"><h2 class="panel-title">为什么没推（未入选最新简报的待更新）</h2><ul class="side-list">${skipped || '<li class="dim">没有遗漏</li>'}</ul></section>
    <section class="panel"><h2 class="panel-title">系统度量</h2>
      ${a.metrics ? `<ul class="side-list">
        <li>追平率 <b>${Math.round((a.metrics.stories?.catch_up_rate || 0) * 100)}%</b> <span class="dim">（已追踪 ${esc(a.metrics.stories?.tracked ?? 0)} 个 Story）</span></li>
        <li>事实冗余率 <b>${Math.round((a.metrics.claims?.fact_redundancy || 0) * 100)}%</b> <span class="dim">（claim ${esc(a.metrics.claims?.total ?? 0)} → fact ${esc(a.metrics.claims?.facts ?? 0)}）</span></li>
        <li>QA 均分 <b>${esc(a.metrics.qa?.avg ?? '—')}</b> <span class="dim">（${esc(a.metrics.qa?.stories ?? 0)} 篇）</span></li>
        <li>纠错率 <b>${Math.round((a.metrics.annotations?.wrong_rate || 0) * 100)}%</b> <span class="dim">（${esc(a.metrics.annotations?.wrong ?? 0)} / ${esc(a.metrics.annotations?.total ?? 0)} 标注）</span></li>
        <li>简报选择率 <b>${Math.round((a.metrics.briefing?.selection_rate || 0) * 100)}%</b> <span class="dim">（${esc(a.metrics.briefing?.latest_picked ?? 0)} / ${esc(a.metrics.briefing?.pending_stories ?? 0)} 待更新）</span></li>
      </ul>` : '<p class="dim">运行 metrics.mjs 生成</p>'}
    </section>
    <section class="panel"><h2 class="panel-title">重验证（needs_recheck）</h2>
      <p class="dim">当前需复核 claim：<b>${esc(a.recheckCount ?? 0)}</b> · 运行 <code>revalidate.mjs</code> 标记，<code>--resolve=ID</code> 解除</p>
    </section>
    <section class="panel"><h2 class="panel-title">本体提案（${arrayOf(a.ontologyPending).length} 条待审）</h2>
      <ul class="side-list">${arrayOf(a.ontologyPending).map(o => `<li><span class="pill">${esc(o.kind)}</span> <span class="dim">${esc((o.payload_json || '').slice(0, 90))}</span></li>`).join('') || '<li class="dim">运行 ontology.mjs --propose 生成</li>'}</ul>
    </section>
    <section class="panel"><h2 class="panel-title">源质量（验证率/争议/被纠错）</h2>
      <table class="cov-table"><thead><tr><th>源</th><th>条目</th><th>claim</th><th>验证率</th><th>争议</th><th>被纠错</th><th>分数</th></tr></thead><tbody>
      ${arrayOf(a.sourceQuality).map(q => `<tr><td>${esc(q.name || q.source_id)}</td><td>${esc(q.items)}</td><td>${esc(q.claims)}</td><td>${Math.round((q.verified_rate || 0) * 100)}%</td><td>${esc(q.contested)}</td><td>${esc(q.wrong_hits)}</td><td>${esc(q.score)}</td></tr>`).join('') || '<tr><td colspan="7" class="dim">运行 source_quality.mjs 生成</td></tr>'}
      </tbody></table>
    </section>
    <section class="panel"><h2 class="panel-title">Token 账本（按任务）</h2><ul class="side-list">${tokens || '<li class="dim">无记录</li>'}</ul></section>
    <section class="panel"><h2 class="panel-title">Token 账本（按天）</h2><ul class="side-list">${days || '<li class="dim">无记录</li>'}</ul></section>
  </div></div>`
}

/* ── Stance 页：我的立场 ───────────────────────────────── */

export function stanceMain ({ stances = [], stats = {} } = {}) {
  const rows = stances.map(st => `<li class="stance-item">
    <div class="stance-head"><span class="pill ${st.position === '同意' ? 'pill-ok' : 'pill-bad'}">${esc(st.position)}</span>
      ${st.target_type === 'story' ? `<a href="/story/${encodeURIComponent(st.target_id)}">${esc(st.target_title || st.target_id)}</a>` : `<span>${esc(st.target_title || st.target_id)}</span>`}
      <span class="dim">${esc((st.updated_at || '').slice(0, 10))}</span></div>
    ${st.rationale ? `<p class="stance-pos">${esc(st.rationale)}</p>` : ''}
    ${st.history.length > 1 ? `<ul class="annot-list">${st.history.map(h => `<li><span class="dim">${esc((h.at || '').slice(0, 10))}</span> ${esc(h.position)}${h.rationale ? ` · ${esc(h.rationale)}` : ''}</li>`).join('')}</ul>` : ''}
  </li>`).join('')
  const statLine = (stats.byKind || []).map(r => `${esc(r.kind)} ${esc(r.n)}`).join(' · ')
  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>立场</span></nav>
  <header class="story-head"><h1 class="story-title">我的立场</h1>
    <div class="story-meta"><span class="m"><b>${esc(stances.length)}</b> 条立场</span><span class="m dim">标注：${statLine || '—'}</span></div>
  </header>
  <ul class="stance-list">${rows || '<li class="dim">还没有立场。在 Story 页点「同意 / 不同意」并写评论即可形成。</li>'}</ul>`
}

/* ── Brief 页：今日简报 ─────────────────────────────────── */

export function briefMain (brief) {
  if (!brief) return `<div class="empty"><p class="empty-title">还没有简报</p><p class="empty-sub">运行 <code>node brief.mjs</code> 生成。</p></div>`
  const ch = { must: '必看', interest: '兴趣', explore: '探索' }
  const groups = ['must', 'interest', 'explore'].map(c => ({ c, items: brief.items.filter(i => i.channel === c) }))
  const renderItem = (it, i) => `<li class="brief-item">
    <div class="brief-head"><span class="pill pill-cat">${esc(it.category || '事件')}</span>${it.severity ? `<span class="pill">${esc(it.severity)}</span>` : ''}<a class="brief-title" href="/story/${encodeURIComponent(it.story_id)}">${esc(it.title)}</a></div>
    ${it.what ? `<p class="brief-line"><b>发生了什么</b>${esc(it.what)}</p>` : ''}
    ${it.what_new ? `<p class="brief-line"><b>新在哪</b>${esc(it.what_new)}</p>` : ''}
    ${it.why_you ? `<p class="brief-line"><b>为什么推你</b>${esc(it.why_you)}</p>` : ''}
  </li>`
  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>今日简报</span></nav>
  <header class="story-head"><h1 class="story-title">今日简报 ${esc(brief.date)}</h1>
    <div class="story-meta"><span class="m">候选 <b>${esc(brief.stats?.candidates ?? brief.items.length)}</b> 条</span><span class="m">选出 <b>${esc(brief.items.length)}</b> 条</span><span class="m dim">生成于 ${esc((brief.generated_at || '').slice(0, 16).replace('T', ' '))}</span></div>
  </header>
  ${groups.filter(g => g.items.length).map(g => `<section class="brief-section"><h2 class="section-title">■ ${esc(ch[g.c])}（${g.items.length}）</h2><ol class="brief-list">${g.items.map(renderItem).join('')}</ol></section>`).join('')}`
}

/* ── Memory 页：capture 捕获与列表 ───────────────────────── */

export function memoryMain ({ captures = [], due = [] } = {}) {
  const capRows = arrayOf(captures).map(c => `<li class="cap-item">
    <div class="cap-head"><span class="pill pill-cat">${esc(c.kind)}</span><span class="dim">${esc((c.created_at || '').slice(0, 16).replace('T', ' '))}</span>${c.review_at ? `<span class="dim">复核 ${esc(c.review_at.slice(0, 10))}</span>` : ''}</div>
    <p class="cap-content">${esc(c.content)}</p>
    ${c.intent ? `<p class="cap-intent dim">为什么存：${esc(c.intent)}</p>` : ''}
  </li>`).join('')
  const dueRows = arrayOf(due).map(c => `<li class="cap-item"><span class="dim">${esc((c.review_at || '').slice(0, 10))}</span> ${esc(clip(c.content, 60))}</li>`).join('')
  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>记忆</span></nav>
  <header class="story-head"><h1 class="story-title">记忆</h1>
    <div class="story-meta"><span class="m"><b>${esc(captures.length)}</b> 条</span>${due.length ? `<span class="m"><b>${esc(due.length)}</b> 条到复核期</span>` : ''}</div>
  </header>
  <div class="story-grid">
    <aside class="side">
      <section class="panel"><h2 class="panel-title">捕获</h2>
        <form id="capture-form" class="cap-form">
          <textarea id="cap-content" rows="3" placeholder="记一条：想法 / 待读 / 决策 / 参考…" required></textarea>
          <div class="cap-row">
            <select id="cap-kind"><option value="idea">想法</option><option value="todo">待读</option><option value="decision">决策</option><option value="reference">参考</option><option value="life">生活</option></select>
            <input id="cap-intent" placeholder="为什么存（可选）" />
          </div>
          <div class="cap-row">
            <input id="cap-review" type="date" title="复核日（可选）" />
            <button class="btn btn-sm" type="submit">保存</button>
          </div>
        </form>
      </section>
      ${due.length ? `<section class="panel"><h2 class="panel-title">到复核期</h2><ul class="side-list">${dueRows}</ul></section>` : ''}
    </aside>
    <div class="main-col">
      <div class="claims-toolbar"><h2 class="section-title">最近捕获</h2></div>
      <ul class="cap-list">${capRows || '<li class="dim">还没有记录</li>'}</ul>
    </div>
  </div>`
}

/* ── Story 正文渲染（正文干净 + 事实锚点 span）──────────────── */

function renderStoryPlain(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((block) => {
      const t = block.trim()
      if (!t) return ''
      if (t.startsWith('## ')) return `<h2 class="story-h2">${esc(t.slice(3))}</h2>`
      return `<p class="story-p">${esc(t).replace(/\n/g, ' ')}</p>`
    })
    .join('')
}

function renderStoryBody(body, spans) {
  const list = arrayOf(spans)
    .filter((s) => s.end > s.start && s.start >= 0 && s.end <= body.length)
    .sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const s of list) {
    if (s.start < pos) continue
    out += renderStoryPlain(body.slice(pos, s.start))
    const ids = arrayOf(s.facts).map((f) => f.id).join(',')
    out += `<span class="fz" data-facts="${esc(ids)}">${esc(body.slice(s.start, s.end))}</span>`
    pos = s.end
  }
  out += renderStoryPlain(body.slice(pos))
  return out
}

function storyNotice(story, related) {
  if (story.status === 'duplicate' && story.merged_into) {
    return `<div class="notice notice-dup"><b>已并入</b>《<a href="/story/${encodeURIComponent(story.merged_into.id)}">${esc(story.merged_into.title)}</a>》——这条内容被判定为同一事件的重复报道，已归并到主 Story，不再单独展示。</div>`
  }
  if (story.story_kind === 'snippet') {
    return `<div class="notice notice-snip"><b>短讯片段</b>——此条仅含少量事实（< ${3} 条）或篇幅过短，不构成完整 Story，已从信息流中隐藏。</div>`
  }
  return ''
}
function relatedList(related) {
  if (!related || !related.length) return ''
  const items = related.map(r => `<li><a href="/story/${encodeURIComponent(r.id)}">${esc(clip(r.title, 40))}</a><span class="dim">${esc(r.relation === 'update' ? '更新' : r.relation === 'overlap' ? '同事件' : r.relation === 'duplicate' ? '重复' : '相关')}${r.gap ? ' · 缺口 ' + r.gap : ''}</span></li>`).join('')
  return `<section class="panel"><h2 class="panel-title">相关 Story</h2><ul class="side-list">${items}</ul></section>`
}
function storyDelta(data) {
  const p = data.story.pending_updates
  if (!p || !p.count) return ''
  const items = p.items.slice(0, 8).map(u => `<li><span class="dim">${esc((u.at || '').slice(0, 16).replace('T', ' '))}</span> ${esc(u.type === 'new_facts' ? '新增事实' : u.type === 'append_section' ? '追加进展' : u.type === 'consolidate' ? '节合并' : u.type === 'merged' ? '并入' : u.type)}${u.severity ? `<span class="dim"> · ${esc(u.severity)}</span>` : ''}</li>`).join('')
  return `<div class="notice notice-delta">
    <b>自你上次阅读以来有 ${p.count} 条更新</b>
    <ul class="delta-list">${items}</ul>
    <button class="btn btn-sm" type="button" data-action="mark-seen" data-story="${esc(data.story.id)}">标记已追平</button>
  </div>`
}

function storyAnnotationBar (story) {
  const kinds = [['known', '已知'], ['read', '已读'], ['agree', '同意'], ['disagree', '不同意']]
  return `<section class="panel annot-panel">
    <h2 class="panel-title">标注</h2>
    <div class="annot-row">
      ${kinds.map(([k, label]) => `<button class="btn btn-sm" type="button" data-annot="story" data-annot-id="${esc(story.id)}" data-annot-kind="${k}">${label}</button>`).join('')}
    </div>
    <input id="annot-comment" class="annot-input" placeholder="写一句评论（可选），比如为什么不同意" />
    ${(story.annotations || []).length ? `<ul class="annot-list">${story.annotations.map(a => `<li><span class="pill">${esc(a.kind)}</span>${a.comment ? ` ${esc(a.comment)}` : ''}<span class="dim"> ${esc((a.at || '').slice(0, 10))}</span></li>`).join('')}</ul>` : ''}
  </section>`
}

function storyStance (story) {
  const st = story.stance
  if (!st) return ''
  const hist = (st.history || []).map(h => `<li><span class="dim">${esc((h.at || '').slice(0, 10))}</span> ${esc(h.position)}${h.rationale ? ` · ${esc(h.rationale)}` : ''}</li>`).join('')
  return `<section class="panel"><h2 class="panel-title">我的立场</h2>
    <p class="stance-pos">${esc(st.position)}${st.rationale ? `：${esc(st.rationale)}` : ''}</p>
    <ul class="side-list">${hist}</ul>
  </section>`
}

function storyTimeline (story) {
  const tl = story.timeline || []
  if (!tl.length) return ''
  const labels = { new_facts: '新增事实', append_section: '追加进展', consolidate: '节合并', merged: '并入', rewrite: '重写' }
  return `<section class="panel"><h2 class="panel-title">时间线（${tl.length}）</h2>
    <ul class="timeline">${tl.slice(0, 20).map(t => `<li><span class="dim">${esc((t.at || '').slice(0, 16).replace('T', ' '))}</span> ${esc(labels[t.type] || t.type)}${t.severity ? ` <span class="pill">${esc(t.severity)}</span>` : ''}</li>`).join('')}</ul>
  </section>`
}

function storyEvidence (data) {
  const claims = arrayOf(data.claims).slice(0, 20)
  if (!claims.length) return ''
  return `<section class="panel"><h2 class="panel-title">证据与主张（L2）</h2>
    <ul class="evidence-list">${claims.map(c => `<li>
      <div class="ev-row"><span class="dim">${esc((c.confidence_pct ?? 0) + '%')}</span>${c.status === 'contested' ? '<span class="pill pill-bad">有争议</span>' : ''}<p class="ev-text">${esc(c.text)}</p></div>
      <div class="ev-actions"><button class="btn btn-sm" type="button" data-annot="claim" data-annot-id="${esc(c.id)}" data-annot-kind="wrong">这条错了</button>
      ${c.item_url ? `<a class="dim" href="${esc(safeUrl(c.item_url))}" target="_blank" rel="noopener noreferrer">原文</a>` : ''}</div>
    </li>`).join('')}</ul>
  </section>`
}

function storyResearch (story) {
  const r = story.research
  const c = story.research_contrast
  const render = (kind, data, label, hint) => `<div class="research-block">
    <div class="research-head"><b>${esc(label)}</b>
      <button class="btn btn-sm" type="button" data-research="${esc(story.id)}" data-research-kind="${kind}">${data ? '重新生成' : '生成'}</button></div>
    ${data ? `<article class="research-body">${esc(data.content || '').replace(/\n/g, '<br>')}</article>` : `<p class="dim">${esc(hint)}</p>`}
  </div>`
  return `<section class="panel"><h2 class="panel-title">深度报告（L4）</h2>
    ${render('deep', r, '深度简报', '把时间线、事实与争议整理成一份深度简报。')}
    ${render('contrast', c, '多源对照', '一手 / 分析 / 反方观点的对照与分歧。')}
  </section>`
}

function storyArticle(data) {
  const story = { ...data.story, body: data.body || '' }
  const sections = arrayOf(data.sections)
  const spans = arrayOf(data.fact_spans)
  const facts = arrayOf(data.facts)
  const items = arrayOf(data.items)
  const toc = sections
    .map((s, i) => `<li><a href="#${esc(s.id)}">${esc(s.heading || `第 ${i + 1} 节`)}</a></li>`)
    .join('')
  const srcList = items
    .slice(0, 20)
    .map((it) => `<li><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer">${esc(clip(it.title, 40))}</a><span class="dim">${esc(it.source || '')}</span></li>`)
    .join('')
  const bodyHtml = renderStoryBody(story.body, spans)
    .replace(/<h2 class="story-h2">/g, (m) => m) // 保持
  const anchorCount = spans.reduce((a, s) => a + arrayOf(s.facts).length, 0)
  return `
  ${storyNotice(story, data.related_stories)}
  ${storyDelta(data)}
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>${esc(story.category || '故事')}</span></nav>
  <header class="story-head">
    <h1 class="story-title">${esc(story.title)}</h1>
    <div class="story-meta">
      ${story.category ? `<span class="pill pill-cat">${esc(story.category)}</span>` : ''}
      ${story.qa ? `<span class="pill ${story.qa.score >= 85 ? 'pill-ok' : story.qa.score >= 70 ? 'pill-warn' : 'pill-bad'}" title="覆盖率 ${Math.round((story.qa.coverage || 0) * 100)}%｜重复率 ${Math.round((story.qa.dup_rate || 0) * 100)}%｜矛盾 ${story.qa.conflicts || 0}">质检 ${Math.round(story.qa.score || 0)}</span>` : '<span class="pill pill-warn">未质检</span>'}
      ${(data.story.pending_updates?.count || 0) === 0 ? `<span class="pill pill-ok" title="没有比你上次看到的更新的内容">已追平最新</span>` : `<span class="pill pill-new">有 ${data.story.pending_updates.count} 条未读更新</span>`}
      <span class="m"><b>${esc(story.body.length)}</b> 字</span>
      <span class="m"><b>${esc(sections.length)}</b> 节</span>
      <span class="m"><b>${esc(facts.length)}</b> 个事实</span>
      <span class="m dim">${esc(anchorCount)} 处锚点 · 悬停句子可看证据</span>
      ${story.updated_label ? `<span class="m dim">更新于 ${esc(story.updated_label)}</span>` : ''}
    </div>
  </header>
  <div class="story-grid">
    <aside class="side">
      <section class="panel">
        <h2 class="panel-title">目录</h2>
        <ul class="side-list">${toc || '<li class="dim">无章节</li>'}</ul>
      </section>
      <section class="panel">
        <h2 class="panel-title">事实（${esc(facts.length)}）</h2>
        <div class="fact-mini" id="fact-list">
          ${facts.slice(0, 40).map((f) => `<a class="fact-chip" href="#" data-fact="${esc(f.id)}" title="${esc(clip(f.text, 80))}">${esc(f.id)}<span class="dim">${esc(f.support)}</span></a>`).join('')}
          ${facts.length > 40 ? `<p class="dim">…共 ${esc(facts.length)} 条</p>` : ''}
        </div>
      </section>
      ${relatedList(data.related_stories)}
      <section class="panel">
        <h2 class="panel-title">来源（${esc(items.length)}）</h2>
        <ul class="side-list">${srcList || '<li class="dim">无来源</li>'}</ul>
      </section>
    </aside>
    <div class="main-col">
      <article class="story-body" data-story-id="${esc(story.id)}">${bodyHtml}</article>
      ${storyAnnotationBar(story)}
      ${storyStance(story)}
      ${storyTimeline(story)}
      ${storyEvidence(data)}
      ${storyResearch(story)}
      <aside class="fact-panel" id="fact-panel" hidden>
        <div class="fact-panel-head"><span class="fact-panel-id"></span><button class="fact-panel-close" type="button" aria-label="关闭">×</button></div>
        <p class="fact-panel-text"></p>
        <div class="fact-panel-support"></div>
        <ul class="fact-panel-evidence"></ul>
      </aside>
    </div>
  </div>`
}

export function storyMain(data) {
  if (!data || !data.story) {
    return `<div class="empty"><p class="empty-title">事件不存在</p><p class="empty-sub">该 story id 在库里查不到。</p><p><a class="btn" href="/">返回记忆流</a></p></div>`
  }
  if (data.has_body && data.body) return storyArticle(data)
  const story = data.story
  const items = arrayOf(data.items)
  const entities = arrayOf(data.entities)
  const itemIndex = items
    .map(
      (item) =>
        `<li><a href="#${encodeURIComponent(`item-${item.id}`)}">${esc(clip(item.title, 42))}</a><span class="dim">${esc(item.claim_count ?? 0)}</span></li>`
    )
    .join('')
  const entityChips = entities.length
    ? entities
        .map(
          (e) =>
            `<a class="ent-chip" href="/entity/${encodeURIComponent(e.id)}">${esc(e.name)}<span class="dim">${esc(e.count)}</span></a>`
        )
        .join('')
    : '<p class="empty-inline">没有关联实体。</p>'

  const spanLabel =
    story.first_label && story.last_label && story.first_label !== story.last_label
      ? `${story.first_label} → ${story.last_label}`
      : story.last_label || story.first_label || ''

  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>事件</span></nav>
  <header class="story-head">
    <h1 class="story-title">${esc(story.title)}</h1>
    <div class="story-meta">
      <span class="pill">${esc(story.status_label || '—')}</span>
      ${story.validated ? '<span class="pill pill-ok">已验证</span>' : ''}
      <span class="m"><b>${esc(story.item_count ?? 0)}</b> 条目</span>
      <span class="m"><b>${esc(story.claim_count ?? 0)}</b> claim</span>
      ${story.meta_claim_count ? `<span class="m dim">（已隐藏 ${esc(story.meta_claim_count)} 条元信息）</span>` : ''}
      ${spanLabel ? `<span class="m dim">${esc(spanLabel)}</span>` : ''}
      ${story.updated_label ? `<span class="m dim">更新于 ${esc(story.updated_label)}</span>` : ''}
    </div>
    ${story.anchor ? `<p class="story-anchor">锚点：${esc(story.anchor)}</p>` : ''}
    ${story.summary_seed ? `<p class="story-seed dim">初版骨架：${esc(story.summary_seed)}</p>` : ''}
  </header>
  <div class="story-grid">
    <aside class="side">
      <section class="panel">
        <h2 class="panel-title">条目（${esc(items.length)}）</h2>
        <ul class="side-list">${itemIndex || '<li class="dim">无条目</li>'}</ul>
      </section>
      <section class="panel">
        <h2 class="panel-title">涉及实体（${esc(entities.length)}）</h2>
        <div class="ent-chips">${entityChips}</div>
      </section>
    </aside>
    <div class="main-col">
      <div class="claims-toolbar">
        <h2 class="section-title">主张（${esc(story.claim_count ?? 0)}）</h2>
        <div class="seg seg-sm" role="group" aria-label="claim 排序">
          <button class="seg-item active" type="button" data-claim-mode="item">按条目</button>
          <button class="seg-item" type="button" data-claim-mode="time">按时间</button>
        </div>
      </div>
      <div id="claims-root">${renderStoryClaims(data, 'item')}</div>
      ${story.claims_truncated ? `<p class="empty-inline">claim 过多，仅展示前 800 条。</p>` : ''}
    </div>
  </div>`
}

/* ── 实体页 ───────────────────────────────────────────────────── */

function entityClaim(c) {
  return `<li class="claim claim-compact">
    <div class="claim-row">
      <div class="claim-badges">
        ${kindHtml(c)}
        ${dotsHtml(c.confidence_pct)}
        ${timeHtml(c)}
      </div>
      <p class="claim-text">${esc(c.text)}</p>
      <p class="claim-src">
        ${c.item_title ? `<a href="${esc(c.story_id ? `/story/${encodeURIComponent(c.story_id)}#${encodeURIComponent(`claim-${c.id}`)}` : '#')}">${esc(clip(c.item_title, 46))}</a>` : '<span class="dim">来源条目未知</span>'}
        ${c.item_author ? `<span class="dim">· ${esc(c.item_author)}</span>` : ''}
        ${c.item_published_label ? `<span class="dim">· ${esc(c.item_published_label)}</span>` : ''}
      </p>
      <div class="claim-foot">${evidenceHtml(c)}</div>
    </div>
    <div class="claim-side">${frameThumbHtml(c)}</div>
  </li>`
}

export function entityMain(data) {
  if (!data || !data.entity) {
    return `<div class="empty"><p class="empty-title">实体不存在</p><p class="empty-sub">该 entity id 在库里查不到。</p><p><a class="btn" href="/">返回记忆流</a></p></div>`
  }
  const entity = data.entity
  const stats = data.stats || {}
  const groups = arrayOf(data.groups)
  const stories = arrayOf(data.stories)
  const alias = arrayOf(entity.aliases).filter(Boolean)

  const groupsHtml = groups.length
    ? groups
        .map(
          (g) => `<section class="pred-group">
        <h2 class="pred-title"><span class="pred-name">${esc(g.predicate_label)}</span><span class="pred-count">${esc(g.count)} 条</span></h2>
        <ul class="claims">${arrayOf(g.claims).map(entityClaim).join('')}</ul>
      </section>`
        )
        .join('')
    : `<p class="empty-inline">该实体还没有关联的 claim（可能是 UP 主类实体，尚未做主张归因）。</p>`

  const storiesHtml = stories.length
    ? stories
        .map(
          (s) => `<li><a href="${esc(safeUrl(s.url))}">${esc(clip(s.title, 40))}</a>
            <span class="dim">${esc(s.item_count)} 条目 · ${esc(s.claim_count)} claim${s.updated_label ? ` · ${esc(s.updated_label)}` : ''}</span></li>`
        )
        .join('')
    : '<li class="dim">没有关联事件。</li>'

  return `
  <nav class="crumbs"><a href="/">记忆流</a><span class="sep">/</span><span>实体</span></nav>
  <header class="story-head">
    <h1 class="story-title">${esc(entity.name)}</h1>
    <div class="story-meta">
      <span class="pill pill-type">${esc(entity.type_label || entity.type || '未知类型')}</span>
      <span class="m"><b>${esc(stats.claim_count ?? 0)}</b> claim</span>
      <span class="m"><b>${esc(stats.story_count ?? 0)}</b> 事件</span>
      <span class="m"><b>${esc(stats.item_count ?? 0)}</b> 条目</span>
      <span class="m"><b>${esc(stats.predicate_count ?? 0)}</b> 关系</span>
    </div>
    ${alias.length ? `<p class="story-anchor">别名：${alias.map((a) => esc(a)).join(' / ')}</p>` : ''}
    <p class="story-anchor dim">entity id：<code>${esc(entity.id)}</code></p>
  </header>
  <div class="story-grid story-grid-main">
    <div class="main-col">
      <h2 class="section-title">事实（按关系分组）</h2>
      ${groupsHtml}
    </div>
    <aside class="side">
      <section class="panel">
        <h2 class="panel-title">相关事件（${esc(stories.length)}）</h2>
        <ul class="side-list side-list-story">${storiesHtml}</ul>
      </section>
    </aside>
  </div>`
}

/* ── 搜索面板（客户端渲染）────────────────────────────────────── */

// 在原文上找命中，再分段转义：不会把 <mark> 插进实体（&amp;）或上一轮插入的标签里
export function highlight(text, q) {
  const raw = String(text ?? '')
  const terms = [...new Set(String(q || '').trim().split(/\s+/).filter((t) => t.length >= 2))]
  if (!terms.length) return esc(raw)
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
  let out = ''
  let pos = 0
  for (const m of raw.matchAll(re)) {
    if (!m[0]) continue
    out += esc(raw.slice(pos, m.index)) + `<mark>${esc(m[0])}</mark>`
    pos = m.index + m[0].length
  }
  return out + esc(raw.slice(pos))
}

export function searchResultsHtml(data) {
  const q = data?.q ?? ''
  const results = arrayOf(data?.results)
  const items = arrayOf(data?.items)
  const modeNote = data?.mode === 'like' ? '（短词/字面匹配）' : data?.mode === 'fts' ? '（trigram 全文索引）' : ''
  const head = `<div class="sp-head">
      <span>“${esc(q)}” 命中 <b>${esc(results.length)}</b> 条 claim${modeNote}</span>
      <button class="sp-close" type="button" aria-label="关闭搜索">×</button>
    </div>`

  if (!results.length && !items.length) {
    return `${head}<p class="sp-empty">没有命中。试试更短的词，比如「混合推理」「Harness」「反物质」。</p>`
  }

  const rows = results
    .map(
      (r) => `<li class="sp-row">
        <div class="sp-badges">${kindHtml(r)}${dotsHtml(r.confidence_pct)}${timeHtml(r)}</div>
        <a class="sp-text" href="${esc(safeUrl(r.url || r.story_url))}">${highlight(r.text, q)}</a>
        <div class="sp-meta">
          ${r.story_title ? `<span class="sp-story">事件：${esc(r.story_title)}</span>` : ''}
          ${r.item_title ? `<span class="dim">${esc(clip(r.item_title, 40))}</span>` : ''}
          ${r.item_author ? `<span class="dim">· ${esc(r.item_author)}</span>` : ''}
        </div>
      </li>`
    )
    .join('')

  const itemRows = items.length
    ? `<div class="sp-section-title">标题命中的条目</div><ul class="sp-items">${items
        .map(
          (it) =>
            `<li><a href="${esc(safeUrl(it.url))}">${highlight(clip(it.title, 60), q)}</a>
              <span class="dim">${esc(it.author || '')}${it.published_label ? ` · ${esc(it.published_label)}` : ''}</span></li>`
        )
        .join('')}</ul>`
    : ''

  return `${head}<ul class="sp-rows">${rows}</ul>${itemRows}`
}

export function searchLoadingHtml(q) {
  return `<div class="sp-head"><span>正在搜索 “${esc(q)}”…</span><button class="sp-close" type="button" aria-label="关闭搜索">×</button></div>`
}

/* ── 转写面板（客户端）───────────────────────────────────────── */

export function transcriptHtml(data) {
  if (!data || !data.item) return `<div class="drawer-body"><p class="empty-inline">该条目不存在。</p></div>`
  const item = data.item
  const segments = arrayOf(data.segments)
  const rows = segments
    .map(
      (s) => `<li class="seg"><time>${esc(s.time_label)}</time><p>${esc(s.text)}</p></li>`
    )
    .join('')
  return `<div class="drawer-head">
      <h2>${esc(item.title)}</h2>
      <div class="drawer-meta dim">
        ${item.author ? `UP：${esc(item.author)}` : ''}
        ${item.published_label ? ` · ${esc(item.published_label)}` : ''}
        ${item.duration_label ? ` · 时长 ${esc(item.duration_label)}` : ''}
        ${data.segment_total ? ` · 共 ${esc(data.segment_total)} 段` : ''}
        ${data.claim_count !== undefined ? ` · ${esc(data.claim_count)} claim` : ''}
      </div>
      <button class="drawer-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="drawer-body">
      ${rows ? `<ol class="segs">${rows}</ol>` : '<p class="empty-inline">没有转写分段。</p>'}
      ${data.segment_total > segments.length ? `<p class="empty-inline">仅预览前 ${esc(segments.length)} 段。</p>` : ''}
    </div>`
}

/* ── 错误页 ───────────────────────────────────────────────────── */

export function errorMain({ title = '页面不存在', detail = '', href = '/' } = {}) {
  return `<div class="empty">
      <p class="empty-title">${esc(title)}</p>
      ${detail ? `<p class="empty-sub">${esc(detail)}</p>` : ''}
      <p><a class="btn" href="${esc(href)}">返回记忆流</a></p>
    </div>`
}
