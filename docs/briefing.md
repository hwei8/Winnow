# 简报

Web 是无限流（你想拉多少拉多少），简报是**有限推送**——一天一次，几条，读完就够。

```bash
npm run brief                    # 生成并打印
npm run brief -- --out           # 只写文件
npm run brief -- --out --send    # 写文件并推送 Telegram
npm run brief -- --hours=12 --count=8
```

产物：`out/briefs/brief-YYYY-MM-DD.md`，同时写一行 `briefing`（可回看历史），并出现在 `/brief` 页。

## 候选池

两条来源，取窗口内的变化：

1. **更新**：`story_update` 在窗口内（默认 24h）的记录，按 Story 聚合；
2. **新篇**：`story.first_seen_ts` 在窗口内、且窗口内没有更新的 Story（`change_type = new_story`，评分 +18）。

排除：`duplicate`、带 `merged_into`、`ignored` 的 Story。

## 评分 `scoreCandidates()`

| 信号 | 分值 |
|---|---|
| P0（撤回 / 矛盾） | +100 |
| P1（主线变化） | +60 |
| P2（累积） | +25 |
| 新故事 | +18 |
| 未读更新数 | `min(20, pending × 4)` |
| 事实规模 | `min(10, facts / 20)` |
| 已知道（`known`） | **−40** |
| 看过（`seen`） | −10 |
| 关注主题 | +15 |
| 常读类别（前 5） | +8 |
| 源质量 | `clamp((q − 50) × 0.4, ±15)` |
| 近度 | `max(0, 12 − 小时数)` |

排序后按通道切分：

| 通道 | 取法 | 意图 |
|---|---|---|
| **必看** | 有 P0/P1 的，最多 3 条；不足 2 条时用总分最高的补位 | 不看会误事的 |
| **兴趣** | 关注主题或常读类别，跨通道去重 | 你正在追的 |
| **探索** | 未知类别 + 高总分的边缘项 | 防止信息茧房 |

三条通道之间**互相去重**，同一条不会出现两次。

## 每条三行

生成的文案固定三行，不允许写废话：

```
发生了什么：辉达董事会主席称无意恢复黄仁勋 CEO 职务
新在哪：首次有董事会层面的人公开表态，与此前"CEO 将回归"的报道相反
为什么推你：你在追英伟达，且这是 P1 级主线变化
```

生成时需要告诉模型的信息（`delivery/brief.mjs`）：更新类型、缺口事实、你的已知状态（`known` 时要求「只讲新增部分」）、Story 的小节标题。明确禁止「假装有更新」。

## 投递

`providers/telegram.mjs`：

- 3500 字分片，Markdown → 纯文本，HTML 转义；
- 需要 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（或 `.secrets/telegram.json`）；
- 失败只记日志，不影响本地文件生成。

## 定时

```bash
node src/cli/daemon.mjs --once                   # 手动跑一轮
node src/cli/daemon.mjs --loop --at=08:00        # 每天 8 点（前台）
```

生产建议用 systemd timer 而不是内置 loop（见 [operations.md](operations.md)）。

## 度量

`/audit` 与 `metrics` 会跟踪 **简报选择率**（候选里最终进了简报的比例）与**追平率**。这两个数下降，通常意味着：源变差、阈值过松、或你已经追不上了——三种情况该做的调整完全不同。
