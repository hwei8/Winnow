# Winnow 核心层改进最终方案

**输入**：`docs/reports/2026-11-core-layer-design-review.md`（可行性评审，525 行）+ `reports/IMPROVEMENT-PLAN.md`（Claude 的阶段方案，303 行）+ 我自己对 `bb86b9e` 代码与线上库的复核。
**基线**：`bb86b9e`，schema 16，DB `data/winnow.db`（2026-11-23 实测）。
**原则**：每条改动都必须有一个**先于改动存在的数字**；没有验收线的改动不进这个计划。

---

## 1. 基线（实测，不是估计）

| 指标 | 当前值 | 来源 |
|---|---|---|
| Story / 有正文 / 活跃 | 466 / 441 / 372 | `story` 表 |
| Fact / story_fact 锚点 | 6,990 / 12,160 | `fact` / `story_fact` |
| 日均新 Story（近 14 天） | **18.7**（262 篇） | `story.first_seen_ts` |
| support≥2 的 fact | 329 | `fact.support_count` |
| └ 其中真正跨 ≥2 条 item | **152（46%）** | `fact_claim→claim.item_id` |
| └ 其中真正跨 ≥2 个源 | **112（34%）** | 再 join `item.source_id` |
| 最大 Story 的锚点数 | 148（`story:pilot:nvidia-affair`，4,317 字 / 7 节） | `story_fact` |
| 链接判定引擎 | **zen-free-1.13**（`jev.mjs:11`，有 Zen key 就默认 Zen） | 代码 |
| same_event F1@0.6 / 最优 | zen 0.481 / **0.696@0.4**；OR 1.14 0.669 / **0.757@0.4**；local glide 0.712 / 0.948@0.4 | `docs/reports/LOCAL-DECISION-BENCH.md` |
| 硬负例误报率@0.4 | zen **0.333**；OR 0.35；local glide **0.55** | 同上（n=60） |
| QA 活跃均分 | 88.4（441 篇，含新增锚点罚分） | `story_qa` |

两个必须点明的推论：

1. **生产在用一个更弱的判定器**。Zen 免费档的 same_event 最优 F1 比 OR 1.14 低 6 个点、比本地 glide 低 25 个点，而代价只有每 20 问 $0.001151 —— 按 19 篇/天 × 约 5 次判定算，**切到 OR 1.14 的月账单约 $0.2**。这不需要等任何阶段。
2. **本地 glide 不是无脑更好**：F1 最高（0.948@0.4），但硬负误报率是三者里最差的（0.55）。它对"同实体不同事件"恰恰最不敏感——而这正是我们要修的失效模式。且新机器上 **8033/8034 两个本地端点现在都是 down 的**（`curl` 返回 000），Claude 方案里的"step 2.0 免费实验"目前不成立，要重启 llama.cpp 才有。

---

## 2. 目标与验收线（全计划只有这 6 个数说话）

| # | 目标 | 现状 | 验收 | 判定方式 |
|---|---|---|---|---|
| G1 | 链接判定准确 | F1 0.696@0.4（Zen）/ 硬负 FPR 0.333 | **F1 ≥0.75 且硬负 FPR ≤0.15** | 300 对 bench |
| G2 | 不再把无关新闻吸进大 Story | 最大 148 锚点；top-5 Story 吸收份额高 | 30 天回放：open event 锚点 ≤60，top-5 吸收份额下降，30 条人工审 ≥90% 同事件 | 回放 + 人工 |
| G3 | 正文有独立支撑证明 | 覆盖=写手自标签 | checker balanced accuracy ≥0.80；QA v4 与你 40 篇打分 Spearman ρ ≥0.5 且 > v3 | 标注集 |
| G4 | 关键事实不再虚高 | 34% 的 key fact 有双源 | 关键事实按 `source_count` 重算，`/audit` 显示单源份额 | SQL |
| G5 | fact 去重能扛硬负 | 从没测过 | 硬负误合并 ≤5%；同等 F1 下 Jev 调用 −50% | 300 对 bench |
| G6 | 深文不被截断 | 15 条 claim / 7,000 字上限 | 24k 字文章 ≥25 条 claim，且文内无重复 | 单篇实测 |

---

## 3. 阶段计划

### Phase 0 — 正确性与账单诚实（1–1.5 天，无需标注）

先修 bug：它们与重构无关，而且会污染后面所有测量。

