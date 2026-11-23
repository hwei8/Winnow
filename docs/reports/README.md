# 记忆底座 P0（技术验证）

> 用 `Summary` 里 150 个视频 dossier 做的一次底座验证：结构化记忆 + claim 级抽取 + 证据链 + 浏览界面。
> 源数据 `/workspace/Summary` 全程只读。

## 现在就能看

```bash
cd /workspace/IM-Base/memory-p0
node web/server.mjs          # 已在跑：http://192.168.0.222:3083/
```

- `/` 记忆流（无限滚动）
- `/story/:id` 事件页（时间线 + claim + 证据 + 截图帧）
- `/entity/:id` 实体页（按谓词分组的事实）
- 顶部搜索（中文全文）

## 当前数据

| 项 | 值 |
|---|---|
| 条目（视频） | 142 |
| ASR 分段 | 70,540 |
| 截图帧 | 37,532 |
| 事件（Story） | 141 |
| claim | 3,778（26.6/条视频，1.76 条/分钟） |
| 实体 | 4,069 |
| 证据覆盖 | 100%（98.8% 带原文片段，69.5% 带截图帧） |
| 平均置信度 | 0.812 |
| 类型化（subject+predicate） | 1,900（50.3%） |

## 流水线

```bash
node 01_ingest.mjs        # Summary → item/segment/frame/legacy/topic（0.4s）
node 02_cluster.mjs       # 全局聚类（严格"同一具体事件"）
node 02c_validate.mjs     # 审计多条目事件，拆掉 mixed
node 03_extract.mjs       # ASR → 原子 claim（分块 + 元信息过滤 + 结构化数值）
node 07_migrate.mjs       # schema 迁移（object_value_json / is_meta / status / claim_dup）
node 08_normalize.mjs     # 元信息打标 + 数字归一（ID 键控，防错配）
node 09_dedupe.mjs        # 多路召回 + LLM 裁决 + 合成控制组
node 10_fixup.mjs         # 时间戳/计数一致性修复
node 04_dedupe.mjs        # 跨条目复述率测量（旧版，保留对照）
node 06_review.mjs        # 质量与证据支撑度
node 05_bench.mjs [--scale]  # 查询性能基线 / 100 万 claim 压测
```

## P0.2：真实新闻流打磨

- 数据源：Hacker News 100 / NYT 100 / 知乎 44 / 36氪 20（共 264 条），新增 1,840 条带逐字引用的 claim
- 检查报告：[P0.2-CHECKS.md](P0.2-CHECKS.md)（重复性 / 可验证性 / CRUD / 时效性 / 冲突）
- OCR 预研：[OCR-FINDINGS.md](OCR-FINDINGS.md)
- 相关脚本：`12_rss_ingest` / `13_fetch_fulltext` / `14_fetch_hn_full` / `15_article_claims` / `16`–`23`

## Jev 决策模型（OpenRouter）

- 正确用法与踩坑记录：[JEV-NOTES.md](JEV-NOTES.md)
- 客户端：`lib/jev.mjs`（Decisions API，`noul`/`choice`/`score`，输出免费）
- 事件同一性判定：`node 27_jev_pairs.mjs`（含阈值标定 + 聚类）
- ⚠️ `24_decision_cluster.mjs` 是早期的错误用法（把 Jev 当聊天模型 + 走 router），已默认禁用，仅作反面教材保留

## P0.3：Jev 全量判定 + Benchmark + 粒度深挖

- 判定全量换 Jev：事件同一性 / claim 去重 / 冲突 / 时效分类 / 条目耐久度评分（`28`–`31`）
- Benchmark 报告：[BENCHMARK.md](BENCHMARK.md)
- 粒度深挖：[GRANULARITY-STUDY.md](GRANULARITY-STUDY.md)
- 相关脚本：`27_jev_pairs` / `28_jev_dedupe` / `29_jev_conflict` / `30_jev_temporal` / `31_jev_score` / `33_granularity_experiment` / `34_benchmark` / `35_bench_event`

## P0.4：主动搜索采集 + 粒度扩充复测

- 搜索式采集管线：[SEARCH-STORY.md](SEARCH-STORY.md)（14 源 → 240 claim → 228 唯一 → 覆盖 83%）
- 粒度 50 篇复测：见 [GRANULARITY-STUDY.md](GRANULARITY-STUDY.md) 附录
- 脚本：`36_search_ingest` / `37_search_claims` / `38_search_dedupe_coverage` / `39_granularity_50`

