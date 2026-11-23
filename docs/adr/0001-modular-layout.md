# ADR 0001 — 按业务域拆分的模块化布局

- 状态：已采纳（2026-11-22）
- 相关：docs/architecture.md

## 背景

代码最初是一串数字脚本（`01_ingest.mjs` … `100_schema_p4.mjs`）加一个共享的 `lib/`。能跑，但：

- 看不出哪段代码属于哪个业务；
- `lib/` 变成杂物间，任何模块都能 import 任何东西；
- 文档、数据、产物、备份混在同一层，新人（包括三个月后的我）无法上手。

## 决策

按**业务域**分层，依赖单向：

```
web, cli → domains/{ingest,knowledge,story,memory,insights,delivery,ops} → providers → shared
```

- `shared` 只放基础设施（config / db / schema / pool），不认识业务概念；
- `providers` 是外部能力的薄封装，全部可通过环境变量替换；
- `domains` 内高内聚，域之间只通过显式函数调用；
- 命令与展示（`cli` / `web`）不含业务规则。

## 后果

- ✅ 想改"更新策略"只需看 `domains/story/`；
- ✅ 想换模型只改 `providers/`；
- ✅ 测试可以只 load 纯函数域，不碰网络；
- ⚠️ 域之间偶尔需要"借"函数（如 `story` 用 `knowledge/facts`），要克制，必要时下沉到 `shared`；
- ⚠️ 目录变深，脚本路径变长（用 `npm run` 与 `package.json` 缓解）。

## 备选

| 方案 | 为什么不选 |
|---|---|
| 保持数字脚本 + `lib/` | 三个月后没人能读懂顺序与依赖 |
| 按技术层拆（models/services/routes） | 本项目主要复杂度在业务规则，按技术拆会把一个规则撕成三处 |
| monorepo（多包） | 单进程单库，拆包只增加构建成本 |
