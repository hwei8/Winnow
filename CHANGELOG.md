# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化。

## [Unreleased] — 审计修复与复核补丁

完整说明见本地 `reports/FIX-REPORT.md`（不入库）。

### 安全
- Web 默认只监听 `127.0.0.1`；新增 Host 白名单（防 DNS rebinding）、写接口 JSON + 同源校验（防 CSRF）、可选 `WINNOW_WEB_TOKEN`、CSP 与 `X-Frame-Options`
- 出站抓取护栏 `shared/net.mjs`：只允许公网 http(s)，逐跳校验重定向，响应体上限 5MB（防 SSRF）
- 模板外链协议白名单 `safeUrl`（`javascript:` 等被中和）；搜索高亮改为先匹配后转义
- HTML/RSS 解析改为线性扫描 `ingest/html.mjs`，消除 O(n²) 正则（恶意页面 12.5s → 8ms），输出与旧实现逐字节一致
- Telegram 默认纯文本发送（标题含 `& < >` 不再导致推送失败或注入链接）

### 修复
- 前端 `app.js` 引用的 `/templates.mjs`、`/fmt.mjs` 现在由服务端提供（此前 404，全部交互失效）；删除重复绑定的事件处理器
- `/api/ingest-run` 指向真实的 `cli/worker.mjs`（此前指向不存在的文件）
- `generate-stories` 的 `story_fact.section_id` 格式错误导致 consolidate 丢锚点；新增 `npm run db:repair` 修复存量（10,744 行）
- 事实归簇：同批去重、Jev 故障即停（不再批量制造重复 fact）、编号在写事务内分配；三份重复实现合并为一份
- **复核补丁**：抓正文统一走 `ingest/page.mjs` 的 `loadArticle()`，直连抛错也走 DeepSeek 兜底（此前抛错直接丢条目）
- **复核补丁**：`db:repair` 除裸 `secN` 外，再按字符区间补 `section_id`（存量 489 行 / 29 篇）；
  `cli/realign.mjs` 写入锚点时一并写章节归属，并对"偏移越界"的 Story 触发重对齐（此前会跳过、且写入 NULL）
- **复核补丁**：QA 增加锚点健康度（`anchors_stale` / `anchors_orphan`），越界按比例扣分，最多 −8
- **复核补丁**：`WINNOW_WEB_TOKEN` 在文档中改为"局域网访问强烈建议"（实际行为是告警而非强制）
- `story` / `item` 写入改为 upsert，不再清空未列出的列，已判重的 Story 不会被重新生成"复活"
- 入库队列原子领取 + 卡死任务回收；worker 用机读报告判断成败
- `discover` / `hot` / `extract-facts` / `link-stories` / `im-capture` 的路径与密钥读取（重构后失效）
- 所有写事务改为 `BEGIN IMMEDIATE`，写连接设置 `busy_timeout`
- daemon：真正的单实例锁、本地日期（修复东八区一天跑两次）、子进程输出缓冲 64MB
- LLM 只重试暂时性错误；`LLM_CHAT_MODEL` 生效
- Jev 不可用时更新分级标记为 degraded 并跳过执行，而不是悄悄按 P3/P4 处理
- `status` 为 NULL 的 claim 不再被 `status != 'meta'` 过滤掉
- 实体解码支持 BMP 以外字符；`F\d{5}` 编号清洗支持 6 位以上编号

### 变更
- 7 个导入即执行的脚本从 `domains/` 移到 `cli/`：`ingest`、`finalize`、`apply-policy`、`apply-consolidate`、`qa`、`policy-regression`、`realign`
- 移除未使用的 `sqlite-vec` 依赖；`engines` 改为 `>=22.16.0`（schema 依赖 FTS5；22.13.0 内置 SQLite 没有 FTS5，CI 矩阵含 22.16.0 守住下限）
- `npm run check` 改为 `tests/check-syntax.mjs`：语法 + 相对 import + 脚本路径解析
- 测试 19 → 55 个

## [0.2.0] — 2026-11-22

模块化重构，GitHub Ready。

### 新增
- 按业务域分层的目录结构：`shared / providers / domains / cli / web`
- `src/shared/schema.mjs`：schema 作为代码（v16，幂等建库）
- `src/shared/config.mjs`：路径与密钥的唯一入口，支持 `.env`
- `config/feeds.json`：源清单外置（17 个源）
- 测试套件（`node:test`，19 个用例，无需 key）
- 文档：architecture / data-model / pipeline / memory / briefing / web / operations / development + 7 条 ADR
- CI：语法检查 + 测试 + `npm audit`

### 变更
- 数字脚本（01–100）重命名为语义化模块，业务规则归入 `domains/`
- Web 查询层拆分为 `db / shared / queries{pages,story,search,item}`
- embedding 默认走 OpenRouter `baai/bge-m3`（本地 llama.cpp 变为可选）
- 历史迁移脚本移入 `scripts/migrations/`（只读存档；后已移除，见 git 历史）

### 修复
- `llm.mjs` 顶层读密钥导致无法在无凭据环境 import
- 新源入库缺 `source` 行导致外键失败
- 新源 Story 未生成（过滤条件遗漏）

## [0.1.0] — 2026-11-12

首个可用版本：采集 → 抽取 → 归簇 → Story 成稿 → 更新策略 → QA → 简报 → Web。