## P0.5：Story 验收（还原 + 评估 + 用量统计）

- 全部 claim 清单（含去重组与噪声标注）：[UNIQUE-CLAIMS.md](UNIQUE-CLAIMS.md)
- 还原的 Story（逐句标注 claim）：[STORY.md](STORY.md)
- Story 评估与打分：[STORY-REVIEW.md](STORY-REVIEW.md)
- 统计：240 → 合并 17 → 唯一 223 → 噪声 32 → 有效 191 → Story 用 176（73.3%）；真实冗余/无效 ≈ 28.7%
- 脚本：`40_export_story_pack` / `41_export_unique` / `42_story_stats`

## P0.6：留一源交叉验证

- 报告：[LOO-REPORT.md](LOO-REPORT.md)（语义冗余 34%；硬新闻 54% 可替代，分析/八卦 23%；Story 71% 用 claim 仅来自单一信源）
- 脚本：`43_leave_one_out.mjs`

## P0.7：正文抽取修复与复测

- 报告：[EXTRACTION-V2-REPORT.md](EXTRACTION-V2-REPORT.md)
- 新抽取器：`lib/extract.mjs`；复测脚本：`44_reingest_clean.mjs`
- 结果：Story v2（[STORY-V2.md](STORY-V2.md)）82/100；语义冗余 34% → 41.6%；真实漏采 12 → 4
- 新统计：`out/story-stats-v2.json`、`out/leave-one-out-v2.json`

## P0.8：事实级去重（Claim 不是唯一单位）

- 报告：[FACT-LEVEL-DEDUPE.md](FACT-LEVEL-DEDUPE.md)
- 结论：190 条有效 claim → **130 条新颖事实（冗余 31.6%）**；Story 178 条 claim → 124 条事实（内部冗余 30.3%）
- 方法：顺序判新（`48_sequential_novelty.mjs`）；词面候选/事实键两种测法作反面对照
- Schema 决定：`claim` 加 `fact_id`，Story 引用事实而非 claim

## P0.9：向量召回修复

- 报告：[VECTOR-DEDUPE.md](VECTOR-DEDUPE.md)
- 基准：词面 recall@10 **41%** vs bge-m3 **84%**；道歉簇 0% → 57%
- 改正后：190 条 claim → **134 个事实簇（冗余 29.5%）**，与顺序判新（130）互证
- 脚本：`49_vector_dedupe.mjs`、`50_vector_fact_cluster.mjs`

## P1.0：设计重审

- 报告：[DESIGN-AUDIT.md](DESIGN-AUDIT.md)（速度实测与容量模型、Story 中心结构、SQLite 向量基准）
- 基准脚本：`51_bench_infra.mjs`；数据：`out/infra-bench.json`

## P1.1：Story 一等公民落地

- 报告：[DESIGN-AUDIT.md](DESIGN-AUDIT.md)；试点渲染：[STORY-PILOT-RENDER.md](STORY-PILOT-RENDER.md)
- schema v6：`fact` / `fact_claim` / `story_section` / `story_fact` / `story_source`；story 加 category 与 body_md
- 试点：8 节 / 2,139 字 / 47 个事实锚点 / 45 个事实 / 正文零注释 / 分类 商业
- 速度：并发 10 → 4.6 篇/分钟（6,600 篇/天），约 12k tokens/篇
- 脚本：`52_schema_v6` / `53` / `54_extract_fast` / `55_build_story_aligned` / `56_render_story`

## P1.2：Story 正文质量优先

- 交付物：[STORY-FINAL.md](STORY-FINAL.md)（4,299 字 / 11 节 / 70 段 / 正文零注释）
- 锚点只存库：`story_fact` 164 条，精确到句子偏移；覆盖 141/159 事实（88.7%）
- 脚本：`57_build_story_rich`（段落化 + 显式事实标注）、`58_render_final`

## P1.3：全量回填 + 成稿流水线

- 回填：5,861 claim → 5,455 fact（全局冗余 6.9%）；claim 100% 挂 fact_id
- 流水线：`61_generate_story.mjs`（outline → 分节写作 → 事实锚点 → 落库 → 分类）
- 成品：[STORY-antimatter.md](STORY-antimatter.md)、[STORY-gemini4carbon.md](STORY-gemini4carbon.md)

## P1.4：批量成稿 + Web 接入

