# 运维

## 要求

| 项 | 要求 |
|---|---|
| Node | ≥ 22.16（需要 `node:sqlite` 且内置 SQLite 带 FTS5：22.13.0 没有 FTS5，22.16.0 实测可用；本项目在 v24 上开发） |
| 磁盘 | 库 ~70MB / 1k 篇 Story；`out/` 会持续增长（可定期清理） |
| 网络 | 出站 HTTPS（LLM / embedding / 搜索 / RSS） |
| 依赖 | 无 npm 运行时依赖（只用 Node 内置模块；向量相似度在 JS 里计算） |

单机、单进程、一个 SQLite 文件。不需要 Docker、不需要数据库服务。

## 配置

所有配置走环境变量，或根目录 `.env`（自动加载，不覆盖已有 env）。

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENCODE_GO_API_KEY` | ✅ | chat 模型（抽取 / 成稿 / 简报） |
| `OPENROUTER_API_KEY` | ✅ | embedding（`baai/bge-m3`，1024 维） |
| `ZEN_API_KEY` | ✅ | Jev 判定（免费通道优先，失败自动走 OpenRouter） |
| `DEEPSEEK_SEARCH_TOKEN` | 可选 | 搜索发现 + 正文抓取兜底 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 可选 | 简报推送 |
| `WINNOW_DB` | 可选 | 数据库路径（默认 `data/winnow.db`） |
| `WINNOW_DATA_DIR` / `WINNOW_OUT_DIR` | 可选 | 数据 / 产物目录 |
| `HOST` / `PORT` | 可选 | Web 监听（默认 `127.0.0.1:3083`，只本机可访问） |
| `WINNOW_WEB_TOKEN` | 暴露到局域网时强烈建议 | Web 访问令牌；设置后所有请求都要带（见下文「Web 安全」） |
| `WINNOW_ALLOWED_HOSTS` | 可选 | 反代 / 自定义域名时追加允许的 Host，逗号分隔 |
| `WINNOW_PUBLIC_URL` | 可选 | 简报里 Story 链接的前缀，如 `https://winnow.example.com` |
| `WINNOW_TZ` | 可选 | 简报 / 日报的日期时区（默认 `Asia/Shanghai`） |
| `LLM_CHAT_MODEL` | 可选 | chat 模型名（默认 `deepseek-v4.1-flash`） |
| `WINNOW_ALLOW_PRIVATE_FETCH=1` | 可选 | 允许抓取内网 / 本机地址（默认禁止，防 SSRF；仅本地调试用） |
| `EMBED_PROVIDER` | 可选 | `openrouter`（默认）/ `local` |
| `FETCH_FALLBACK=0` | 可选 | 关闭搜索 API 正文兜底 |

### 密钥的三种放法

1. `.env`（最简单，已在 `.gitignore`）；
2. `.secrets/<name>`：`opencode-go.key`、`openrouter.key`、`zen.key`、`deepseek-search.token`、`telegram.json`（`{"bot_token","chat_id"}`）——所有 provider 都经 `config.readSecret()` 读取，环境变量优先；
3. 复用 DSH 凭据文件：`WINNOW_CREDENTIALS_FILE=/path/.credentials.yaml`。

代码里**没有**默认 key、默认主机名、默认用户目录。

## Web 安全

Web 没有登录系统，写接口（捕获 / 标注 / 深研 / 一键入库）会改库、花 LLM 额度、触发出站抓取。防护分四层：

1. **默认只监听 `127.0.0.1`**。要在手机 / 局域网访问，设置 `HOST=0.0.0.0`；此时 Host 只放行本机网卡地址，`Host: evil.example.com` 之类仍然 403，但**不设 `WINNOW_WEB_TOKEN` 时同网段任何设备都能读写**（启动日志会告警），建议同时设 token；
   首次访问 `http://<ip>:3083/?token=<令牌>`，之后由 HttpOnly cookie 保持。启动时未设令牌会打印警告。
2. **Host 白名单**：未设令牌时只接受 `localhost` / `127.0.0.1` / 本机网卡地址作为 Host，挡 DNS rebinding。
   反代到自定义域名时用 `WINNOW_ALLOWED_HOSTS=winnow.example.com` 追加。
3. **跨站请求防护**：`POST /api/*` 只接受 `application/json`，且 `Origin` / `Sec-Fetch-Site` 必须同源。
4. **出站抓取护栏**（`src/shared/net.mjs`）：入库 URL 只允许公网 http(s)，DNS 解析结果与每一跳重定向都会校验，
   响应体上限 5MB；内网地址也不会被发给第三方正文兜底服务。

另有 CSP（只允许本站脚本）、`X-Frame-Options: DENY`，以及模板里外链的协议白名单（`safeUrl`）。

