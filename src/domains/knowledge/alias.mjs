// knowledge/alias.mjs — 主题英文/别名映射（供 Beat 在外媒检索）
import { nowIso } from '../../shared/db.mjs'

const SEED = {
  英伟达: ['Nvidia', 'NVIDIA'],
  谷歌: ['Google'],
  微软: ['Microsoft'],
  苹果: ['Apple'],
  特斯拉: ['Tesla'],
  台积电: ['TSMC'],
  华为: ['Huawei'],
  三星: ['Samsung'],
  英特尔: ['Intel'],
  超威: ['AMD'],
  中芯国际: ['SMIC'],
  阿斯麦: ['ASML'],
  反物质: ['antimatter', 'CERN'],
  人工智能: ['artificial intelligence', 'AI'],
  半导体: ['semiconductor'],
  芯片: ['chip', 'semiconductor'],
  加密货币: ['crypto'],
  美联储: ['Federal Reserve', 'Fed'],
  英伟达调查: ['Nvidia investigation', 'Jensen Huang']
}

export function seedAliases (db) {
  const ins = db.prepare('INSERT OR IGNORE INTO topic_alias(topic,alias,lang,created_at) VALUES (?,?,?,?)')
  let n = 0
  for (const [topic, aliases] of Object.entries(SEED)) {
    for (const a of aliases) { ins.run(topic, a, /[\u4e00-\u9fa5]/.test(a) ? 'zh' : 'en', nowIso()); n++ }
  }
  return n
}

export function aliasesFor (db, topic) {
  const rows = db.prepare('SELECT alias FROM topic_alias WHERE topic=?').all(topic)
  return rows.length ? rows.map(r => r.alias) : []
}

export function addAlias (db, topic, alias) {
  db.prepare('INSERT OR IGNORE INTO topic_alias(topic,alias,lang,created_at) VALUES (?,?,?,?)')
    .run(topic, alias, /[\u4e00-\u9fa5]/.test(alias) ? 'zh' : 'en', nowIso())
  return aliasesFor(db, topic)
}