| # | 改动 | 文件 | 验收 |
|---|---|---|---|
| 0.1 | `repairSectionIds` 跳过 `role='update'` 与零长跨度（现在 0 行，但下一次 append + `db:repair` 就会把待定锚点塞进第 1 节，consolidate 再也看不到它们） | `domains/story/store.mjs` | 新增用例：pending 行保持 NULL |
| 0.2 | 跳转 bug：`link.mjs:131-137` 跳到更大的 Story 时 `{...best}` 保留了小 Story 的 `same_event` 与 `gap`，随后的 duplicate/update 判定用的是**错的那篇**。直接删跳转（Phase 2 本来要删） | `knowledge/link.mjs` | 单测：stub `decide`，断言 parent 与实际打分一致 |
| 0.3 | Jev 失败 → `action:'deferred'`，条目回队，**绝不拿余弦当概率** | `link.mjs`、`cli/ingest.mjs` | 单测：`decide` 抛错 ⇒ 无 `story_link` 行、队列重排 |
| 0.4 | `split` 不再静默变 append：记 `action='split_pending'` 并在 `/audit` 显示 | `cli/apply-policy.mjs`、`web/queries/pages.mjs` | 页面可见 |
| 0.5 | 新增 `fact.source_count`（distinct source），所有"关键事实"消费者（QA `coverageKey`、简报评分、P2 阈值）改用它；`support_count` 只做展示 | `shared/schema.mjs`(v17)、`knowledge/facts.mjs`、`cli/qa.mjs`、`delivery/brief.mjs` | 回填 SQL + 单测；`/audit` 出单源份额 |
| 0.6 | QA 加 `qa_version`，`/audit` 与 `metrics` 不跨版本平均 | `schema.mjs`、`qa.mjs`、`ops/metrics.mjs` | 旧数据 version=3，新算=4 |
| 0.7 | 文档漂移：删掉或标 planned 的四处——union-find、SPO、`world_from/to`、候选阈值 0.62 | `docs/pipeline.md`、`docs/data-model.md`、`docs/adr/0003` | 文档与代码一致 |
| 0.8 | **链接判定切 OR 1.14**（新增 `JEV_LINK_PROVIDER`，按用途路由；Zen 保留给便宜的批量问） | `providers/jev.mjs` | bench 复核：F1 上升、硬负不劣化 |
| 0.9 | **分块抽取**提前做：3,500 字/块 + 每块上限 + 文内去重，去掉 15 条与 `slice(0,7000)`；不回填历史 item | `cli/ingest.mjs`、`domains/ingest/extract.mjs` | 24k 字文章 ≥25 claim、无重复、成本可接受 |

**退出标准**：`npm test` 全绿；`db:repair` 连跑两次返回 0；`/audit` 显示单源关键事实份额；一篇 24k 字文章 claim 数 ≥25。

> 0.8 与 0.9 是我在 Claude 方案之外加的两条，理由：0.8 是**每块钱换最多质量**的一步（$0.2/月），0.9 是**上游质量**——现在 SemiAnalysis 的 24k 字和 1.2k 字的文章都只出 15 条 claim，后面所有机制都在这个截断上做文章。

### Phase 1 — 测量基座（1.5 天代码 + 你 2–3 小时）

Claude 计划要你 8–10 小时标注，我砍到 2–3 小时：**模型先标，你只审分歧**。

- `bench/<task>.v1.jsonl`：`{id, input…, label, labeller, labelled_at, source}`，冻结、只追加。
- `src/cli/label.mjs`：交互式标注器。流程是"bench 先跑一遍当前实现 + 候选实现"，只把**两者不一致**或**模型置信度中间带**的样本推给你（每次 20 分钟能审 60–80 条）。
- `src/cli/bench.mjs <task> [--engine=zen|or|local] [--impl=current|candidate]`：出 F1 / P / R / 硬负 FPR / Wilson 95% 区间 / 10 箱可靠性表，写 `out/bench/<task>-<date>.json`。
- `config/thresholds.json`：每个阈值带 provenance（`value / set / n / chosen_by / date`），`npm run check` 缺 provenance 直接失败——把"为了让门禁通过而调阈值"变成机械上不可能。

标注集与用量：

| 集 | 规模 | 你的时间 | 用于 |
|---|---|---|---|
| `linking.v1` | 300 对（现有 186 + 60 硬负 + 54 同实体不同事件） | 1.5–2 h（审分歧） | G1/G2 |
| `story-ratings` | 40 篇 1–5 分（按当前 QA 分层抽样） | 40 min | G3 |
| `claim-quote` | 150 对（75 英源 / 75 中源） | 30 min（审分歧） | G3 |
| `sentence-fact` | 200 对（来自 25 次近期重写） | 30 min（审分歧） | G3 |
| `dedup` | 300 对（100 改写 / 100 硬负 / 100 无关） | 40 min（审分歧） | G5 |
| `update-decisions` | 150 条 | 40 min（审分歧） | Phase 6 |

