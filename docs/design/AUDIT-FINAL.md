# 项目完成度审查（2026-11-19）

> 对照 [DESIGN-PROPOSAL.md](DESIGN-PROPOSAL.md) v0.2 与 [DECISIONS.md](DECISIONS.md) D1–D51。
> 结论：**核心系统（内容引擎 + 个人层 + 主动发现）已闭环，完成度约 93%**；剩余为可选增强与运营化。

## 1. 阶段完成度

| 期 | 交付范围 | 完成度 | 结论 |
|---|---|---|---|
| P0 记忆底座 | schema / capture / claim / Story·Entity·Search 三页 / 导出 | **95%** | ✅ 底座完整（capture CLI+Web+IM、knowledge_state、导出） |
| P1 采集与去重 | adapter / L1·L2 / claim 抽取 / 证据 / Story Editor / IM 简报 | **100%** | ✅ 含证据校验门禁（99.94% 验证率） |
| P2 拉与标注 | 无限流 / 三轴下探 / 有限性信号 / 标注闭环 / Stance | **95%** | ✅ 九页齐、三轴齐；缺主观信噪比采集 |
| P3 主动发现 | Beat / 覆盖缺口 / 探索槽 / 深研 | **100%** | ✅ 覆盖地图、Beat+别名+一键入库、深研双模式 |
| P4 长期可靠 | 回填 / 重验证 / 本体 / Audit / 降级 / 度量 | **85%** | ✅ 度量/健康/重验证/本体/降级演练/调度脚本；缺常驻守护 |

## 2. 逐项对照（proposal 章节）

| § | 能力 | 状态 | 证据 |
|---|---|---|---|
| 1 | 写 capture | ✅ | `capture.mjs`、`/memory`、`im_capture.mjs`（「记 xxx」） |
| 1 | 推 IM 简报 | ✅ | `brief.mjs --send` + Telegram（Claw bot） |
| 1 | 拉 Web | ✅ | 九页：Stream/Story/Entity/Memory/Brief/Stance/Search/Claims/Audit |
| 1 | Knowledge State | ✅ | `knowledge_state`（seen/known/ignored + frontier） |
| 2 | 人可读可改可删 | ⚠️ | 标注/立场可改；Story 正文人工编辑未做 |
| 2 | 声明优先 | ✅ | `interest` 表 + 主题页关注 |
| 2 | 稀缺性只约束 push | ✅ | 简报三通道 + 每日一份 |
| 2 | 每条推送回答"新在哪" | ✅ | 三行：发生了什么/新在哪/为什么推你 |
| 2 | 证据可追溯 | ✅ | 锚点 + `claim_evidence`（6,800/6,804 可定位） |
| 2 | 本地优先可导出 | ✅ | `export.mjs`（JSON + Markdown） |
| 2 | 失败可见 | ✅ | `/audit`（为什么没推、源健康、Token 账本） |
| 2 | 反茧房 | ✅ | 简报必看/探索通道 |
| 3 | Collector | ✅ | `adapters/hn`、`adapters/rss` + `collect.mjs` |
| 3 | Story Editor | ✅ | 生成/合并/重写策略/节合并/版本回滚 |
| 3 | Fact Checker | ✅ | Jev 矛盾 + QA v3 + 证据门禁 + 重验证 |
| 3 | Beat Reporter | ✅ | `beat.mjs`（缺口 + 未收录文章 + 一键入库） |
| 3 | Chief Editor | ✅ | 简报生成 + 三通道 |
| 3 | Librarian | ⚠️ | capture 有 review_at/到期；归类自动关联未做 |
| 3 | Researcher | ✅ | L4 deep/contrast |
| 3 | Ontologist | ✅ | `ontology.mjs` 提案/审批/实体合并 |
| 4 | Source→Item→Story→Claim→Entity | ✅ | 587/424/6,804/5,889 |
| 4 | Story Update | ✅ | 125 条更新 + 「自你上次阅读以来」 |
| 4 | Claim 双时间轴 | ⚠️ | 字段齐；world_from/to 未回填 |
| 4 | capture/capture_link | ✅ | `capture` + `capture_link` |
| 5 | L1/L2/L3 去重 | ✅ | URL 幂等 + bge-m3+Jev + knowledge_state 差集（间接） |
| 5 | 屏蔽五层 | ⚠️ | 未推（有降权但无显式屏蔽） |
| 5 | 冗余经济 | ⚠️ | 未按"1 手+1 分析+1 反对"硬约束 |
| 6 | IM 简报三通道 | ✅ | 必看/兴趣/探索 + 三行解释 |
| 7.1 | 三轴下探 | ✅ | L2 证据 / L4 深研 / 时间线 / 广度分区 |
| 7.2 | 有限性信号 | ✅ | 已追平 / 未读 N / 今天新增已读完 |
| 7.3 | 九页 | ✅ | 全部上线（HTTP 200） |
| 8 | 记忆回访 | ✅ | `/memory` 到期列表 + capture review_at |
| 9 | adapter 契约 | ✅ | list/fetch/normalize/health + `adapter_health` |
| 10 | 标注闭环 + Stance | ✅ | 5 种标注 → 水位/claim/立场；`/stance` |
| 11 | 技术选型 | ✅ | Node 24 + SQLite WAL + FTS5 + sqlite-vec + 本地 bge-m3 |
| 11 | IM / 调度 / 导出 | ✅ | Telegram + `daemon.mjs` + `export.mjs` |
| 12 | Token 预算 | ✅ | 本地 embedding $0、Jev 免费、OpenRouter 兜底 |
| 14 | 度量 | ⚠️ | 追平率/冗余率/QA/纠错率/选择率 ✅；信噪比主观度量未做 |
| 15 | 降级可见 | ✅ | `health.mjs`、`drill.mjs`（embed/Jev/Telegram 三场景通过） |