- 批量成稿：403 story → **344 篇正文**（长文 247 / 短稿 92 / 无正文 57）
- Web：Story 页正文 + 事实锚点悬停证据（`/api/story/:id/facts`）
- 写作脚本：`62`/`63`/`64`/`67`；Web：`web/queries.mjs`、`web/public/templates.mjs`、`web/public/app.js`、`web/public/style.css`

## P1.5：Jev 通道切换

- 对比报告：[JEV-PROVIDERS.md](JEV-PROVIDERS.md)
- 默认通道：OpenCode Zen `jev-1.13-free`（免费，24 并发实测无 429）；兜底 OpenRouter 1.14
- 结论：去重持平、事件/冲突 F1 差 3–4 点，成本从 $0.001/批降到 $0
- 客户端：`lib/jev.mjs`（`JEV_PROVIDER` / `JEV_FALLBACK` / `JEV_ZEN_MODEL`）

## P1.6：QA 层 + 标题翻译 + 补抓

- QA：378 篇 Story 全量质检（均分 86.8，`story_qa` 表，Web 显示"质检"徽章）
- 标题翻译：195 篇英文标题 → 中文（`title_original` 保留原文）
- 补抓：40 篇标题级条目抓回原文，新增 408 claim / 405 fact；全库 378/403 有正文
- 脚本：`69_schema_qa` / `70` / `71_qa_v2` / `72_translate_titles` / `73_fetch_title_only` / `74` / `75_assign_claims_to_facts`

## P1.7：Story 链接 / 去重 / 片段判定

- Story 级语义链接：`79_story_link.mjs`（正文 embedding + Jev 同一事件判定 + 事实缺口）
- 结果：403 → 活跃 284 / 重复 4 / 片段 90；stream 309
- 增量更新：`82_append_updates.mjs`（12 篇主 Story 追加"最新进展"）
- 入库链接 API：`lib/link.mjs` → `linkIncoming()`（演示 `81_link_demo.mjs`）
- QA v3：`80_qa_v3.mjs`（重复封顶 40、片段封顶 55）

## P1.8：入库流水线 + 实测

- 流水线：`83_ingest_pipeline.mjs`（抓取→抽取→归簇→链接判定）→ `84_finalize_new_stories.mjs`（new 建档）→ `82_append_updates.mjs`（update 追加"最新进展"）
- 决策表：`ingest_decision`；链接：`lib/link.mjs` → `linkIncoming()`
- 实测 11 条新 URL：7 update / 2 new / 2 抓取失败；同事件 5 篇全部并入同一 Story；重复入库判 duplicate（gap 0）

## P1.9：按需重写策略

- 判定：`lib/rewrite-policy.mjs`（P0 撤回/矛盾 · P1 主线变化 · P2 累积 · P3 追加 · P4 重复）
- 执行：`lib/rewrite-targeted.mjs`（定向重写）→ `lib/rewrite.mjs`（全量 fallback，快照/回滚）
- 调度：`86_apply_rewrite_policy.mjs`（按 Story 合并 pending，只重写一次）
- 实测：Nvidia 2026-11-11 大更新 → P2 → 重写成功（4,317 字，QA 93.1）

## P2.0：定向重写打磨 + 多 Story 验证

- 分节校验（覆盖率≥0.75，重试→保留原节）、锚点迁移修正、全局闸门（覆盖≥0.90 且长度≥0.85）
- 路由：定向优先，全量兜底；P1 检测增强（中文标题字符重合 + 状态变更词）
- 验证：三档测试全对；5 个大型 Story 定向重写 5/5 通过（只改 1 节、覆盖 1.0、事实 +8）
- 测试脚本：`87_test_rewrite_stories.mjs`、`88_test_policy_tiers.mjs`

## P2.1：阈值校准 + 安全网

- 真实更新扫描 k=2..16：P4/P3 为主，k=16 触发 P1；P2 由追加堆积触发
- 闸门：定向（覆盖≥0.85、重复闸门、受影响≤40%）；全量（覆盖≥0.90 且长度≥0.80）
- 重写失败自动退追加；linkIncoming 加持久化缓存（修 429）
- 校准脚本：`89_calibrate_thresholds.mjs`

## P2.2：节合并 + 参数校准

