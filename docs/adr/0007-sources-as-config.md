# ADR 0007 — 源清单与检索主题放在配置里，而不是代码里

- 状态：已采纳
- 相关：`config/feeds.json`、`config/search_queries.txt`、`src/domains/ingest/adapters/rss.mjs`

## 背景

RSS 源最初硬编码在 adapter 里。加一个源要改代码、跑测试、重启；调一个主题词要改 JS 字符串。

## 决策

- `config/feeds.json` 存源清单（`sourceId / name / tier / lang / topic / full / urls`）；
- `config/search_queries.txt` 存搜索主题，语法支持 `[主题] !排除 site: -site: @N ~Nd`；
- 代码只负责**加载与校验**，不承载清单；
- 新源默认先用 `cli/feed-score.mjs` 评分（正文可得性 / 更新量 / 与库内重复率），达标再进配置。

## 后果

- ✅ 加源/删源不需要改代码，也不容易写错结构（有测试校验 JSON）；
- ✅ 主题词可以随时试错；
- ⚠️ 配置错误要到运行时才暴露（用 `tests/feeds.test.mjs` + `npm run collect -- --health` 兜住）；
- ⚠️ 复杂源（需要登录、需要 JS 渲染）仍然要写 adapter。

## 备选

| 方案 | 为什么不选 |
|---|---|
| 全放数据库（可 UI 管理） | 需要额外的管理界面与权限模型，现阶段过度 |
| 全放代码 | 改一个 URL 也要发版 |