**退出标准**：`bench linking --engine=or --impl=current` 能在 300 对上复现基线，结果写入 `bench/BASELINE.md` 并提交。

### Phase 2 — 修链接（2–3 天）· 收益最高

1. **同空间比较**：入站原文对 Story 的**源 item**（raw↔raw，取 max）；item 向量落在新表 `item_embedding(item_id, vec)`，`out/story-vectors.json` 整个删掉（它按 story id 缓存、重写后不失效）。
2. **gap 用 fact 身份**：`incoming fact ids − parent.story_fact`，余弦只作次要信号；`policy.mjs:46` 的 <0.85 重算删掉。
3. **时间**：`story.last_event_ts` + `item.published_ts`，`p_link = σ(w·[jev_p, cos_raw, fact_jaccard, exp(-Δt²/2σ²)])`，σ=72h 起；硬规则：Δt>7 天最高只能是 `follow_up`，永不做 `update`。
4. **纯事件问句带日期**：「A（X 日）与 B（Y 日）是否报道同一件具体发生的事——同主体、同事件/宣布/决定？同一实体的后续或另一件事不算。」
5. **删三条坏规则**：`link.mjs:106` 的亲和度覆盖、`:113-114` 偏好最大、`:116-137` 跳转。父节点 = `p_link` argmax。保留 `merged_into` 规范化。
6. 权重先手调；bench 不够再上 4 特征逻辑回归（30 行 JS，无依赖），权重进 `config/thresholds.json`。
7. **存量救火（我加的）**：`cli/attractor-audit.mjs` 对现有 466 篇按新规则重算链接，输出 `out/attractor/<date>.json` **提案**（哪篇该拆、哪些锚点属于别的 Story），`--apply` 才动，先备份。Nvidia 那 148 锚点的吸水机不能靠"以后不再犯"解决。

**验收**：G1 + G2。**被证伪**：时间与同空间特征把硬负 FPR 降不到 0.2 以下 ⇒ 判定器是瓶颈，直接进 Phase 5 事件层，并考虑本地 judge。

### Phase 3 — 独立支撑校验 + QA v4（3–4 天）

- 新 `domains/knowledge/entail.mjs`：`entails([{premise, hypothesis, lang}], {engine})`。引擎 A = Jev 批量 `noul`（20 对/次，非写手模型）；引擎 B（可选）= mDeBERTa-v3-xnli ONNX，**惰性加载的 optional peer**，不装就不启用。
- 三处接入：(a) 摄取时 claim↔quote±1 句，失败标 `unverified`（不丢弃）；(b) 门禁里 sentence↔所引事实的 claim quotes，替代自标签覆盖；(c) QA v4。
- QA v4 五指标：support rate、key-fact recall（key = `source_count≥2`，每事实只查 top-3 句）、staleness（lede 里仍断言已 superseded 的事实）、semantic redundancy（句对余弦/双向蕴含）、titleAlign（保留）。density 与 lengthAdequacy 降级为 `issues_json` 里的诊断项，**不进分数**。
- 先双跑（v3 与 v4 都算），用 40 篇评分算 Spearman ρ，ρ 达标才切换。

**成本**：19 篇/天 ×（15 claim + 40 句）≈ 1k 对/天 ≈ 50 次 Jev 调用/天，可忽略。**被证伪**：跨语言 <0.75 而单语正常 ⇒ 提前做 Phase 7 的源语言抽取。

### Phase 4 — fact 去重硬负（2–3 天）

1. 先测：`bench dedup` 出三类余弦分布与 Jev P/R（这一项就回答"7% vs 29.5% 冗余"之争）。
2. `factReps` 改"对全部成员取 max"；7k 向量暴力扫足够。
3. 纯函数 `domains/knowledge/veto.mjs`：抽数字（阿拉伯/中文/单位/%）、日期、否定词（不/未/没/否认/拒绝/not/no/denied），任一不一致 ⇒ 永不自动合并；重单测。
4. banded：>τ_hi 且 veto 过 ⇒ 自动合；<τ_lo ⇒ 自动拒；中间带交**一次集合式问**（"这些候选里哪些说的是同一事实？"），把 3 次 yes/no 压成 1 次。
5. **fact id 稳定性（我加的，Claude 方案没提）**：合并要动 `claim.fact_id` / `story_fact.fact_id`。方案是加 `fact_alias(old_id → new_id)` 并让所有读取路径走视图，或合并时在同一事务里迁移引用 + 保留 `merged_into`。**没有这一层，一次夜间合并就打断 Web 上所有锚点。**
6. 夜间 `cli/fact-merge.mjs`：mutual top-k → veto → Jev → union-find + **cluster repair**（含 veto 冲突的簇必须拆）→ 刷新 `canonical_text` 为质心最近的成员；先出提案文件，`--apply` 才写。

