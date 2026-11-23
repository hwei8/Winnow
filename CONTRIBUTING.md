# 贡献指南

感谢你有兴趣。这个项目很小，规则也很少。

## 开始之前

```bash
git clone <this-repo> winnow && cd winnow
npm install
npm test          # 不需要任何 API key
npm run check     # 语法检查
```

想跑通完整链路，需要 `.env` 里的 key（见 [.env.example](.env.example) 与 [docs/operations.md](docs/operations.md)）。

## 提交前自检

- [ ] `npm test` 通过
- [ ] `npm run check` 通过
- [ ] 改了行为 → 补了测试或文档
- [ ] 没有提交 `data/`、`out/`、`.env`、`.secrets/`、`*.db`
- [ ] 新的常量/阈值在注释里说明了依据

## 代码约定

- ESM，无分号，两空格缩进；
- 文件头一行说明职责；
- 路径与密钥只从 `src/shared/config.mjs` 取；
- 业务规则放 `src/domains/`，`cli/` 与 `web/` 只做编排与展示；
- 依赖方向单向：`web, cli → domains → providers → shared`。

细节见 [docs/development.md](docs/development.md)。

## 加一个源

RSS 类优先只改 `config/feeds.json`，并跑：

```bash
node src/cli/feed-score.mjs --only=<sourceId>
```

评分低于 50 的源不要合进来（会拉低整条流水线）。

## Pull Request

- 一个 PR 一件事；
- 描述里写清：改了什么、为什么、怎么验证的；
- 涉及策略/阈值/门禁的改动，请附一段真实数据的前后对比。

## 报告问题

用 issue 模板，附上：

- 复现命令；
- 期望 vs 实际；
- 相关日志（`out/daemon.log`、`out/reports/daily-*.md`、`journalctl`）；
- **不要**贴密钥、完整 `.env` 或包含隐私的正文。