- `lib/consolidate.mjs`：多"最新进展"节合并成一节；参数 minSections/maxMerge/lenRatio/absMinLen/coverageTh/dupTh
- 参数扫描：lenRatio 0.2 + absMinLen 50 → 10/10 通过；其它组合大量回滚
- 合并后自动锚点重对齐（`lib/align.mjs`）；修复 section_id 为空的锚点丢失
- 应用：10 篇 Story 章节数 11→7 等，覆盖率 1.0；QA 全局 87.2 / 中位 88.7
- 脚本：`90_test_consolidate.mjs`、`91_apply_consolidate.mjs`、`92_realign_anchors.mjs`

## P2.3：真实更新回归 + QA 修正

- QA：覆盖率只算自身来源事实，外部事实单独记；锚点漂移按 1 计并标记；异常 6+8 篇 → 0
- 回归：10 条真实 update → P1×2 / P2×4 / P3×4；执行 2 篇重写通过、其余追加兜底、19 个 consolidate
- 新 Story：8 篇 HN 首页文章全部正确判 new 并生成
- 报告脚本：`93_regression_report.mjs`

## P2.4：小 Story 专用重写 + QA 维度

- `lib/rewrite-small.mjs`：<1000 字 Story 绝对门限整篇重写（覆盖≥0.95、长度≥max(200,35%)、重复≤0.15）
- `86` 路由 rewrite_small；`82` 小 Story 不再追加节
- QA：anchor_mismatch −5、external_facts 比例扣分
- 验证：2/3 通过（418→229、237→202，覆盖 1.0），1 篇注水 Story 回滚

## P2.5：一键流水线 + 每日报告

- `node pipeline.mjs --feed=hn --limit=8`：抓取→判定→建档→重写/合并→QA 全链路
- 无参数 = 维护运行（84/86/91/80）
- 报告：`reports/daily-YYYY-MM-DD.md`；历史：`pipeline_run` 表
- 实测：HN 首页 5 篇 → 3 new + 1 update；活跃 QA 均分 87.4 / 中位 89.1

## P3.0：capture + 知识状态 + 增量视图

- `capture.mjs`（CLI）+ `/memory` 页（Web 捕获与列表）
- `knowledge_state` 启用：seen/known 水位 + frontier
- Story 页「自你上次阅读以来 N 条更新」+ 标记已追平；流卡片「新 N」徽章
- API：`POST /api/capture`、`POST /api/state`、`POST /api/annotation`

## P3.1：Embedding 切本地

- **本地 llama.cpp `bge-m3`（1024 维，当前默认）**：`http://192.168.0.188:8033/v1/embeddings`，16 条/批 p50 ≈130ms
- 云端兜底：OpenRouter `baai/bge-m3`（同一权重，向量 cos 0.99994；本地失败自动回退）
- 切回云端：`EMBED_PROVIDER=openrouter`；关掉回退：`EMBED_FALLBACK=0`
- 历史基准：本地 32 条 p50 200ms vs OpenRouter 2,229ms；两者向量余弦 1.0000，已有向量兼容
- 2026-11-22 起默认走 OpenRouter（旧本地服务下线）
- `lib/embed.mjs` 统一客户端（本地优先，OpenRouter 兜底）；核心 lib 已切换

## P3.2：IM 简报生成器

- `brief.mjs`：story_update × knowledge_state → 三通道（必看/兴趣/探索）
- 每条固定三行：发生了什么 / 新在哪 / 为什么推你
- 输出：`out/briefs/brief-YYYY-MM-DD.md` + `briefing` 表 + Web `/brief` 页
- 实测：候选 11 → 必看 2 / 兴趣 6 / 探索 2，无跨通道重复

## P3.3：Adapter 契约 + Telegram 投递

- `adapters/hn.mjs`、`adapters/rss.mjs`（NYT/知乎/36氪），四方法：list/fetch/normalize/health
- `collect.mjs --adapter=hn --limit=5`、`--health=hn`、`--list`；`adapter_health` 表
- `pipeline.mjs --adapter=hn --limit=8`：采集→抽取→判定→建档→QA 全链路
- Telegram：`lib/im.mjs`（Claw bot），`brief.mjs --send` 推送；实测发送成功

## P3.4：P2 标注闭环 + Stance + 三轴下探

- 标注：`/api/annotation`（known/read/wrong/agree/disagree）→ 水位/claim/立场联动
- Stance：`/stance` 页 + Story 页立场展示（含演化历史）
- 三轴：L2 证据与主张、L4 深度报告（按需生成+缓存）、时间线回溯、未追平过滤
- 有限性信号：Stories「已追平最新 / N 条未读更新」、Stream「今天新增已读完」

