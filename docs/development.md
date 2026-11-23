# 开发

## 目录

```
src/
  shared/      配置 / db / schema / 并发池        （不认识业务）
  providers/   llm embed jev search telegram
  domains/     ingest knowledge story memory insights delivery ops
  cli/         命令入口（编排，不含业务规则）
  web/         只读 SSR + 极少量写入
config/        feeds.json、search_queries.txt
scripts/       check-syntax.mjs、migrations/（历史存档）
tests/         node:test
docs/          architecture / data-model / pipeline / adr / design / reports
data/  out/    运行时产物（gitignore）
```

## 约定

- **ESM + 无分号**（仓库现有风格：`import` 结尾不带 `;`，与 `node:test` 示例一致）；
- 每个模块**文件头一行**说明职责（`// domains/story/policy.mjs — …`）；
- 导出函数优先，副作用集中在 `cli/` 与 `web/server.mjs`；
- 所有路径与密钥从 `shared/config.mjs` 取，**不要**在模块里写死；
- 业务规则（阈值、分级、门禁）必须带注释说明「为什么是这个数」；
- 中文注释，代码标识符英文。

## 依赖规则

```
web, cli  →  domains  →  providers  →  shared
```

反向 import 是 bug。域之间不要互相 import 内部状态——通过函数调用，参数显式传递（`{ db, ... }`）。

## 加一个采集源

1. 在 `src/domains/ingest/adapters/` 新建 `xxx.mjs`，实现契约：

```js
export const ADAPTER = {
  id: 'xxx',
  name: '显示名',
  sourceId: 'src:xxx',
  mediaKind: 'article',
  async list ({ limit }) { /* 返回 [{ url, title, publishedAt, ... }] */ },
  async fetch (ref) { /* 返回预归一化 { title, blocks, text } */ },
  normalize (ref, page) { /* 若 fetch 未归一化则实现 */ },
  async health () { /* 可选 */ }
}
```

2. 注册：`src/domains/ingest/registry.mjs` 的 `REGISTRY`；
3. 若是 RSS，**优先**只在 `config/feeds.json` 加一条（无需写代码）；
4. 跑 `npm run collect -- --adapter=xxx --limit=3` 验证；
5. 用 `node src/cli/feed-score.mjs --only=<id>` 看正文/重复率评分，决定 tier。

## 改 schema

1. 改 `src/shared/schema.mjs`（唯一权威），提升 `SCHEMA_VERSION`；
2. 写一次性迁移脚本对现有库做 `ALTER TABLE`（脚本不入库，放 `scripts/migrations/` 存档）；
3. `node --test tests/schema.test.mjs` 确认新库可建；
4. 在 `docs/adr/` 补一条决策。

## 测试

```bash
npm test                       # 全部（不需要任何 key）
npm test -- tests/feed.test.mjs
```

现有覆盖：

| 测试 | 覆盖 |
|---|---|
| `tests/feed.test.mjs` | RSS/Atom 解析、HTML→blocks、引文定位 |
| `tests/schema.test.mjs` | 空库建表、幂等、基本写入 |
| `tests/config.test.mjs` | env 解析、路径辅助 |
| `tests/feeds.test.mjs` | `config/feeds.json` 结构校验 |
| `tests/web-queries.test.mjs` | 查询层在空库上不炸（子进程隔离） |

涉及网络的测试（LLM / Jev / 搜索）**不进 CI**——用 `drill.mjs` 在本地演练降级。

## 调试技巧

```bash
# 单篇走一遍，看每步判定
ITEMS=item:xxx node src/domains/ingest/pipeline.mjs

# 只看链接判定
node src/cli/link-audit.mjs

# 用真实更新回放策略（不执行）
node src/domains/story/regression.mjs

# 打开 SQL
DEBUG_SQL=1 node src/cli/pipeline.mjs --limit=1    # 若模块支持
```

## 提交

- 一个提交一件事；
- 改行为要带上测试或文档；
- 提交信息用祈使句（`add`, `fix`, `drop`），可中可英；
- 不要提交 `data/`、`out/`、`.env`、`.secrets/`。

## 评审关注点

1. 这个改动会不会让 Story 丢信息？（门禁是否覆盖）
2. 新常量是拍的还是有依据？（注释里写清）
3. 失败路径有没有兜底？（重试 / 降级 / 回滚）
4. 有没有偷偷把业务规则塞进 `cli/` 或 `web/`？
