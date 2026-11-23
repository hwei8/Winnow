# 数据模型

数据库是一个 SQLite 文件（默认 `data/winnow.db`），schema 定义在 [`src/shared/schema.mjs`](../src/shared/schema.mjs)，版本 `PRAGMA user_version = 16`。

`npm run db:init` 建空库；`npm run db:stats` 看行数；`npm run db:backup` 做一致性快照（`VACUUM INTO`）。

## 全景

```
source ─┬─ item ─┬─ item_block            （原文分块，证据的物理位置）
        │        ├─ item_segment          （音视频转写片段）
        │        └─ claim ─┬─ claim_entity ─ entity
        │                  ├─ claim_evidence
        │                  └─ fact_id → fact ─┬─ fact_claim
        │                                      └─ story_fact ← story
        └─ topic ← item_topic                  story_section
                                               story_item
                                               story_source
                                               story_update / story_version / story_qa / story_link
```

## 核心四张表

### `item` —— 原文

一条抓到的内容。**永不修改正文**（只允许补抓：`fetch-titles` / 重新抽取）。

| 关键列 | 说明 |
|---|---|
| `id` | `item:<hash>` 或来源自己的 id |
| `source_id` → `source` | 哪个源 |
| `url`, `title`, `author`, `published_at/ts` | 元信息 |
| `media_kind` | `article` / `video` / `post` |
| `char_count`, `content_source` | 正文长度与来源（`feed-full` / `page` / `search` / `summary`） |
| `lang` | `zh` / `en` |

正文块在 `item_block(item_id, idx, kind, text, ...)`；全文检索用 `item_fts`（trigram）。

### `claim` —— 原子断言

从原文抽出的一句话事实，带**可定位的证据**。

| 关键列 | 说明 |
|---|---|
| `text` | 规范化断言 |
| `subject` / `predicate` / `object_text` | 结构化三元组 |
| `object_value_json` | 数值 / 时间等结构化值 |
| `kind` | `fact` / `statement` / `quote` / `meta` |
| `confidence` | 0–1，被标注纠错会下调 |
| `status` | `active` / `contested` / `superseded` / `unverified` |
| `asserted_at`, `world_from` / `world_to` | 断言时间与事件有效期 |
| `story_id` | 归属 Story（片段 Story 也有） |
| `fact_id` | 归簇后的记忆单元 |
| `embedding` | 1024 维向量（`Float32Array` blob） |

证据在 `claim_evidence(claim_id, excerpt, time_start, time_end, frame_id, verified, segment_from, segment_to, stance)`。
**不变量**：`excerpt` 必须能在对应 `item` 的文本中找到，否则 `verified = 0`（见 `knowledge/evidence.mjs`，实测可定位率 99.9%）。

### `fact` —— 记忆单元

语义相同的 claim 归簇后的代表。

| 关键列 | 说明 |
|---|---|
| `canonical_text` | 归一后的表述 |
| `support_count` | 有几个独立来源支持 |
| `first_seen`, `last_updated` | 时间跨度 |
| `superseded_by` | 被哪条事实推翻 |
| `category` | 主题分类 |

`fact_claim(fact_id, claim_id, similarity, decided_by)` 记录归簇依据（`embedding` / `jev`）。

### `story` —— 交付物

一篇可读的成稿。

| 关键列 | 说明 |
|---|---|
| `id` | `story:<source>:<hash>` |
| `title`, `title_original` | 中文标题 + 原文标题 |
| `body_md` | 正文（Markdown，带 H2 小节） |
| `category`, `category_confidence` | 主题 |
| `status` | `active` / `draft` / `archived` |
| `story_kind` | `full` / `snippet`（只知标题）/ `duplicate` |
| `merged_into` | 被并入哪篇（去重留痕） |
| `first_seen_ts`, `last_update_ts` | 生命周期 |
| `item_count`, `validated`, `anchor` | 统计与锚点状态 |

配套：

