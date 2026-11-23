// 94_schema_pipeline.mjs — 流水线运行记录表
import { openDb } from './lib/db.mjs'
const db = openDb()
db.exec(`
CREATE TABLE IF NOT EXISTS pipeline_run (
  id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT,
  urls INTEGER, new_stories INTEGER, updates INTEGER, duplicates INTEGER,
  severity_json TEXT, qa_json TEXT, report_path TEXT
);
`)
console.log('pipeline_run ready')
db.close()
