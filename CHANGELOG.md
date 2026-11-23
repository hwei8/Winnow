# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化。

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
- 历史迁移脚本移入 `scripts/migrations/`（只读存档）

### 修复
- `llm.mjs` 顶层读密钥导致无法在无凭据环境 import
- 新源入库缺 `source` 行导致外键失败
- 新源 Story 未生成（过滤条件遗漏）

## [0.1.0] — 2026-11-12

首个可用版本：采集 → 抽取 → 归簇 → Story 成稿 → 更新策略 → QA → 简报 → Web。
