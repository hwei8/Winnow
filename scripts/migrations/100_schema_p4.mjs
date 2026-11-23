// 100_schema_p4.mjs — P4：度量快照 / 重验证 / 本体提案
import { openDb } from './lib/db.mjs'
const db = openDb()
db.exec(`
CREATE TABLE IF NOT EXISTS metric_snapshot (
  id TEXT PRIMARY KEY, at TEXT, metrics_json TEXT
);
CREATE TABLE IF NOT EXISTS revalidation (
  id TEXT PRIMARY KEY, claim_id TEXT, story_id TEXT, reason TEXT,
  at TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS ontology_proposal (
  id TEXT PRIMARY KEY, kind TEXT, payload_json TEXT, status TEXT, created_at TEXT, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reval_claim ON revalidation(claim_id);
CREATE INDEX IF NOT EXISTS idx_onto_status ON ontology_proposal(status);
`)
db.exec('PRAGMA user_version = 15')
console.log('P4 schema:', db.prepare('PRAGMA user_version').get().user_version)
db.close()
