# Jev 供应商对比：OpenCode Zen（免费 1.13）vs OpenRouter（1.14）

## 1. 发现

OpenCode Zen 提供 **System One 端点**，协议与 OpenRouter Decisions API 完全一致：

```
POST https://opencode.ai/zen/v1/systemone
{ "model": "jev-1.13-free", "state": {...}, "questions": {...} }
```

响应同样是 `{answers, usage}`：

```json
{"model":"jev-1.13-free","answers":{"q0":{"type":"noul","noul":0.95}},
 "usage":{"input_tokens":349,"output_tokens":21,"cost":0,
          "opencode":{"billing_source":"free","list_cost":0}}}
```

| 模型 | 状态 | 价格 |
|---|---|---|
| `jev-1.13-free` | ✅ 可用（新 key 实测） | **$0** |
| `jev-1.13`（付费） | ❌ 当前 key 余额不足（`Insufficient balance`） | 与 OpenRouter 同价（$0.042/1M） |

## 2. Benchmark（同一标记集、同一 prompt）

| 任务 | 样本 | Zen free 1.13 | OpenRouter 1.14 | 差距 |
|---|---|---|---|---|
| 事件同一性 | 88 对 | P 1.000 / R **0.857** / F1 **0.923** | P 1.000 / R **0.905** / F1 **0.950** | 1.14 高 ~3% F1 |
| claim 去重 | 45 对 | P 1.000 / R **1.000** / F1 **1.000** | P 1.000 / R 1.000 / F1 1.000 | 持平 |
| 冲突判定 | 28 对 | P 1.000 / R **0.786** / F1 **0.880** | P 1.000 / R **0.857** / F1 **0.923** | 1.14 高 ~4% F1 |

| 指标 | Zen free 1.13 | OpenRouter 1.14 |
|---|---|---|
| 单批延迟（20 问题） | 180–214 ms | 173–220 ms |
| 输入 token（三集合计） | 25,502 | 25,502 |
| 成本 | **$0** | **$0.00107** |

**并发测试**（Zen free）：24 个请求同时发出 → **24/24 HTTP 200，p50 281 ms，最大 4.3 s，无 429**。

## 3. 结论与选型

1. **Zen free 1.13 作为默认通道**：免费、延迟相当、去重任务完全持平，事件/冲突只差 3–4 个点；
2. **OpenRouter 1.14 作为兜底**：当 Zen 失败/限流，或任务对召回敏感（如大规模事件聚类）时切 1.14；
3. **付费 Zen 1.13 不建议**：价格与 OpenRouter 相同、版本还落后，没有理由用；
4. **1.14 独有能力**：`box`（图像定位）等 primitive 只有 1.14 支持，若做 OCR/视觉证据定位需走 OpenRouter。

## 4. 已落地

`lib/jev.mjs` 已改为：
- 默认 `JEV_PROVIDER=zen`（`jev-1.13-free`）；
- 失败自动 fallback 到 OpenRouter `~typesafe/jev-latest`；
- 可分别用 `JEV_ZEN_MODEL` / `JEV_OR_MODEL` / `JEV_PROVIDER` 覆盖；
- 实测：`provider=zen, model=jev-1.13-free, cost=0, ms=299`。

## 5. 风险

- 免费档是"限时免费"性质，可能随时变化或限流——已有 OpenRouter 兜底，不影响主线；
- 两版本行为差异需在切换后重跑标定（当前差异在可接受范围）。
