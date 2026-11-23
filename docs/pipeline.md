# 流水线

一条内容从「一个 URL」变成「一篇可以读的 Story」，中间要过五道关：抓、抽、簇、链、写。

```
url → item → claim* → fact* → (new | update) → story → qa
```

主入口：

```bash
npm run pipeline -- --adapter=rss --limit=20      # 采集模式
npm run pipeline -- --urls=URL1,URL2              # 直接给 URL
npm run pipeline -- --search --hot=3              # 搜索发现 + 热榜补充
```

`cli/pipeline.mjs` 依次调用：

```
cli/ingest.mjs → cli/finalize.mjs → cli/apply-policy.mjs → cli/apply-consolidate.mjs → cli/qa.mjs
```

任何一步失败不会中断后续步骤；结束时写 `out/reports/daily-YYYY-MM-DD.md` 与一行 `pipeline_run`。

## 1. 抓（ingest）

| 源 | 适配器 | 说明 |
|---|---|---|
| RSS（17 个） | `adapters/rss.mjs` | 源清单在 `config/feeds.json`。A 级 feed 自带全文；B 级只有摘要，抓页补全 |
| 热榜（11 个平台） | `adapters/newsnow.mjs` | 标题 + 排名 + 链接，必须有浏览器 UA |
| Hacker News | `adapters/hn.mjs` | Algolia API |
| 搜索发现 | `cli/discover.mjs` → `providers/search.mjs` | 按 `config/search_queries.txt` 的主题检索 |

正文获取顺序（`ingest/page.mjs`）：

1. 直连 HTML + `extract.mjs` 正文抽取（`FEED_MIN = 700` 字以上视为全文源，不再抓页）；
2. 不足 400 字**或直连抛错**（抖动 / 反爬）→ 搜索 API 的 `fetch` 兜底（`markdownToBlocks`）。两步都在 `ingest/page.mjs` 的 `loadArticle()` 里，入库只调它，避免各自分叉；
3. 仍不足 → 用 feed 摘要，标记 `content_source = summary`（会成为「片段 Story」）。

`ingest/registry.mjs` 的 `collect()` 会在入库前自动补 `source` 行，并写 `adapter_health`。

## 2. 抽（extract）

一次调用抽出**最多 15 条**原子事实，带 `subject / predicate / object / 时间 / 引文`，引文必须来自原文。

- 输入截断到 7000 字（长文只吃前段）；
- 时间归一：`asserted_at`（消息时间）与 `world_from/world_to`（事件有效期）；
- 失败重试 6 次，429 退避。

> 已知限制：固定 15 条上限让深度长文（SemiAnalysis 24k 字）与短讯一样只产出 15 条事实。下一步按字数动态放开（计划见 STATUS）。

## 3. 簇（knowledge/facts）

把新 claim 归入既有 fact，否则新建：

1. 向量召回 top-8（cosine ≥ 0.55）；
2. 逐对问 Jev：「这两句是不是同一个核心事实？」（返回 0–1，阈值 0.5）；
3. 并查集合并，写 `fact_claim`；
4. `fact.support_count` = 独立来源数。

向量缓存在 `out/story-vectors.json`，避免每次重嵌全库。

## 4. 链（knowledge/link）

这段新内容属于哪个 Story？

| 信号 | 阈值 |
|---|---|
| 正文向量相似（top-5） | cosine ≥ 0.62 |
| Jev `same_event` | ≥ 0.65 才算候选父 |
| 事实覆盖（已覆盖判定） | 缺口事实需 cosine < 0.85 |
| 事实亲和度 | 新事实与父 Story 事实簇的重合比例 |

判定结果：

| 结果 | 含义 | 后续 |
|---|---|---|
| `new` | 新事件 | 建新 Story（`finalize.mjs`） |
| `update` | 同一事件的新进展 | 进策略分级 |
| `duplicate` | 同一事件的重复报道 | 挂 `merged_into`，不生成新 Story |
| `overlap` / `related` | 部分重叠 | 记 `story_link`，不合并 |

规范化：多个候选父都合理时，**优先选最大且最完整的 Story**（`same_event ≥ 0.65`），避免信息被并进小结。

## 5. 写（story）

### 更新分级 `story/policy.mjs`

