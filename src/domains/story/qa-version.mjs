// story/qa-version.mjs — 打分公式版本号（qa.mjs 写库时用，metrics/audit 读库时用）
//
// 分数公式一改，历史均值就不再可比。所有"跨 Story 求平均"的地方都必须按这个版本过滤；
// 版本号加一意味着旧数据要么重算，要么单独展示。
export const QA_VERSION = 4
