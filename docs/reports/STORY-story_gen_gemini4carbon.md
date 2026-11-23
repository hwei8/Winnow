# Gemini 4 Carbon 发布：谷歌新一代模型

> 分类：科技｜2523 字｜9 节｜37 个事实锚点（存库）

---

## 发布概要

Sundar Pichai 在 X 上宣布，Gemini 4 Carbon 于今日开始推出。Carbon 被定位为 Google 最强的模型，在网络安全能力和长周期 agentic 工作流方面具备前沿性能。

该模型通过 @GoogleAIStudio 中的 Gemini API 以及 Gemini for business 面向全球提供。

## 定位与原理

Gemini 4 Carbon 的定位，是为持续性的长周期任务而构建。在此基础上，它能够对复杂的软件工程、网络安全和科学发现问题进行深入推理。

从今天起，Carbon 与 Argon 一起成为其产品中的前沿模型系列成员。

## 基准与成本

Carbon 在 CursorBench 4.0、Perplexity 的 WANDR 和 Zapier 的 AutomationBench 上排名第一，且每任务成本比次优外部模型低 2 倍以上。在发布前评估中，Carbon 在 Balyasny Asset Management 的 General Financial Intelligence 基准上，于 23 种前沿模型配置中排名居首。

此外，Google 与 Artificial Analysis 合作推出 Multimodal Knowledge Agent（MKA）基准，Carbon 在该基准上排名第二。在该新基准上，Carbon 的平均每任务成本仍比表现最好的模型低 6 倍以上。

## 定价与可用

Gemini 4 Carbon 通过 Google AI Studio 和 Gemini for business 的 API 向所有付费开发者和企业提供。其定价与 Gemini 4 Argon 相同：每百万输入 token 2 美元、每百万输出 token 10 美元。

介绍期于 2026 年 11 月 30 日结束后，将适用每 100 万输入 token 4 美元和每 100 万输出 token 20 美元的价格。

## 网络安全能力

两周前，Google 通过 Fairwind Program 向一批网络安全防御者发布了 Carbon。借助 Fairwind Program 的访问，Carbon 在漏洞发现、利用和修补的关键基准 SEC-bench Pro、ExploitGym 与 CWE-bench v1 上均处于领先。

在 Project Fortify 的内部基准中，Carbon 在扫描环节达到 100% 召回率；在开源代码仓库测试中，Argon 本已很强的召回率也获得超过 25% 的相对提升。Google 的 Cloud Vulnerability Research 团队最近使用 Carbon 证明，某流行开源软件中的两个漏洞确实可利用。

在 Wiz 的 Scan for Good 项目中，模型扫描两家大型 SaaS 提供商时，在两小时内发现了 0-day 漏洞。

## 安全防护与诚实

在基于 ExploitBench 和 CyScenarioBench 的模拟网络攻击测试环境中，Carbon 阻断了其自适应红队智能体 99% 的攻击轨迹，并在 Gray Swan 测试中将自动化网络攻击查询成功率降至 2.17%，而 Argon 为 9.86%。同时，Carbon 的防护措施将每次尝试的攻破率降至 0.8%，低于 Argon 的 3.1%，并在 Gray Swan IPI benchmark 上实现 0% 的提示注入攻击成功率，首次达到该里程碑。

外部测试中，Trajectory Labs 在 132 小时和超过 13,000 次请求中发现零个新的通用越狱。在诚实性方面，Carbon 在 375 项任务的 agentic honesty benchmark 上通过了 92% 的任务，而 Argon 为 70%。

当实验数据缺失时，Carbon 有 98% 的比例拒绝填补，并指出方法学缺陷的比例为 68%。

## 多智能体演示

谷歌在 Google Antigravity 中预览了 /swarm 功能，能把单个提示转化为可实时追踪的协作智能体团队。在这一机制下，一队 Gemini 4 Carbon 智能体仅凭单个提示，就生成了埃菲尔铁塔 1887–1889 年建造过程的交互式 Three.js 3D 展览。

类似地，多智能体 Carbon 团队借助七个公开市政规划 PDF 中提取的 206 个工程图纸视图和单个提示，通过 /swarm 在 10 轮通宵循环中构建了 Google Platform 37 办公楼的交互式 906K 三角面 Three.js 重建。在 Google Antigravity 的多智能体循环里，Carbon 又根据 CAD 图纸和 X 射线照片重建了一台可演奏的约 1780 年 Stein-Schule 古钢琴，并具备 61 键擒纵机构物理特性。

随后，Carbon 把这台古钢琴放入多伦多皇家音乐学院 Koerner Hall 的 3D 模型中，并呈现出与座位相关的空间声学效果。

## 科研发现

在药物毒性研究公司 Axiom Bio 的转化科学任务中，Carbon 已成为性能领先的模型，并发现了此前未被发现的新毒性机制。在形式化证明方向，AlphaProof Code 智能体随后利用 Carbon 生成了数百万行 Lean 代码。

在 CASP17 盲测集的 7 个低同源蛋白家族中，Carbon 使检索到的同源物数量平均增加 40 倍。

## 影响与结论

对于研究人员和科学家而言，这一安排提供的直接机会是：可通过 Google Antigravity 的最高使用层级申请免费获得 Argon 和 Carbon 的访问权限。该免费访问权限的期限为 6 个月，涉及 Argon 和 Carbon 两项资源。

因此，符合条件的研究人员与科学家可在半年内以最高使用层级免费访问 Argon 和 Carbon。