| 级别 | 触发 | 动作 |
|---|---|---|
| **P0** | 撤回 / 事实矛盾 / 主体否认 | 全量重写 + `supersede` 旧事实 |
| **P1** | 主线变化（标题重叠 ≥ 0.45 且命中状态词：罢免/辞职/解雇/关闭/停产/终止/破产/退市/被捕/获释/收购完成/获批…，或 Jev lede 判定 ≥ 0.55） | 定向重写（或拆篇） |
| **P2** | 累积：追加节 ≥ 2 且 追加比例 > 0.30 且 缺口 ≥ max(6, facts × 5%) | 先尝试节合并，不行再重写 |
| **P3** | 有缺口但不改主线 | 追加一节「最新进展」 |
| **P4** | 无实质缺口 | 什么都不做，只记 `story_update` |

分级的目的一句话：**只在语义需要时动正文**——每次更新都重写既丢信息也烧钱。

### 重写门禁

| 场景 | 覆盖率 | 长度 | 重复率 | 其他 |
|---|---|---|---|---|
| 定向重写（按节） | 每节 ≥ 0.85 | 全局 ≥ 0.85 且新长度 ≥ 0.85 旧 | dup ≤ 0.20 且 delta ≤ 0.10 | 受影响小节 ≤ max(2, 40%) |
| 全量重写 | ≥ 0.90 | ≥ 0.80 | — | 先快照 |
| 短 Story（<1000 字） | ≥ 0.95 | ≥ max(200, 35%) | ≤ 0.15 | — |

任何门禁不过 → **降级为追加**（append），绝不静默丢信息。重写前的快照在 `story_version`，可 `restore`。

### 节合并 `story/consolidate.mjs`

针对「越追加越乱」的 Story：把多个「最新进展」小节合成一节。

参数：`minSections=2, maxMerge=8, lenRatio=0.2（合并后长度不低于原 20%）, absMinLen=50, coverageTh=0.95, dupTh=0.15, retries=2`。
合并后自动跑 `knowledge/align.mjs` 的 `realignAnchors()` 重对齐锚点（批量版：`cli/realign.mjs`）。

## 6. QA

`cli/qa.mjs` 打分（0–100）：

| 维度 | 权重 | 说明 |
|---|---|---|
| 事实覆盖 | 22 | 正文覆盖了 Story 自己事实的比例 |
| 关键事实覆盖 | 18 | 高支持度事实是否出现 |
| 标题对齐 | 15 | 标题与正文主题一致 |
| 重复 | 20 | 与其他 Story 的正文/事实重复 |
| 长度 | 12 | 是否像一篇成稿（而不是一句话） |
| 信息密度 | 8 | 事实数 / 字数 |
| 冲突 | 5 | 同 Story 内自相矛盾 |

惩罚：`anchor_mismatch` −5；锚点偏移越界（正文重写后没 realign，页面上定位不到）按越界比例最多 −8；引用外部事实（不属于本 Story 的 item）最多 −5。

锚点健康度写进 `story_qa.issues_json`：`anchors_stale`（偏移越界行数）/ `anchors_orphan`（`section_id` 为 NULL 或指向不存在章节）。两者都该是 0，扫描见 `npm run db:repair`（按字符区间补归属）与 `npm run realign`。
封顶：`duplicate` 40 分，`snippet` 55 分——**不合格的类型不会因为"写得好看"而通过**。

## 7. 回归与观察

```bash
node src/cli/policy-regression.mjs        # 用真实 update 回放当前策略（只判定不执行）
node src/cli/link-audit.mjs               # Story 间事实重叠 / 过短 Story / 可合并对
npm run metrics                           # 追平率 / 冗余率 / QA 均分 / 简报选择率
```

## 幂等与重跑

- 同一 URL 重复入库不会产生第二篇 Story（`item.url` 唯一 + `duplicate` 判定）；
- `ingest_decision` 保证同一 item 的判定只写一次；
- `pipeline_run` 记录每次运行，便于对比。

## 成本

| 环节 | 单位成本 | 量级 |
|---|---|---|
| 抽取 | 1 次 chat / 篇 | 15k tokens |
| 归簇 | 向量 top-8 + Jev 判定 | 每次 3–8 次判定（免费通道） |
| 成稿 | 1 次 chat / 篇 | 6–10k tokens |
| 简报 | 1 次 chat / 天 | 4k tokens |

按每天 30 篇新 Story 估算：≈ 0.4M tokens/天，远低于个人预算。真正的瓶颈是**正文抓取**，不是钱。
