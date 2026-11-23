# Jev（TypeSafe 决策模型）正确用法

> 依据：OpenRouter Jev 文档 与 TypeSafe 官方文档（2026-11）。
> 一句话：**Jev 不生成文本**，它接收 `state` + 类型化 `questions`，返回**带概率的类型化答案**；输出 token 免费，按输入 token 计费。

## 模型与定价

| 项 | 值 |
|---|---|
| 模型 ID | `typesafe/jev-1.14`（另有 `typesafe/jev-1.13`） |
| 别名 | `~typesafe/jev-latest` |
| 定价 | **$0.042 / 1M 输入 token**（输出免费） |
| 上下文 | 262,144 tokens |
| 端点 | `POST https://openrouter.ai/api/alpha/decisions` |

## 四种问题（primitives）

| 类型 | 用途 | 返回 |
|---|---|---|
| `noul` | 是/否判断 | `{noul: 0.97}`（为真的概率） |
| `choice` | 多选一 | `{choice: "payments", probabilities: {...}, confidence: 0.9}` |
| `score` | 有序评分 | 概率加权位置 |
| `box` | 图中定位（1.14+） | 四个边界 + 置信度 |

## 请求形状

```json
{
  "model": "~typesafe/jev-latest",
  "state": { "items": [ { "n": 0, "title": "..." } ] },
  "questions": {
    "q0": {
      "type": "noul",
      "instructions": "Item 3 and Item 7 report the same specific real-world event.",
      "criteria": {
        "true": "Same subject doing the same thing at the same occasion; different angles or languages still count.",
        "false": "Different happenings or occasions, or merely the same industry/company/topic."
      }
    }
  }
}
```

返回：`answers.q0.noul = 0.93`，`usage.input_tokens / cost`。

## 关键用法（官方最佳实践）

1. **一个 question 只问一件具体、边界清晰的事**（"gut-check"，几秒钟能判断的）。复杂判断要拆成多个 question，再用代码组合权重。
2. **同一请求里的 question 并行且互不影响**——多加问题几乎不增加延迟，也不产生上下文串扰。适合"一批独立的二选一判断"。
3. **单请求正文控制在 32KB 以内**；超过会进入 long-context 模式（更慢、更不精确）。
4. **criteria 写具体**：写"什么算 true / 什么算 false"的判定标准，比在 instructions 里堆形容词有效得多。

## 绝对不要做的（我犯过的错）

| 错误 | 后果 |
|---|---|
| 把 Jev 当聊天模型，让它"输出 JSON 分组" | 它根本不生成文本；发了也只会返回不了你要的东西 |
| 用 `typesafe/jev-router` | Router 是"帮你挑模型"的路由器（会把请求转给 Gemini 等生成模型），**不是 Jev 本体**；成本不可控（实测一次 $0.21） |
| 用 OpenRouter 跑通用生成（DeepSeek/Qwen 等） | 已有 opencode 订阅，纯属白花钱 |

## 本项目里的用途（建议）

| 决策点 | 问法 | 类型 |
|---|---|---|
| 两条新闻是否同一事件 | pair 判断 | `noul` |
| 两条 claim 是否同一事实（去重） | pair 判断 | `noul` |
| 两条 claim 是否真冲突（同属性不同值） | pair 判断 | `noul` |
| claim 的时效类型（定义/状态/事件/测量/预测） | 多项分类 | `choice` |
| 内容重要性/耐久度打分 | 评分 | `score` |

**分工原则**：抽取与写作走 opencode（已付费订阅）；**一切"判定/分类/排序"走 Jev**。

## 实测（本项目 395 条新闻）

| 项 | 值 |
|---|---|
| 标定集（63 正 + 25 负） | 阈值 0.5：precision **1.00**、recall **0.84**；阈值 0.8：1.00 / 0.62 |
| 全量 260 个候选对 | 13 个事件簇（38 条），**5 个跨源簇**（含 Nvidia 丑闻 7 篇横跨 NYT+Verge） |
| 成本 | 标定 $0.0065 + 聚类 $0.0175 = **$0.024** |
| 耗时 | 约 12 秒 |
| 对照：router 错误用法 | $0.21（贵 9 倍）、242 秒、且用的是 Gemini 而非 Jev |