## P3.5：P2 收尾

- Stream 广度分区（未读更新/今天/7 天内/更早）+ 只看未追平
- 新页面：`/search`、`/claims`（数据质量）、`/audit`（源健康/为什么没推/Token 账本/标注消费率）
- Web 九页全部就位

## P4.0：P3 主动发现

- `/topics` 覆盖地图（Story/claim/源/最近/缺口）+ `/topic/:name` 详情与关注
- `beat.mjs` / `POST /api/beat`：覆盖缺口 + 未收录文章（HN）+ 建议；可推 Telegram
- 深研双模式：`deep` 深度简报 / `contrast` 多源对照（一手/分析/反方/分歧）

## P4.1：P3 尾巴

- 别名映射：`topic_alias`（英伟达→Nvidia），Beat 按别名检索外媒
- 一键入库：`/topics` Beat 报告「入库」按钮 → `ingest_queue` → `worker_ingest.mjs`
- 源质量：`source_quality.mjs`（验证率/争议/被纠错 → 分数），`/audit` 展示

## P4.2：P3 收尾

- 源质量接入简报评分（±15 分），低质量源降权

## P5.0：P4 长期可靠

- `metrics.mjs`：追平率/冗余率/QA/纠错率/简报选择率（`/audit`）
- `health.mjs`：DB/embedding/Jev/Telegram 依赖检查
- `revalidate.mjs`：周期重验证 `needs_recheck` + `--resolve`
- `ontology.mjs`：重复实体合并 / 罕见谓词提案（`--propose/--list/--approve/--reject`）
- `export.mjs`：Markdown + JSON 全量导出 `out/export/<date>/`

## P6.0：收尾

- `im_capture.mjs`：Telegram「记 xxx」直接存 capture
- `evidence_gate.mjs`：证据可定位校验（99.94%），84 优先 verified 事实
- `drill.mjs`：embed/Jev/Telegram 降级演练（3/3 通过）
- `daemon.mjs`：每日调度（pipeline→brief→metrics）
- `AUDIT-FINAL.md`：全项目完成度审查（约 93%）

## P7.0：采集三层（热榜 / RSS / 搜索发现）

- `adapters/newsnow.mjs`：中文热榜 11 平台（微博/知乎/抖音/百度/头条/B站/财联社/华尔街见闻/澎湃/凤凰/贴吧），newsnow 公共 API + 浏览器 UA + 原文域名校验
- `95_hot_schema.mjs`：`hot_entry` / `hot_rank` / `hot_crawl`（标题身份=平台+URL，记排名历史）
- `hot_track.mjs`：热度 = `0.6*排名分 + 0.3*频次 + 0.1*趋势`；`--promote N` 把高分条目送进 `ingest_queue`
- `lib/search.mjs`：直接复用 DSH 的 DeepSeek 搜索/抓取（`/v1/tools/search`、`/v1/tools/fetch`，账号 token，5 QPS）
- `config/search_queries.txt` + `search_discover.mjs`：`[主题]`/`!排除`/`site:`/`-site:`/`@N`/`~Nd` 语法，URL + 近 7 天标题去重，`--enqueue` 入队
- `lib/fetchpage.mjs`：直连抽取不足 500 字时用 DeepSeek Fetch 取 Markdown 兜底（thepaper 实测 0 → 539 字）
- `pipeline.mjs --search --hot=2`：一键把搜索发现与热榜 Top N 接进入库链

## 文档

- [REPORT.md](REPORT.md)：验证报告（含 100 万 claim 压测与设计修正）
- `../memory-system/DESIGN-PROPOSAL.md`：v0.2 设计提案
- `../memory-system/DECISIONS.md`：已拍板决策（D1–D13）
- `../memory-system/SCHEMA-DRAFT.md`：结构化模型草案
- `../memory-system/DATA-AUDIT.md`：起步数据体检

## 已知边界

- 这批语料**几乎没有"同一事件的多源覆盖"**（142 个视频 → 141 个事件），所以 claim 级复述率天然接近 0；去重机制用合成控制组验证，等接入新闻源再实测收益。
- LLM 网关没有 embeddings 端点（实测 404），去重目前用"多路词面/结构召回 + LLM 裁决"替代向量召回。
- 数字归一化覆盖率为已识别数字类 claim 的一部分，口语近似值（"一两百"）保留原始限定词。
