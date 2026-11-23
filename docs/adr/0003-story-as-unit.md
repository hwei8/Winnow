# ADR 0003 — Story 是一等公民，Claim 只是证据

- 状态：已采纳
- 相关：docs/data-model.md、docs/pipeline.md

## 背景

最初的模型是"claim 流"：抽出断言，按时间排给你看。实测不可读——人读的是**事件**，不是断言列表。

## 决策

- **阅读单位 = Story**：一篇连贯正文，有标题、有小节、有事实锚点；
- **记忆单位 = Fact**：语义相同的 claim 归簇后的单元，带 `support_count`；
- **证据单位 = Claim**：带原文引文与可定位 span；
- Story 是唯一有版本的东西（`story_version` 快照 + 回滚）；Fact 与 Claim 只增不改（除状态位）。

三者不互相冒充：Story 不能凭空写事实（必须来自 fact），fact 不能代替 claim 提供引文。

## 后果

- ✅ 可读性：读一篇而不是读四十条；
- ✅ 去重自然：七篇报道 = 一篇 Story + 七条支持；
- ✅ 可审计：每条事实回到原文；
- ⚠️ 需要重写与门禁（成本与复杂度都在这里）；
- ⚠️ 需要"这件事是否同一个事件"的判定（Jev），引入一次外部调用。

## 备选

| 方案 | 为什么不选 |
|---|---|
| claim 流 | 实测不可读，用户明确否决 |
| 纯摘要（每篇一段） | 跨源重复无法消除，等于换个 RSS 阅读器 |
| 只存向量做 RAG | 没有"版本/更新"概念，无法回答"这件事变了吗" |

## 补充（v17）：文档与实现的差距

ADR 与设计文档早期描述过几个**尚未实现**的机制，复核时逐条核对过，现明确记录，避免下一个人再"重新发现"：

- **并查集（union-find）事实聚类**：实现是单遍 leader 聚类（每个 fact 一条代表向量 + 同批 0.92 直接合并），
  没有传递闭包；修法见 `docs/improvement-plan.md` Phase 4。
- **SPO 三元组**：`fact.subject/predicate/object_text` 列存在但抽取不填；将来用作聚类 blocking key。
- **`world_from` / `world_to`**：字段存在、抽取不写；替代方案是每条 claim 一个 `event_date`。
- **链接候选阈值 0.62**：代码是 0.55（`knowledge/link.mjs` 的 `candTh`）。
- **QA 的跨 Story 重复**：只做了 char-trigram 近似重复，没有语义级跨 Story 去重。