## 部署

### 最小形态（systemd）

`/etc/systemd/system/winnow-web.service`：

```ini
[Unit]
Description=winnow web
After=network-online.target

[Service]
Type=simple
User=winnow
WorkingDirectory=/srv/winnow
EnvironmentFile=/srv/winnow/.env
ExecStart=/usr/bin/node src/web/server.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/winnow-daily.service` + `.timer`：

```ini
# winnow-daily.service
[Service]
Type=oneshot
User=winnow
WorkingDirectory=/srv/winnow
EnvironmentFile=/srv/winnow/.env
ExecStart=/usr/bin/node src/cli/daemon.mjs --once --send
```

```ini
# winnow-daily.timer
[Unit]
Description=winnow daily run

[Timer]
OnCalendar=*-*-* 08:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now winnow-web.service winnow-daily.timer
journalctl -u winnow-daily -f
```

### 单写者

SQLite 单写者。同时跑两个写入进程（例如 daemon + 手工 pipeline）会互相等锁，极端情况下报 `SQLITE_BUSY`。约定：

- 定时任务只有一个（timer 或 `daemon --loop`，不要都开）；
- Web 的写入是短事务，可并发；
- 批量脚本跑之前停掉 timer。

`daemon.mjs` 自身用 `out/daemon.lock` 防重入。

### 公网访问

Web **没有登录**。要外网访问，放在 Cloudflare Tunnel 或带认证的反向代理后面，别直接暴露端口。

## 备份与恢复

```bash
npm run db:backup           # VACUUM INTO out/backup/p0-<时间>.db（一致性快照，无需停服）
```

恢复：

```bash
systemctl stop winnow-web.service
cp out/backup/winnow-20261122T090000.db data/winnow.db
rm -f data/winnow.db-wal data/winnow.db-shm
systemctl start winnow-web.service
```

建议 cron 每天一次 + 保留 14 天：

```bash
0 3 * * * cd /srv/winnow && npm run db:backup && find out/backup -name 'winnow-*.db' -mtime +14 -delete
```

## 监控

| 检查 | 命令 | 期望 |
|---|---|---|
| 依赖健康 | `npm run health` | 4/4 ok（db / embed / jev / telegram） |
| 降级演练 | `node src/cli/drill.mjs` | 3/3（模拟依赖挂掉时能兜底） |
| 采集健康 | `node src/cli/collect.mjs --health` | 无连续失败 |
| 系统度量 | `npm run metrics` | 追平率、冗余率、QA 均分趋势 |
| 队列积压 | `node src/cli/db.mjs --stats` | `ingest_queue` 的 pending 不应长期 > 50 |

日志：Web 打到 stdout（systemd 收集）；`daemon.mjs` 写 `out/daemon.log`；每次流水线写 `out/reports/daily-*.md`。

## 排错

| 现象 | 常见原因 | 处理 |
|---|---|---|
| `SQLITE_BUSY` | 多个写入进程 | 停掉重复的定时任务；`PRAGMA busy_timeout` 已设 4s |
| 抽取全是 `unverified` | 正文抓取只拿到摘要 | 检查 `content_source`；启 `DEEPSEEK_SEARCH_TOKEN` 兜底 |
| 新条目 `too-short` | 站点反爬 / 需要 JS | 换 feed、或用搜索 API fetch；必要时给该源加专用 adapter |
| Jev 报 429 | 免费通道限流 | 自动切 OpenRouter；`JEV_FALLBACK=0` 会关闭兜底 |
| embedding 全挂 | key 或额度 | `npm run health` 看 `embed-*`；切 `EMBED_PROVIDER=local` |
| 简报为空 | 窗口内没有更新 | `npm run brief -- --hours=72` 验证；检查 `story_update` 是否在写 |
| Web 500 | 查询层改动 | `node --test tests/web-queries.test.mjs`；看 stdout 的 `[error]` 行 |
| 同一篇被建了两次 | 链接判定阈值偏松 | 看 `ingest_decision`；用 `link-audit` 找可合并对 |

## 成本控制

`token_ledger` 记录每次调用的 token 与成本，`/audit` 有 Token 账本面板。三个阀门：

1. `pipeline` 的 `--limit`（每天采多少）；
2. 抽取的分块数（每篇 1–12 块，块数≈字数/3500，可用 `EXTRACT_CHUNK_CHARS` / `EXTRACT_MAX_CHUNKS` 调）；
3. 重写策略（P4 不写、P2 先合并）——这是最大的省钱项。

按每天 30 篇新 Story：≈0.4M tokens/天，个人预算内几乎无感。真正的瓶颈是正文抓取成功率。
