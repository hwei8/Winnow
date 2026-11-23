# 个人记忆层

新闻系统只解决「读什么」，这一层解决「记住什么、读到哪了、我不同意」。

## 三件事，三种粒度

| 你想做的 | 用哪个 | 落在哪 |
|---|---|---|
| **记下来**（想法、待办、引用、问题） | 捕获 `capture` | `/memory` 页 / CLI / Telegram |
| **记住我读到哪了** | 知识水位 `knowledge_state` | Story 页「标记已追平」 |
| **我不同意 / 这条错了** | 标注 `annotation` + `stance` | Story 页底部 |

设计上它们互不干扰：捕获是**你写的东西**，水位是**你的进度**，标注是**你的判断**。三者都不会被写进 Story 正文。

## 捕获（capture）

```bash
node src/cli/capture.mjs "这个思路可以用在索引层" --kind idea --intent "下次做检索时回看"
node src/cli/capture.mjs "问问供应商是否支持私有部署" --kind todo --review 2026-12-01
node src/cli/capture.mjs "这段话值得背" --kind quote --target story:rss:144
node src/cli/capture.mjs --due           # 到复核期的
node src/cli/capture.mjs --list
```

| 字段 | 说明 |
|---|---|
| `kind` | `idea` / `todo` / `quote` / `question` / `link` |
| `content` | 内容本身（纯文本） |
| `intent` | 为什么记（给未来的自己看） |
| `review_at` | 什么时候提醒我回看（`--due` 会列出来） |
| `target_type/id` | 挂到 Story / 实体 / 主题上 |
| `status` | `inbox` → `seen` / `done` / `archived` |

入口有三个：

1. Web `/memory` 页（表单 + 最近捕获 + 到期待复核）；
2. CLI `capture.mjs`；
3. Telegram：给 bot 发 `记 <内容>`（`cli/im-capture.mjs`，需与 DSH 的轮询二选一，避免 409）。

## 知识水位（knowledge_state）

三个级别，scope 可以是 `story` / `entity` / `topic`：

| level | 含义 | 效果 |
|---|---|---|
| `seen` | 看过 | 流里不再标「新」 |
| `known` | 已经知道这件事 | 简报里降权 |
| `ignored` | 不关心 | 直接从推荐里排除 |

`frontier_at` 是「已追平」的时间点。Story 页会显示：

> 自你上次阅读以来 **3** 条更新 · [标记已追平]

点一下，`frontier_at` 前进到最新，这篇就不再计入未读。这个时间界线**只前进**——除非你显式重置。

## 标注（annotation）与立场（stance）

Story 页底部的标注条：

| 操作 | 写入 | 后续影响 |
|---|---|---|
| 这条错了（针对某条 claim） | `annotation(kind=wrong)` | 该 claim `confidence −0.2`、`status = contested` |
| 同意 / 反对 | `stance` + `stance_revision` | 记录立场变化历史 |
| 已知道 / 已读 | `knowledge_state` | 影响简报权重与「新」标记 |

`/stance` 页可以看自己改过的立场，以及每次修正的时间。

**标注消费率**（`/audit`）衡量这些输入有没有真的被用上：`生效标注 / 总标注`。全部接口打通时是 100%。

## 三轴下探

Story 页除了正文，还有三条「往下钻」的路（`memory/depth.mjs`）：

| 轴 | 内容 | 成本 |
|---|---|---|
| **时间线** | 这篇 Story 的每次更新（`story_update`）与版本差异 | 免费（本地数据） |
| **证据** | 每条事实 → 支持的 claim → 原文引文（可定位、可标错） | 免费 |
| **L4 深研** | 按需生成 600–900 字深度分析，或多源对照 500–800 字 | 1 次 LLM，结果缓存在 `research` |

深研是**按需**的：没人点就不花钱，点过一次就存下来。

## 数据主权

- 所有记忆都在你自己的 SQLite 文件里，导出：`node src/cli/export.mjs`（JSON + 每日 Markdown）；
- 没有任何遥测；
- 唯一的外部请求是 providers（LLM / embedding / 搜索 / Telegram），且都可以换成本地端点。
