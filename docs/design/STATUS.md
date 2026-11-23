# 项目进度对照表（vs DESIGN-PROPOSAL.md v0.2）

> 更新：2026-11-12。数据来自 `memory-p0/data/p0.db` 实时统计。

## 一句话结论

**编辑部后端（采集→抽取→去重→Story→QA→Web 浏览）基本建成；个人系统那一半（写/推/状态/标注/回访）尚未开始。**

## 分期对账（§13）

| 期 | 交付 | 状态 |
|---|---|---|
| **P0 记忆底座** | schema + capture + claim + Story/Entity/Search 三页 + 导出 | ✅ **95%**：capture（CLI+Web+IM）/knowledge_state/九页/导出 全部就位 |
| **P1 采集与去重** | adapter + L1/L2 + claim 抽取 + 证据 + Story Editor + IM 简报 | ⚠️ 75%：采集/抽取/L1/L2/Story Editor ✅；**IM 简报 ❌**、adapter 未契约化、证据校验未做门禁 |
| **P2 拉与标注** | Web 无限流 + 三轴下探 + 有限性信号 + 标注闭环 + Stance | ⚠️ 30%：无限流 ✅；**三轴/有限性信号 ❌、标注 ❌、Stance ❌** |
| **P3 主动发现** | Beat Reporter + 覆盖缺口 + 探索槽 + 深研 | ✅ **100%**：覆盖地图/Beat/别名/一键入库/深研/源质量接入排序 全部完成 |
| **P4 长期可靠** | 回填 + 周期重验证 + 本体演化 + Audit + 降级 | ⚠️ **85%**：度量/健康/重验证/本体/导出/降级演练/调度 ✅；常驻守护未开 |

## 逐项状态（按 proposal 章节）

| § | 能力 | 状态 | 证据/缺口 |
|---|---|---|---|
| §1 | 写 capture | ⚠️ | CLI `capture.mjs` + Web `/memory`；无 IM 捕获 |
| §1 | 推 IM 简报 | ❌ | 无 Telegram bot、无 12 条三通道、无"新在哪/为什么推你" |
| §1 | 拉 Web | ⚠️ | 6/9 页（Stream/Story/Entity/Memory/Brief/Stance） |
| §1 | Knowledge State | ⚠️ | 表启用：seen/known 水位 + frontier；缺 stance |
| §3 | Collector | ✅ | RSS(HN/NYT/知乎/36kr)/search 抓取、正文抽取、幂等入库 |
| §3 | Story Editor | ✅ | 生成/合并/更新/重写策略(P0–P4)/节合并/版本回滚；423 Story、1,975 节、11,542 锚点 |
| §3 | Fact Checker | ⚠️ | Jev 矛盾检测 + QA v3（398 篇）；缺双模型交叉、子串校验门禁、过期重验证 |
| §3 | Chief Editor / Beat / Librarian / Researcher / Ontologist | ❌ | 均未实现 |
| §4 | Source→Item→Story→Claim→Entity | ✅ | 6,774 claim、6,268 fact、5,889 entity、423 story |
| §4 | Story Update | ⚠️ | 表有 123 行（new_facts/append/consolidate/merged）；缺"自你上次看新增了什么"的用户水位 |
| §4 | Claim 双时间轴 | ⚠️ | 字段齐全；`world_from/world_to` 大量为空 |
| §4 | capture / capture_link | ❌ | 不存在 |
| §5 | L1 URL/指纹去重 | ✅ | URL hash 幂等入库 |
| §5 | L2 向量召回+聚类 | ✅ | bge-m3 + Jev，6,268 fact，全局冗余 6.9% |
| §5 | L3 差集 vs knowledge_state | ❌ | knowledge_state 空 |
| §5 | 屏蔽五层 | ❌ | 无源/作者/主题/表述模式/事件疲劳屏蔽 |
| §5 | 冗余经济（1 手+1 分析+1 反对） | ❌ | 未做 |
| §6 | IM 简报三通道 | ✅ | 生成 + Telegram 投递 + `/brief` 预览 |
| §7.1 | 三轴下探（广度/深度/回溯） | ✅ | L2 证据 / L4 深研 / 时间线 / 广度分区（未读·今天·7天·更早） |
| §7.2 | 有限性信号 | ❌ | 无 novelty_frontier/"已追平"标记 |
| §7.3 | 九页 | ✅ 9/9 | 含 Topic/Beat（`/topics`、`/topic/:name`） |
| §8 | 记忆捕获与回访 | ⚠️ | capture + review_at + due 列表；无 Librarian 归类/回访推送 |
| §9 | adapter 契约 | ✅ | `adapters/hn`、`adapters/rss`（NYT/知乎/36氪），list/fetch/normalize/health + `adapter_health` |
| §10 | 标注闭环 | ✅ | known/wrong/agree/disagree → 水位/claim 状态/stance 联动；`/stance` 页 |
| §11 | 技术选型 | ✅ | Node+SQLite WAL+FTS5+sqlite-vec；SSR Web；token_ledger 350 行 |
| §11 | IM / 调度 / 导出 | ⚠️ | Telegram ✅；`pipeline.mjs`/`collect.mjs` 一键可跑（无 cron）；导出 ❌ |
| §12 | Token 预算 | ✅ | 已切 Jev 免费 + opencode 1/10 价；预算压力大幅下降 |
| §14 | 度量（信噪比/冗余率/追平率等） | ⚠️ | 标注消费率 ✅、覆盖缺口 ✅；信噪比/追平率未采集 |
| §15 | 失败可见（decision_log） | ⚠️ | 有 ingest_decision/story_link/story_update 数据，无 Audit 页 |

## 数据规模（2026-11-12）

| 表 | 行数 |
|---|---|
| item / item_block | 582 / 8,160 |
| claim / claim_evidence | 6,774 / 6,774 |
| fact / fact_claim | 6,268 / 6,742 |
| entity / claim_entity | 5,889 / 13,033 |
| story / story_section / story_fact | 423 / 1,975 / 11,542 |
| story_qa | 398（活跃均分 87.4、中位 89.1） |
| story_update / story_version | 123 / 185 |
| knowledge_state / annotation / capture | **1 / 0 / 2** |

## 建议的补课顺序

1. **P0 补完（个人半）**：capture（IM/Web 一句话）+ knowledge_state（known 水位/看过）+ Story 页"自你上次看新增了什么"；
2. **P1 收尾**：IM 简报生成器（story_update → 12 条三通道 + 新在哪/为什么推你）；
3. **P2 补完**：标注闭环（一键 known/wrong/agree）+ Stance + 三轴下探 + 有限性信号；
4. **P3**：Beat Reporter（覆盖缺口）、探索槽、深研；
5. **P4**：周期重验证、Audit 页、本体演化、度量仪表。
