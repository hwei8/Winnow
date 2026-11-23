# 机器迁移检查（2026-11-22）

新机器：`<repo>`（旧：`<old-repo>`），Node v24.14，Web `<lan-host>:3083`。

## 已修复

| 文件 | 问题 | 修复 |
|---|---|---|
| `lib/db.mjs` | `SUMMARY_ROOT` 写死 `/workspace/Summary` | 自动探测：env → `/workspace/Summary` → 项目同级 `Summary` |
| `web/queries.mjs` | DB 路径写死 `/workspace/...` | `import.meta.dirname` 相对定位 |
| `web/write.mjs` | 同上 + 缺 `path` 导入 | 同上 |
| `health.mjs` / `drill.mjs` | 密钥路径 / cwd 写死 | 改用 `ROOT` 与脚本目录 |
| `74_extract_assign_facts.mjs` | 密钥路径写死 | 改为相对 `import.meta.url` |
| `web/server.mjs` | 启动日志写死路径 | 用 `DB_PATH` |
| `worker_ingest.mjs` | 83 抓取失败仍标 `done` | 解析报告，全部失败 → `failed` |

## 验证通过

- `health.mjs`：DB / 本地 embedding / Jev Zen / Telegram 4/4
- `drill.mjs`：embed→OpenRouter、Jev→OpenRouter、Telegram 错误处理 3/3
- `pipeline.mjs`：维护链路 + `--adapter=hn` 全链路 OK
- `brief.mjs`：LLM 生成 2 必看 / 6 兴趣 / 2 探索
- Web 九页 + Story 页 全部 200
- `capture`（CLI/API）、`annotation`（含 knowledge_state/stance 联动）
- `evidence_gate.mjs` 抽样 50/50 可定位
- `daemon.mjs --once --steps=metrics`、`export.mjs`、`metrics.mjs`
- Telegram 发送成功（message_id 1715）

## 遗留问题（已确认处理）

1. **`Summary/` 不再迁移**：它是测试用初始语料；`frame` 表旧路径只影响 `/api/frame` 截图，正文/claim/Story 不受影响，后续重建库时清掉。
2. **Embedding 走本地 8033（<lan-host> 已恢复）**：`lib/embed.mjs` 默认 `EMBED_PROVIDER=local`，失败回退 OpenRouter `baai/bge-m3`（向量 cos 0.99994，可无缝互换）。见 DECISIONS D54。
3. Web 地址：`http://<lan-host>:3083`。
4. `im_capture.mjs` 与 DSH Telegram 轮询的 409 冲突提醒仍有效。

## 数据完整性

`PRAGMA integrity_check = ok`，`user_version = 15`；424 Story / 399 正文 / 330 活跃 / 6,804 claim / 6,285 fact。