## 3. 数据规模

| 表 | 行数 |
|---|---|
| item / story | 587 / 424 |
| claim / fact | 6,804 / 6,285 |
| entity | 5,889 |
| source | 124 |
| story_update / story_version | 125 / 185 |
| capture / annotation / stance | 3 / 2 / 1 |
| knowledge_state | 3 |
| briefing / beat_report | 4 / 3 |
| ontology_proposal | 21（15 待审） |
| metric_snapshot / revalidation | 4 / 32（全部已 resolve） |

## 4. 验证记录（可复现）

```bash
node health.mjs                    # 4/4 依赖在线
node drill.mjs                     # embed/Jev/Telegram 降级 3/3 通过
node evidence_gate.mjs             # 6,800/6,804 证据可定位（99.94%）
node metrics.mjs                   # 追平率 67% / 冗余率 8% / QA 79.5 / 选择率 77%
node pipeline.mjs                  # 维护链路 424 Story / 399 正文 / 330 活跃
node daemon.mjs --once --steps=metrics   # 调度脚本可用
node export.mjs                    # out/export/<date>/ 全量导出
```

Web（`http://192.168.0.188:3083`）：9 个页面全部 200。

## 5. 明确缺口（不在"完成"口径内）

1. **运营化**：`daemon.mjs --loop` 需常驻（nohup/systemd），当前未常驻；
2. **Bilibili 源**：按 D9 暂缓（视频需转写，成本另算）；
3. **屏蔽五层 / 冗余经济**：提案中的硬约束未实现（当前只有推荐降权）；
4. **信噪比主观度量**：需要用户对推送打分，未做；
5. **world_from/to 回填**：claim 时间轴字段齐但大量为空；
6. **人工编辑 Story 正文**：只支持标注/重写，不支持手改正文；
7. **外网部署**：内网 only；Cloudflare 外网镜像未做（D11 已定方案，未施工）。

## 6. 风险提示

- `im_capture.mjs` 与 DSH 自己的 Telegram 轮询会抢 `getUpdates`（409），二选一或用独立 bot；
- 本地 bge-m3 单点：drill 证明可回退 OpenRouter，但延迟从 6ms/条涨到 70ms/条；
- Story 摘要类正文（snippet）仍占 90 篇，QA 上限 55；
- `needs_recheck` 目前无自动重抓流程，只有标记 + 手动 resolve。

## 7. 建议下一步（按价值排序）

1. 常驻 `daemon --loop`（每日流水线 + 简报推送）；
2. Bilibili 接入（Whisper 转写 + 字幕锚点）—— 主信息源缺口；
3. 推送评分（简报每条 👍/👎）→ 信噪比度量 → 排序学习；
4. 屏蔽五层（源/作者/主题/表述模式/事件疲劳）；
5. Cloudflare 外网只读镜像（D11）。
