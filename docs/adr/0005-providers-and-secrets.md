# ADR 0005 — 外部能力走 provider 薄封装，密钥只从配置层读

- 状态：已采纳
- 相关：`src/providers/`、`src/shared/config.mjs`

## 背景

早期代码直接在模块顶层 `readFileSync('~/.dsh/.credentials.yaml')` 并 `const KEY = ...`。后果：任何 import 都会读密钥，测试与 CI 无法运行，换 provider 要改业务代码。

## 决策

1. 每个外部能力一个 provider 模块，暴露**语义化**函数（`chat`, `embedBatch`, `noulBatch`, `search`, `send`）；
2. 密钥**惰性**读取（首次调用时），且解析顺序固定：环境变量 → `.secrets/<name>` → 可选凭据文件；
3. 所有 provider 支持降级：embedding 主备、Jev Zen→OpenRouter、正文直连→搜索 API；
4. 业务域只认 provider 的语义，不认 HTTP 细节。

## 后果

- ✅ 测试零网络、零密钥；
- ✅ 换模型 = 改一个 provider 或一个环境变量；
- ✅ 降级路径可演练（`cli/drill.mjs`）；
- ⚠️ provider 内部要维护重试/限速/用量记账（分散但可控）。

## 备选

| 方案 | 为什么不选 |
|---|---|
| 直接用各家 SDK | 依赖变重，且各家 SDK 的重试语义不一致 |
| 引入统一 AI 网关 | 多一层运维；本项目只需要 4 个端点 |