**验收**：G5（硬负误合并 ≤5%、Jev 调用 −50%、50 条合并人工审 ≥90% 精度）。

### Phase 5 — 事件层（1–2 周，是否做由 Phase 2 的数字决定）

- schema v18（纯增量）：`event(id, story_id, title, first_ts, last_ts, status, closed_at)`、`event_item`、`event_fact`，`story_link.relation` 增 `follow_up`。
- 链接目标改为**打开的 event**；无匹配但有强 `follow_up` ⇒ 同一 Story 新开一个 event。
- 关闭策略：N 天无新事实关闭（从 5 天起，标 30 条关闭来调）；关闭后新进展开新 event，不追加进 200 事实的文档。
- 渲染 = 滚动 lede（≤3 段）+ 按日期的时间线（每 event 一段，新在上）。P2 的 condolidate 退化成"重渲一个 event 块"。先用 `?view=timeline` 预览，旧渲染不动。
- 迁移：每篇现有 Story 变成一个 event，`last_ts` = 最新 item 时间，全部 open，跑一次关闭任务。`knowledge_state` 保持 per-story。

**验收**：30 天回放里单个 open event ≤60 锚点；20 篇盲选新旧渲染，新版 ≥14/20 你更愿意读。

### Phase 6 — 策略标定与门禁合一（2–3 天）

1. 按问题类型出可靠性表，isotonic 拟合存 `config/calibration/*.json`。
2. 成本阈值：`p > C_FP/(C_FP+C_FN)`，成本比写进 ADR 0004 修订；破坏性动作（P0）用 Clopper–Pearson 95% 下界选阈值。
3. 简化：P3 = 给 event 加事实；P2 = 重渲 event 块；P1 = 一条带日期的 Jev 问句（替掉 `policy.mjs:87-95` 的字符重叠+动词正则）；split 要么开新 event 要么删掉。
4. 四条重写通路合成一套门禁 `domains/story/gate.mjs`：support ≥ τ_s、key-fact recall ≥ τ_r、冗余 ≤ τ_d、**只有上限**的长度预算（不再有地板）；顺手把三份重复的 `tri/jac/dupOf`、6 处 F-id 清洗正则抽到 `domains/story/text.mjs`。
5. `update-decisions` 冻结为 CI 回归集，macro-F1 不许下降。

### Phase 7 — 抽取升级残余（2–3 天）

源语言 `claim.text_src/lang`（仅当 Phase 3 证明有跨语言差距时）、`claim.event_date`、填 `subject`（做 blocking key）、按需回填（只回填活跃 Story 与被离线合并触碰的 claim，不全量 7.5k）。

---

## 4. 与 Claude 方案的差异

| Claude 方案 | 我的处理 | 原因 |
|---|---|---|
| Phase 0.1–0.4、0.7 | **全采纳** | 我已逐条验证（含跳转 bug：`link.mjs:131-137` 覆盖 `id/title/facts` 却保留旧 `same_event/gap`） |
| Phase 0.5 `source_count` | **采纳，并算清账**：329 个 support≥2 的 fact 里只有 112 个真跨源（34%） | 数字比"虚高"更有说服力 |
| Phase 0.8 `qa_version` | **采纳** | 否则任何均值都不可比 |
| 8–10 小时标注 | **压到 2–3 小时**：模型先标、你只审分歧 | 你的时间是最贵的资源；且我在 bench 里已经能跑双实现对比 |
| step 2.0「本地 glide 是免费实验」 | **否决当前形态** | 新机器 8033/8034 全 down；且本地硬负 FPR 0.55 是三者最差——它对"同实体不同事件"最不敏感 |
| — | **新增 0.8 链接判定切 OR 1.14** | Zen 免费档 F1 低 6 点，OR 月账单约 $0.2 |
| — | **新增 0.9 分块抽取提前** | 15 条/7k 字截断是所有机制的上游天花板 |
| Phase 4 离线合并 | **采纳 + 补 fact id 迁移设计** | 否则一次合并打断所有锚点 |
| Phase 2 | **采纳 + 补存量 attractor 审计** | 吸水机已经存在，不修就一直读坏文章 |
| Phase 5 事件层 | **采纳，但推迟到 Phase 2 数据之后决定** | 与 Claude 的"Recommended: decide after"一致；补充迁移与渲染回退方案 |
| `config/features.json` + shadow 表 | **采纳** | 改活系统而不掉阅读质量的唯一稳妥办法 |

