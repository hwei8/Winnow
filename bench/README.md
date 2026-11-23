# bench/ — 标注集与基线

这里的文件是**测量基座**：所有阈值（链接、去重、策略、门禁）都必须能在这份数据上说清楚是
"哪个样本量、哪个置信区间"选出来的。没有 provenance 的数字一律视为未标定。

```
bench/
  link.v1.jsonl            250 对「入站条目 × 已有 Story」，逐条标注是否同一事件
  report-link-YYYY-MM-DD.md  bench 生成的基线报告（阈值扫描 / 可靠性 / 推荐值）
```

## 标注

```bash
npm run bench:build -- --task=link --n=125     # 从线上库采样建集（同 seed 结果可复现）
npm run label -- --task=link                   # 交互标注，随时 Ctrl-C，随时续
npm run label -- --task=link --stats           # 只看进度
npm run bench -- --task=link                   # 打分 + 报告
npm run bench -- --task=link --promote=final   # 把推荐阈值写进 config/thresholds.json
```

标注键位：`y` 同一事件 / `n` 不同 / `u` 说不清（不进指标，但留着） / `s` 跳过 /
`h` 标成硬负例（"看起来很像、其实不是"，最能暴露阈值问题） / `q` 保存退出。

**为什么默认不显示分数**：先看模型分数再标，标出来的就是模型的影子，F1 会虚高。
真想看就加 `--show-score`，但那个标签会被记成 `label_meta.blind=false`，正式基线只认盲标。

## 打分口径

`npm run bench` 调的是 `src/domains/knowledge/score.mjs`——与线上 `linkIncoming` 同一条代码路径，
所以量到的不是"另写一份 bench 逻辑"。报告里给两组分数：

- `same_event`：判定器原始输出（0–1）。
- `final`：再套上"事实亲和度补强"（正文余弦失真时把概率抬到 0.8）——线上实际用的就是这个。

## 看什么

1. **加权结论不是 F1**：先看「硬负 FPR」。错并（把新事件并进旧 Story）的代价是污染记忆，
   漏并的代价只是多一篇 Story，所以约束是 precision ≥ 0.90 且硬负 FPR ≤ 0.15。
2. **可靠性表**：如果"说 0.8 的样本里只有六成真是同一事件"，那 0.7 这个阈值就只是排序阈值，
   不能当概率用——ECE 就是这句话的一个数。
3. **推荐阈值**是带约束的自动选择结果，不是最优 F1 点；`--promote` 之前先看它落在哪一行。

## 数据卫生

- `link.v1.jsonl` 里的 `a/b` 文本是采样当时的快照（截断 2000 字），Story 后来重写不影响这一版；
  要测新正文就 `bench:build --out=bench/link.v2.jsonl` 另存一版，别覆盖。
- 数据集与报告都进 git；`*.jsonl` 一次采样几十 KB，值得留档。
