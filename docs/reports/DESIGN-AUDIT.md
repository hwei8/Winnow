# 设计重审（P1.0）：速度 / 结构 / SQLite 向量性能

> 本文回答三个问题：① 为什么慢、瓶颈在哪、能否支撑每天几百到几千篇；② 结构为什么偏向 Claim、如何改成 Story 中心；③ 向量化后 SQLite 会不会成为瓶颈。
> 所有数字来自 `51_bench_infra.mjs` 实测（2026-11-11）。

## 0. 先认错：基础设施选择本应先沟通

Embedding 是记忆系统的地基，我却在没有确认可用性、没有问预算的情况下退回了词面比对。以后凡是涉及基础设施（模型、存储、算力）的选择，先出对比表 + 成本估算，经你确认再动手。

## 1. 速度：瓶颈不在抽取，在"串行 + 限流"

### 实测

| 阶段 | 实测 | 说明 |
|---|---|---|
| 正文抓取 | 1–3 s/篇（14 篇并发后 <10 s） | 网络为主 |
| **Claim 抽取** | **10.7 s/篇**（并发 8，8 篇总耗时 85.7 s） | 单次调用 10–90 s（含 reasoning），并发摊薄后 10.7 s/篇 |
| Embedding | **15 ms/条**（并发 4，320 条 4.9 s） | 32 条/批，1.2 s/批 |
| Jev 判定 | ~1–5 s/请求（每请求 20–25 个问题并行） | 一条 claim 8 个候选 → 约 0.4 请求/条 |

### 瓶颈定位

之前"14 篇花十几分钟"不是模型慢，是**我的实现串行 + 撞限流**：

1. `37_search_claims` 并发只有 4，且每篇内部按 chunk 串行；
2. opencode 端点频繁 429（overloaded），每次重试 3 次、退避 0.8–3 s，14 篇里累积了多次退避；
3. 没有把"多篇"和"多 chunk"合并成一个并发池。

### 容量模型（按实测）

| 并发 | 抽取吞吐 | 每天（24h） | 每天（工作 8h） |
|---|---|---|---|
| 8 | 0.093 篇/s | **8,000 篇** | 2,700 篇 |
| 16 | 0.19 篇/s | 16,000 篇 | 5,300 篇 |
| 32 | 0.37 篇/s | 32,000 篇 | 10,600 篇 |

其余阶段：1,000 篇/天 ≈ 20,000 条 claim → embedding 5 分钟、Jev 判定约 15–20 分钟（并发 16）。**都不是瓶颈。**

### 结论

**目标（几百到几千篇/天）完全可达**，前提是：

1. 抽取改为**全局并发池**（文章 × chunk 扁平化），并发 16–32，指数退避 + 429 感知；
2. 长文按块并行，不要串行；
3. 抽取与 embedding/判定**流水线化**（抽完即嵌入，不等整批）；
4. 失败重试与断点续跑（已有 item 级幂等，可复用）。

## 2. 结构：当前确实"Claim 中心"，必须改为 Story 中心

### 现状问题

- 数据库以 `claim` 为主表，`story` 只是一个"分组标签"（story_id 挂回 claim）；
- 交付物（Story）是事后用 claim 拼出来的 Markdown，**没有结构化落库**；
- 因此"阅读单位"和"记忆单位"混在一起，Story 的章节、引用、时间线都无法被查询/复用。

### 目标结构

```
Story（交付物，一等公民）
 ├── story(id, event_key, title, summary, status, first_seen, last_update, quality_score, version)
 ├── story_section(id, story_id, order_idx, heading, body_md, kind)      ← 阅读单位
 ├── story_fact(story_id, fact_id, section_id, order_idx, role)          ← Story 由哪些事实构成
 ├── story_update(id, story_id, at, change_type, fact_ids)               ← 事件演化（增量更新）
 └── story_source(story_id, item_id, role)                               ← 报道来源

Fact（记忆单位 / 大脑索引）
 ├── fact(id, canonical_text, subject, predicate, object_json,
 │         temporal_kind, validity_mode, confidence,
 │         first_seen, last_updated, superseded_by)
 ├── fact_claim(fact_id, claim_id, stance, observed_at)                  ← 事实的出处实例（多来源=多实例）
 └── fact_entity(fact_id, entity_id)

Claim（原始抽取，只作为证据）
 ├── claim(id, item_id, text, quote, char_start, char_end,
 │         embedding BLOB, temporal_kind, validity_mode, confidence)
 └── claim_evidence(claim_id, item_id, ...)

Item（原始内容）/ Entity / Annotation
```