---

## 5. 成本与时间

| 项 | 估算 |
|---|---|
| 链接判定切 OR 1.14 | ≈$0.2/月（95 次判定/天 × $0.001151/20 问） |
| Phase 3 支撑校验（Jev 批量） | ≈50 次调用/天，$0（Zen）/≈$0.3/月（OR） |
| Phase 0.9 分块抽取增量 | 深文 6 次调用/篇，按 5 篇深文/天算 ≈$1–2/月 |
| 本地 NLI（可选，Phase 3 引擎 B） | $0 API，代价是首个 npm 依赖（`@huggingface/transformers`）+ CPU 时延（未实测） |
| 存储 | 新增 `item_embedding`、`event*`、`shadow_decision`，按 19 篇/天估 +150MB/年 |
| 代码 | Phase 0 ≈1–1.5 天；Phase 1 ≈1.5 天；Phase 2 ≈2–3 天；Phase 3 ≈3–4 天；Phase 4 ≈2–3 天；Phase 5 ≈1–2 周；Phase 6 ≈2–3 天；Phase 7 ≈2–3 天 |
| 你的时间 | 标注 ≈2–3 小时（分布在本月）；40 篇评分 ≈40 分钟 |

节奏：第 1 周 Phase 0 + Phase 1（含标注），第 2 周 Phase 2，第 3 周 Phase 3，第 4 周 Phase 4，之后按 Phase 2/3 的数字决定 Phase 5 是否现在做。

---

## 6. 风险与 kill criteria

| 风险 | 触发信号 | 应对 |
|---|---|---|
| 判定器本身是瓶颈 | 同空间 + 时间特征后硬负 FPR 仍 >0.2 | 提前做事件层；本地/更大模型重测 |
| 标注疲劳 | 你连续两周没动标注集 | 最小集 = `linking` + `story-ratings`（≈2.5 h），够验证 Phase 2/3 |
| 离线合并打断锚点 | `story_fact` 里出现指向不存在 fact 的行 | Phase 4.5 的 id 迁移必须先落地；合并只走提案 + `--apply` |
| 事件层迁移搞乱阅读状态 | `knowledge_state` 错位、已读页码丢失 | 事件层只改渲染与链接目标，`knowledge_state` 继续 per-story |
| 云判定抖动 | OR 5xx | `deferred` 回队，绝不用余弦兜底；Zen 作为第二兜底 |
| 过度拟合 300 对 | 换一批数据 F1 掉 >0.05 | 冻结 v1，第二轮调参前补 v2 样本 |

**全计划的总 kill switch**：如果 Phase 2 完成后 G1/G2 仍未达标，就不再往链接上投时间，直接进 Phase 5（事件层）并接受"Story 是渲染单位、不是聚类单位"。

---

## 7. 需要你定的 5 件事

1. **标注预算**：2–3 小时（模型预标 + 你只审分歧）可以接受吗？还是要我再往下压到"只审 100 条最不确定的"？
2. **链接判定切 OR 1.14**（≈$0.2/月）：默认开，还是要保留 Zen？
3. **是否重启本地 llama.cpp glide**：用于批量实验（180ms/问），但硬负误报率 0.55 最差。我的建议是先不重启，只在 Phase 2 被证伪时再考虑。
4. **Phase 5 事件层**：现在承诺，还是等 Phase 2 的数字（建议后者）？
5. **Phase 0.9 分块抽取**：现在就做（月度成本 +$1–2，深文 claim 数 15→25+），还是留到 Phase 7？

---

## 8. 下一步（Phase 0 的具体工单）

1. `domains/story/store.mjs`：repair 跳过 `role='update'`/零长跨度 + 用例。
2. `knowledge/link.mjs`：删跳转与亲和度覆盖；Jev 失败改 `deferred`。
3. `cli/apply-policy.mjs`：`split` 记 `split_pending`；append 路径也写 `superseded_by`。
4. `shared/schema.mjs` v17：`fact.source_count`、`story_qa.qa_version`、`item_embedding`、`shadow_decision`；配回填脚本。
5. `providers/jev.mjs`：`JEV_LINK_PROVIDER`（默认 `openrouter`），health 分行显示两个通道。
6. `cli/ingest.mjs`：分块抽取 + 去掉 15 条/7,000 字硬限。
7. `docs/`：四处漂移口径修正；新增 `docs/adr/0008-linking-repair.md`。
8. 跑：`npm test`、`db:repair` ×2、`pipeline --feed=hn --limit=2`、一篇 24k 字文章抽查看 claim 数。
