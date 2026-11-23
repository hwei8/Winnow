# ADR 0002 — Schema 作为代码，迁移脚本只作存档

- 状态：已采纳
- 相关：`src/shared/schema.mjs`、`scripts/migrations/`、docs/data-model.md

## 背景

schema 经历了 16 个版本的增量迁移（`07_migrate` … `100_schema_p4`）。迁移脚本对**当时的库**是必要的，但对新用户毫无用处：没有人会从 v1 一路爬到 v16。

## 决策

1. 把线上库的最终形态导出成一份**幂等**的建库 SQL（全部 `CREATE ... IF NOT EXISTS`），放进 `src/shared/schema.mjs`；
2. `SCHEMA_VERSION` 与 `PRAGMA user_version` 对齐；
3. 历史迁移脚本移到 `scripts/migrations/`，标注"只读存档，不再执行"；
4. 未来的 schema 变更 = 改代码 + 提升版本号 + 写一次性迁移脚本（不入库）+ 补一条 ADR。

## 后果

- ✅ 新用户 `npm run db:init` 一步建库；
- ✅ 测试可以在临时目录建完全一样的库；
- ✅ schema 只有一处真相，不会出现"代码假设有列、库里没有"；
- ⚠️ 老库升级需要人工跑脚本（本项目只有一个用户，可接受）。

## 备选

| 方案 | 为什么不选 |
|---|---|
| 保留全量迁移链 | 新用户要跑 16 次，且历史脚本有硬编码路径 |
| 引入 ORM / 迁移框架 | 一个 SQLite 文件 + 50 张表，框架成本高于收益 |
