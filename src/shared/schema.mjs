// 数据库 schema（唯一权威定义）。
//
// 由 v16 线上库导出：新库执行 applySchema() 即可得到与生产一致的形态；
// 历史增量迁移脚本不再参与建库（见 docs/adr/0002-schema-as-code.md）。

export const SCHEMA_VERSION = 17
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS adapter_health (adapter TEXT, checked_at TEXT, ok INTEGER, latency_ms INTEGER, detail TEXT, PRIMARY KEY(adapter, checked_at));

CREATE TABLE IF NOT EXISTS annotation (
  id          TEXT PRIMARY KEY,
  target_type TEXT, target_id TEXT,
  kind        TEXT,                 -- known|unknown|important|wrong|agree|disagree|save
  comment     TEXT,
  at          TEXT
, meta_json TEXT);

CREATE TABLE IF NOT EXISTS beat_report (
  id TEXT PRIMARY KEY, generated_at TEXT, topics_json TEXT, findings_json TEXT
);

CREATE TABLE IF NOT EXISTS briefing (
  id TEXT PRIMARY KEY,
  date TEXT,
  generated_at TEXT,
  window_hours INTEGER,
  items_json TEXT,
  stats_json TEXT
);

CREATE TABLE IF NOT EXISTS capture (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- idea / todo / decision / reference / life
  content TEXT NOT NULL,
  intent TEXT,                     -- 为什么存
  review_at TEXT,                  -- 什么场景/什么时候该再出现
  target_type TEXT,                -- 可选：关联 story/entity/claim
  target_id TEXT,
  status TEXT DEFAULT 'inbox',     -- inbox / filed / archived
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS capture_link (
  capture_id TEXT, target_type TEXT, target_id TEXT, relation TEXT,
  PRIMARY KEY (capture_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS claim (
  id           TEXT PRIMARY KEY,
  story_id     TEXT,
  item_id      TEXT NOT NULL,       -- 首次出现来源
  text         TEXT NOT NULL,
  kind         TEXT,                -- fact|number|quote|prediction|opinion|decision
  subject      TEXT,                -- 类型化尝试（可空）
  predicate    TEXT,
  object_text  TEXT,
  confidence   REAL DEFAULT 0.5,
  extractor    TEXT,                -- llm:<model> | legacy
  created_at   TEXT
, object_value_json TEXT, is_meta INTEGER DEFAULT 0, status TEXT DEFAULT 'active', asserted_at TEXT, world_from TEXT, world_to TEXT, superseded_by TEXT, superseded_at TEXT, source_tier INTEGER, temporal_kind TEXT, validity_mode TEXT, temporal_confidence REAL, embedding BLOB, fact_id TEXT);

CREATE TABLE IF NOT EXISTS claim_dup (
  keep_id     TEXT NOT NULL,
  dup_id      TEXT NOT NULL,
  similarity  REAL,
  route       TEXT,
  judged_by   TEXT,
  at          TEXT,
  PRIMARY KEY (keep_id, dup_id)
);

CREATE TABLE IF NOT EXISTS claim_entity (
  claim_id  TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (claim_id, entity_id)
);

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id     TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  stance       TEXT DEFAULT 'supports',
  segment_from INTEGER,
  segment_to   INTEGER,
  time_start   REAL,
  time_end     REAL,
  frame_id     TEXT,
  excerpt      TEXT,
  verified     INTEGER DEFAULT 0,
  PRIMARY KEY (claim_id, item_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS claim_fts USING fts5(
  text, content='claim', content_rowid='rowid', tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS cluster_audit (
  story_id    TEXT PRIMARY KEY,
  verdict     TEXT,            -- same_event | mixed | split
  anchor      TEXT,
  reason      TEXT,
  at          TEXT
);

CREATE TABLE IF NOT EXISTS entity (
  id      TEXT PRIMARY KEY,
  type    TEXT NOT NULL,            -- uploader|product|org|concept|person|place
  name    TEXT NOT NULL,
  aliases TEXT                      -- JSON 数组
);

CREATE TABLE IF NOT EXISTS fact (
  id TEXT PRIMARY KEY,
  canonical_text TEXT NOT NULL,
  subject TEXT, predicate TEXT, object_text TEXT,
  temporal_kind TEXT, validity_mode TEXT,
  confidence REAL,
  first_seen TEXT, last_updated TEXT,
  superseded_by TEXT,
  support_count INTEGER DEFAULT 0,
  source_count INTEGER DEFAULT 0,   -- 独立源数（distinct item.source_id）。support_count 只是 claim 数，
                                    -- 同一篇文章里的两条 claim 不是两个源，v17 起所有"关键事实"判定都用这个。
  category TEXT
);

CREATE TABLE IF NOT EXISTS fact_claim (
  fact_id TEXT, claim_id TEXT, stance TEXT DEFAULT 'supports',
  observed_at TEXT,
  PRIMARY KEY (fact_id, claim_id)
);

CREATE TABLE IF NOT EXISTS frame (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL,
  segment_idx INTEGER,
  at_sec      REAL,
  path        TEXT,
  has_subtitle INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hot_crawl (
  at TEXT PRIMARY KEY,
  platforms INTEGER,
  entries INTEGER,
  errors TEXT
);

CREATE TABLE IF NOT EXISTS hot_entry (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  mobile_url TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  appearances INTEGER DEFAULT 1,
  best_rank INTEGER,
  last_rank INTEGER,
  heat REAL DEFAULT 0,
  promoted_item_id TEXT,
  UNIQUE(platform, url)
);

CREATE TABLE IF NOT EXISTS hot_rank (
  entry_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(entry_id, at)
);

CREATE TABLE IF NOT EXISTS ingest_decision (
  item_id TEXT PRIMARY KEY, action TEXT, parent_story_id TEXT, same_event REAL,
  gap_count INTEGER, claims INTEGER, decided_at TEXT
);

CREATE TABLE IF NOT EXISTS ingest_queue (
  id TEXT PRIMARY KEY, url TEXT, source TEXT, status TEXT,
  created_at TEXT, started_at TEXT, finished_at TEXT, result TEXT
);

CREATE TABLE IF NOT EXISTS interest (
  topic TEXT PRIMARY KEY,
  weight REAL DEFAULT 1.0,
  created_at TEXT,
  note TEXT
, kind TEXT DEFAULT 'topic', last_report_at TEXT);

CREATE TABLE IF NOT EXISTS item (
  id            TEXT PRIMARY KEY,
  source_id     TEXT REFERENCES source(id),
  url           TEXT,
  title         TEXT,
  author        TEXT,
  published_at  TEXT,                 -- ISO
  published_ts  INTEGER,              -- unix 秒（便于范围查询）
  media_kind    TEXT,                 -- video
  duration_sec  REAL,
  view_count    INTEGER,
  like_count    INTEGER,
  comment_count INTEGER,
  description   TEXT,
  dir           TEXT,                 -- 原始 dossier 目录
  segment_count INTEGER,
  char_count    INTEGER,
  asr_quality   REAL,                 -- 0..1，本 P0 用异常 token 密度反推
  script_variant TEXT,                -- hans|hant|mixed
  frame_count   INTEGER
, content_source TEXT, lang TEXT, durability REAL);

CREATE TABLE IF NOT EXISTS item_block (
  item_id    TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end   INTEGER NOT NULL,
  kind       TEXT DEFAULT 'paragraph',
  PRIMARY KEY (item_id, idx)
);

CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(
  title, description, content='item', content_rowid='rowid', tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS item_segment (
  item_id   TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec   REAL NOT NULL,
  text_raw  TEXT NOT NULL,
  PRIMARY KEY (item_id, idx)
);

CREATE TABLE IF NOT EXISTS item_topic (
  item_id  TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  source   TEXT,                    -- tag|llm
  PRIMARY KEY (item_id, topic_id)
);

CREATE TABLE IF NOT EXISTS knowledge_state (
  scope       TEXT NOT NULL,        -- story|topic|entity|item
  ref_id      TEXT NOT NULL,
  level       TEXT NOT NULL,        -- unseen|headline|gist|detail|exhaustive
  frontier_at TEXT,
  updated_at  TEXT,
  source      TEXT,
  PRIMARY KEY (scope, ref_id)
);

CREATE TABLE IF NOT EXISTS legacy_doc (
  item_id     TEXT PRIMARY KEY,
  tldr        TEXT,
  detailed    TEXT,
  key_topics  TEXT,                 -- JSON [{timestamp,title,description}]
  tags        TEXT,                 -- JSON
  model_guess TEXT,
  ratio       REAL                  -- detailed/转写，质量参差指标
);

CREATE TABLE IF NOT EXISTS metric_snapshot (
  id TEXT PRIMARY KEY, at TEXT, metrics_json TEXT
);

CREATE TABLE IF NOT EXISTS ontology_proposal (
  id TEXT PRIMARY KEY, kind TEXT, payload_json TEXT, status TEXT, created_at TEXT, decided_at TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_run (
  id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT,
  urls INTEGER, new_stories INTEGER, updates INTEGER, duplicates INTEGER,
  severity_json TEXT, qa_json TEXT, report_path TEXT
);

CREATE TABLE IF NOT EXISTS research (
  id TEXT PRIMARY KEY, story_id TEXT, kind TEXT, content TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS revalidation (
  id TEXT PRIMARY KEY, claim_id TEXT, story_id TEXT, reason TEXT,
  at TEXT, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS source (
  id          TEXT PRIMARY KEY,
  adapter_id  TEXT NOT NULL,          -- 'bilibili' | 'youtube' | 'dossier'
  name        TEXT NOT NULL,          -- up 主名
  external_id TEXT,
  tier        INTEGER DEFAULT 3,
  lang        TEXT
);

CREATE TABLE IF NOT EXISTS source_quality (
  source_id TEXT PRIMARY KEY,
  items INTEGER, claims INTEGER, contested INTEGER,
  verified_rate REAL, wrong_hits INTEGER, score REAL, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS stance (
  id TEXT PRIMARY KEY,
  target_type TEXT, target_id TEXT,
  position TEXT, rationale TEXT,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS stance_revision (
  id TEXT PRIMARY KEY, stance_id TEXT, position TEXT, rationale TEXT,
  source_annotation_id TEXT, at TEXT
);

CREATE TABLE IF NOT EXISTS story (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  status        TEXT DEFAULT 'active',
  item_count    INTEGER DEFAULT 0,
  first_seen_ts INTEGER,
  last_update_ts INTEGER,
  summary_seed  TEXT              -- 旧摘要拼出的初版骨架（hint，非事实）
, anchor TEXT, validated INTEGER DEFAULT 0, category TEXT, category_confidence REAL, body_md TEXT, title_original TEXT, merged_into TEXT, story_kind TEXT DEFAULT 'story');

CREATE TABLE IF NOT EXISTS story_fact (
  story_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  section_id TEXT,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  role TEXT DEFAULT 'asserts',
  order_idx INTEGER,
  PRIMARY KEY (story_id, fact_id, char_start)
);

CREATE TABLE IF NOT EXISTS story_item (
  story_id TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  role     TEXT DEFAULT 'report',
  PRIMARY KEY (story_id, item_id)
);

CREATE TABLE IF NOT EXISTS story_link (
  story_id TEXT, related_story_id TEXT, relation TEXT,
  same_event_prob REAL, overlap REAL, gap_count INTEGER, gap_facts_json TEXT,
  created_at TEXT,
  PRIMARY KEY (story_id, related_story_id)
);

CREATE TABLE IF NOT EXISTS story_qa (
  story_id TEXT PRIMARY KEY,
  score REAL,
  coverage REAL,
  dup_rate REAL,
  conflict_count INTEGER,
  anchor_count INTEGER,
  fact_count INTEGER,
  missed_facts INTEGER,
  issues_json TEXT,
  qa_version INTEGER DEFAULT 0,     -- 打分公式版本。跨版本求均值没有意义（历史 86.8→80.6 的"下降"大半是换公式）
  checked_at TEXT
);

CREATE TABLE IF NOT EXISTS story_section (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  order_idx INTEGER NOT NULL,
  heading TEXT,
  body_md TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS story_source (
  story_id TEXT, item_id TEXT, role TEXT,
  PRIMARY KEY (story_id, item_id)
);

CREATE TABLE IF NOT EXISTS story_update (
  id TEXT PRIMARY KEY, story_id TEXT, at TEXT, change_type TEXT,
  detail_json TEXT
, severity TEXT, action TEXT, reason TEXT);

CREATE TABLE IF NOT EXISTS story_version (
  story_id TEXT, version INTEGER, body_md TEXT, sections_json TEXT, facts_json TEXT,
  category TEXT, created_at TEXT, note TEXT,
  PRIMARY KEY (story_id, version)
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id TEXT PRIMARY KEY, at TEXT, task TEXT, model TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
  cost REAL, ref TEXT, latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS topic (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topic_alias (
  topic TEXT, alias TEXT, lang TEXT, created_at TEXT,
  PRIMARY KEY (topic, alias)
);

CREATE INDEX IF NOT EXISTS idx_annotation_target ON annotation(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_beat_time ON beat_report(generated_at);

CREATE INDEX IF NOT EXISTS idx_block_item ON item_block(item_id, idx);

CREATE INDEX IF NOT EXISTS idx_brief_date ON briefing(date);

CREATE INDEX IF NOT EXISTS idx_capture_review ON capture(review_at);

CREATE INDEX IF NOT EXISTS idx_capture_status ON capture(status);

CREATE INDEX IF NOT EXISTS idx_ce_entity ON claim_entity(entity_id);

CREATE INDEX IF NOT EXISTS idx_claim_fact ON claim(fact_id);

CREATE INDEX IF NOT EXISTS idx_claim_item  ON claim(item_id);

CREATE INDEX IF NOT EXISTS idx_claim_sp ON claim(subject,predicate,status);

CREATE INDEX IF NOT EXISTS idx_claim_story ON claim(story_id);

CREATE INDEX IF NOT EXISTS idx_claim_subj  ON claim(subject);

CREATE INDEX IF NOT EXISTS idx_claim_temporal ON claim(temporal_kind, validity_mode);

CREATE INDEX IF NOT EXISTS idx_dup_dup ON claim_dup(dup_id);

CREATE INDEX IF NOT EXISTS idx_entity_name ON entity(name);

CREATE INDEX IF NOT EXISTS idx_entity_type ON entity(type);

CREATE INDEX IF NOT EXISTS idx_ev_item ON claim_evidence(item_id);

CREATE INDEX IF NOT EXISTS idx_fact_cat ON fact(category);

CREATE INDEX IF NOT EXISTS idx_frame_item ON frame(item_id, segment_idx);

CREATE INDEX IF NOT EXISTS idx_hot_platform ON hot_entry(platform, last_rank);

CREATE INDEX IF NOT EXISTS idx_hot_rank_entry ON hot_rank(entry_id, at);

CREATE INDEX IF NOT EXISTS idx_hot_seen ON hot_entry(last_seen);

CREATE INDEX IF NOT EXISTS idx_it_topic ON item_topic(topic_id);

CREATE INDEX IF NOT EXISTS idx_item_pub    ON item(published_ts);

CREATE INDEX IF NOT EXISTS idx_item_source ON item(source_id);

CREATE INDEX IF NOT EXISTS idx_ks_scope ON knowledge_state(scope, level);

CREATE INDEX IF NOT EXISTS idx_link_story ON story_link(story_id);

CREATE INDEX IF NOT EXISTS idx_onto_status ON ontology_proposal(status);

CREATE INDEX IF NOT EXISTS idx_qa_score ON story_qa(score);

CREATE INDEX IF NOT EXISTS idx_queue_status ON ingest_queue(status);

CREATE INDEX IF NOT EXISTS idx_research_story ON research(story_id, kind);

CREATE INDEX IF NOT EXISTS idx_reval_claim ON revalidation(claim_id);

CREATE INDEX IF NOT EXISTS idx_seg_item ON item_segment(item_id, idx);

CREATE INDEX IF NOT EXISTS idx_stance_target ON stance(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_story_fact_story ON story_fact(story_id, char_start);

CREATE INDEX IF NOT EXISTS idx_story_section_story ON story_section(story_id, order_idx);
`

/** 在给定连接上建表（幂等：全部 CREATE ... IF NOT EXISTS）。 */
/**
 * 存量库增量迁移：SQLite 没有 `ADD COLUMN IF NOT EXISTS`，所以按 pragma 逐个补，幂等。
 * 新库不会走到这里（建表语句里已经有这些列）。
 */
export function migrateSchema (db) {
  const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name))
  const factCols = cols('fact')
  if (!factCols.has('source_count')) db.exec('ALTER TABLE fact ADD COLUMN source_count INTEGER DEFAULT 0')
  const qaCols = cols('story_qa')
  if (!qaCols.has('qa_version')) db.exec('ALTER TABLE story_qa ADD COLUMN qa_version INTEGER DEFAULT 0')

  // 回填独立源数：同一 item 的两条 claim 只算一个源。
  db.exec(`UPDATE fact SET source_count = COALESCE((
    SELECT COUNT(DISTINCT i.source_id) FROM fact_claim fc
      JOIN claim c ON c.id = fc.claim_id
      JOIN item i ON i.id = c.item_id
     WHERE fc.fact_id = fact.id), 0)`)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

export function applySchema (db) {
  db.exec(SCHEMA_SQL)
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version < SCHEMA_VERSION) migrateSchema(db)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}
