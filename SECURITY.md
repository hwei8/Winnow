# 安全

## 报告漏洞

请**不要**开公开 issue。发邮件到 `security@example.com`，或用 GitHub 的私密漏洞报告（Security → Advisories）。

请在报告里包含：影响范围、复现步骤、以及你建议的修复方向。48 小时内会有人回复。

## 设计上的安全边界

- **无登录**：Web 没有认证。默认应当只监听内网，或放在 Cloudflare Tunnel / 带认证的反代后面。不要在公网裸奔。
- **单用户**：数据库没有多租户隔离，`knowledge_state` / `capture` / `annotation` 都属于同一个使用者。
- **密钥**：只从环境变量或 `.secrets/` 读取；`.secrets/` 与 `.env` 在 `.gitignore` 里。日志不打印密钥。
- **抓取**：只抓 URL 的白名单域名校验在 adapter 层（newsnow 的 heat 源有 `expected_domain` 校验，防 `https://baidu.com@evil.com`）。自建 adapter 请沿用。
- **渲染**：模板对用户输入做 HTML 转义；`/api/frame` 只允许读图片文件。

## 已知风险

| 风险 | 说明 |
|---|---|
| 提示注入 | 抓到的网页正文会进入抽取 prompt。当前只做抽取（不执行指令），但恶意页面可能污染事实。证据层可回溯是兜底：可疑事实能定位回原文并标错。 |
| 依赖 | 只有一个 npm 依赖（`sqlite-vec`）；其余用 Node 标准库。CI 里跑 `npm audit`。 |
| 数据外泄 | providers 会把正文发给 LLM / embedding 服务。介意的话把 provider 换成本地端点。 |