| 表 | 作用 |
|---|---|
| `story_section(story_id, order_idx, heading, char_start, char_end)` | 小节与字符区间（锚点的基础） |
| `story_fact(story_id, fact_id, section_id, char_start, char_end, role)` | 事实在小节中的位置 |
| `story_item(story_id, item_id)` | 这篇 Story 用了哪些原文 |
| `story_source(story_id, source_id)` | 涉及哪些源 |
| `story_update(story_id, at, change_type, detail_json, severity, action, reason)` | 更新日志 + 策略判定结果 |
| `story_version(story_id, at, body_md, title, reason, qa_score)` | 重写前的快照（可回滚） |
| `story_qa(story_id, score, dims_json, at)` | QA 打分与各维度明细 |
| `story_link(source_story, target_story, relation, similarity, same_event, gap_json)` | Story 之间的语义关系 |

## 个人层

| 表 | 作用 |
|---|---|
| `capture(id, kind, content, intent, review_at, target_type/id, status)` | 「我要记住的」：想法、引用、待办、问题 |
| `capture_link(capture_id, target_type, target_id, relation)` | 记忆挂到 Story / 实体 / 主题 |
| `knowledge_state(scope, ref_id, level, frontier_at, source)` | 知识水位：`seen` / `known` / `ignored` + 追平时间点 |
| `annotation(target_type, target_id, kind, value, meta_json)` | 标注（known / wrong / agree / disagree / read） |
| `stance(target_type, target_id, position, at)` + `stance_revision` | 立场与修正历史 |
| `interest(topic_id, weight, at)` | 关注的主题 |
| `research(story_id, kind, body_md, at)` | 按需生成的 L4 深研 / 多源对照（缓存） |

## 采集与运维

| 表 | 作用 |
|---|---|
| `source(id, adapter_id, name, external_id, tier, lang)` | 源清单（adapter 首次入库时自动补齐） |
| `adapter_health(adapter_id, at, ok, detail)` | 采集健康 |
| `ingest_queue(id, url, status, tries, error, created_at)` | 待入库队列（`worker.mjs` 消费） |
| `ingest_decision(item_id, action, parent_id, facts_json, at)` | 每次入库的判定留痕 |
| `hot_entry` / `hot_rank` / `hot_crawl` | 热榜条目、排名历史、抓取记录 |
| `pipeline_run(id, at, kind, stats_json)` | 每次流水线运行的统计 |
| `briefing(id, date, window_hours, items_json, stats_json)` | 每日简报存档 |
| `beat_report(id, generated_at, findings_json)` | 覆盖地图报告 |
| `source_quality(source_id, score, verified_rate, contested_rate, corrected_rate, at)` | 源质量 |
| `metric_snapshot(at, metrics_json)` | 系统度量快照 |
| `revalidation(claim_id, reason, due_at, resolved_at)` | 周期重验证 |
| `ontology_proposal(id, kind, payload_json, status)` | 本体演化提案（实体合并 / 谓词复核） |
| `token_ledger(at, model, prompt_tokens, completion_tokens, cost)` | LLM 用量账本 |
| `cluster_audit`, `claim_dup`, `legacy_doc`, `frame` | 历史与辅助（可忽略） |

## 不变量清单

1. `item` 正文不可变；补抓会新建 `item_block` 并更新 `char_count`。
2. 每条 `claim` 最多属于一个 `fact`（`fact_claim` 唯一）。
3. `story_fact` 的 `char_start/char_end` 必须落在 `story.body_md` 内，否则 QA 报 `anchor_mismatch`。
4. `story_update` 只增不改；重写内容进 `story_version`。
5. `merged_into` 存在的 Story 不再出现在无限流里，但可直接访问。
6. `knowledge_state.frontier_at` 是「已追平」的时间界线，只前进不后退（除非显式重置）。

## 迁移

历史迁移脚本已从仓库移除（见 git 历史）。存量数据的幂等修复用 `npm run db:repair`。
新的 schema 变更方式：改 `src/shared/schema.mjs` → 提升 `SCHEMA_VERSION` → 在 `docs/adr/` 写一条决策 → 用一次性脚本对线上库做 `ALTER TABLE`（脚本不入库）。
