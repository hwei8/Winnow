# Web

一个零依赖的 SSR 服务：`node:http` + 字符串模板 + 少量原生 JS。没有框架、没有构建步骤、没有前端依赖。

```bash
npm run web                                   # 默认 http://127.0.0.1:3083（只本机）
PORT=8080 npm run web
HOST=0.0.0.0 WINNOW_WEB_TOKEN=… npm run web   # 局域网访问：必须设令牌，见 docs/operations.md「Web 安全」
```

## 页面

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | 无限流 | 广度分区：未读更新 / 今天 / 7 天内 / 更早；可切「只看未追平」 |
| `/story/:id` | Story 详情 | 正文 + 事实锚点（hover 看证据）+ 时间线 + 标注条 + 相关 Story |
| `/entity/:id` | 实体 | 提及它的 Story / 事实 / 别名 |
| `/topics` | 覆盖地图 | 主题的 Story 数、源数、最近更新、缺口 |
| `/topic/:name` | 主题详情 | 覆盖情况 + 关注按钮 |
| `/search` | 搜索 | FTS5 trigram，命中事实/Story 高亮 |
| `/claims` | 数据质量 | 有争议 / 被取代 / 低置信 / 缺证据 |
| `/brief` | 简报 | 今日三通道 + 历史 |
| `/memory` | 我要记住的 | 捕获表单 + 最近捕获 + 到期待复核 |
| `/stance` | 立场 | 改过的立场与修正史 |
| `/audit` | 审计 | 源健康、为什么没推、Token 账本、标注消费率 |

## JSON 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/stats` | 计数概览（带 60s 缓存） |
| GET | `/api/stream?offset=&limit=&sort=&filter=` | 流式分页 |
| GET | `/api/story/:id` | Story 全量（含 sections / facts / 证据） |
| GET | `/api/story/:id/facts` | 只取事实与证据（hover 面板用） |
| GET | `/api/entity/:id` | 实体 |
| GET | `/api/search?q=` | 搜索 |
| GET | `/api/item/:id` | 单条原文（可选） |
| POST | `/api/capture` | 写一条捕获 |
| POST | `/api/state` | 设置知识水位 |
| POST | `/api/annotation` | 标注 |
| POST | `/api/interest` | 关注 / 取关主题 |
| POST | `/api/ingest` · `/api/ingest-run` | 入队 / 后台抓取入库 |
| POST | `/api/research` | 生成 L4 深研（缓存） |

## 代码分层

```
server.mjs        路由 + 渲染 + 静态资源（无业务规则）
queries.mjs       barrel
queries/*.mjs     按页面域的只读查询
db.mjs            只读连接、语句缓存、SQL 小工具
shared.mjs        展示字段装饰（decorateClaim 等）
views/fmt.mjs     纯格式化函数（无 IO）
views/templates.mjs HTML 片段生成器（纯函数）
public/           app.js（交互）、style.css、HTML 骨架
write.mjs         唯一写入路径
```

**只读查询层原则**：`queries/*` 只做 `SELECT`；任何写操作走 `write.mjs`。这样「浏览」永远不会意外改数据。

## 加一个页面

1. 在 `src/web/queries/<域>.mjs` 加一个 `getXxx()`（只读）；
2. 在 `src/web/views/templates.mjs` 加渲染函数；
3. 在 `src/web/server.mjs` 的路由里挂上；
4. 在 `src/web/public/app.js` 加交互（如果需要）；
5. 在 `tests/web-queries.test.mjs` 里加一条断言（空库也能跑）。

## 验收

```bash
node src/cli/verify-web.mjs      # 起来一个服务，逐页 HTTP 检查（零依赖）
```

## 已知取舍

- **无登录**：默认只监听内网。要上公网必须放在 Cloudflare Tunnel / 反代 + 认证后面。
- **无前端框架**：交互靠 `app.js` 里几百行原生 JS；换来的是首屏快、可 grep、无构建。
- **不做 engagement**：没有推荐流刷新、没有无限下拉的诱导；分页是显式的。