### 读写路径

- **读”Story”**：`story → sections → story_fact → fact`，页面按节渲染，每段可追溯 fact 与原始 claim；
- **查/判新**：新 claim → embedding → 近邻 fact → Jev 判同 → 挂 `fact_claim`，不新建 fact；
- **增量更新**：新报道产生了新事实 → 追加 `story_fact` + `story_update`，Story 版本号 +1；
- **记忆检索**：只查 `fact` + `fact_entity` + 向量，不碰 claim 原文。

### 迁移步骤（不改数据，只加表 + 回填）

1. 建 `fact` / `fact_claim` / `story_section` / `story_fact` / `story_update` 表；
2. 用现有 134 个事实簇回填 `fact`，claim 挂 `fact_claim`；
3. 把 STORY-V2 拆成 `story` + `story_section` + `story_fact`；
4. Web 改为先读 story 表（fallback 到现有 story 标签）。

## 3. SQLite + 向量：够用，但要分区

### 实测（1024 维，k=8）

| 方案 | 1 万条 | 10 万条 | 估算 100 万条 |
|---|---|---|---|
| sqlite-vec（vec0） | 8 ms | 60 ms | ~600 ms |
| JS 内存暴力 | 5.5 ms | 54 ms | ~550 ms |
| 插入（sqlite-vec） | 200 ms/万条 | 1.4 s/10 万 | ~14 s/百万 |

两者都是**线性扫描**：sqlite-vec 目前不做 ANN。所以：

### 结论与策略

- **≤ 10 万 fact：SQLite 完全够用**（查询 < 60 ms，插入 1.4 s/10 万）。
- **10 万–100 万：分区 + 量化**
  - 按 `event/topic` 分区：判新只在"同一事件/主题"的候选子集里查（通常几千条），查询回到 < 10 ms；
  - int8 量化（4 倍内存压缩）+ 只对 top-50 候选做全精度重排；
- **> 100 万：** 上 ANN 侧车（hnswlib-node 或 sqlite-vec 的后续版本），SQLite 仍存结构化数据与向量，不替换。
- 每天 1,000–3,000 篇 ≈ 2–6 万 claim/天，一年 ~1,000 万 claim、事实数约 600 万——**仍在 SQLite 可行区间**，只要分区与量化到位。

## 4. 修正后的架构总览

```
采集（RSS/搜索/视频）
  → 正文抽取（lib/extract）
  → Claim 抽取（并发池 16–32，按块并行）
  → Embedding（bge-m3 / qwen3-embedding，按事件分区检索）
  → Fact 归并（近邻 top-8 + Jev 判定；抽取时归簇，不事后补）
  → Story 编辑（outline → sections → 引用 fact → QA）
  → 发布（story + sections + facts，版本化）
  → 记忆层（fact + fact_entity + embedding；供判新/检索/冲突/时效）
```

## 5. 待你确认的三件事

1. **Embedding 模型**：bge-m3（1024 维，$0.01/1M，实测召回 84%）还是 qwen3-embedding-8b（4096 维，$0.01/1M，81%）？我倾向 bge-m3（维度低 4 倍、存储省 4 倍、中文与多语言都够用）。
2. **Story 结构**：上面的 `story/story_section/story_fact/story_update` 是否符合你对"高度结构化"的预期？要不要加 `story_timeline`、`story_qa`（问答对）？
3. **并发与限流**：抽取消费的 opencode 端点经常 429，我会改成"全局并发池 + 429 感知退避"。若你希望更快，可以考虑把抽取切到 OpenRouter 上的 DeepSeek（成本约 $0.01/百万 token，但要走账）——这个需要你点头。
