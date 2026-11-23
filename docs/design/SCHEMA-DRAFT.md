# SCHEMA-DRAFT.md — 结构化记忆模型（v0.1）

> 目标不是"存得下"，而是**能浏览、能查询、能检测冲突、能时间旅行**。
> 本文是 D3（schema-first）的落地草案。数据库：SQLite（WAL）。JSON 字段用 `jsonb` 语义（SQLite 里是 TEXT + `json_extract`）。

---

## 1. 设计的四个硬需求

1. **浏览**：按实体 / 议题 / 事件 / 时间 / 状态翻，而不是只能搜。
2. **事实查询**：能回答"DeepSeek V4.1 的定价是多少"这种结构化问题，而不是返回一段文本让你自己读。
3. **冲突与时间**：同一事实被多次陈述、被修正、被推翻时，系统要知道"哪个是当前有效版本"、"什么时候变成那样的"。
4. **我的立场**：我对某实体/议题的看法本身是一等记忆，且会演化。

---

## 2. 五层核心：Source → Item → Story → Claim → State

```
source ──1:N── item ──N:M── story ──1:N── claim ──N:M── entity
                 │                          │
                 └──── evidence ────────────┘
                                            │
                            knowledge_state / annotation / stance
```

- **item**：一篇具体内容（不可变，只增不改）
- **story**：一件事的聚合与规范化页面（由 Editor Agent 持续维护）
- **claim**：最小可陈述、可独立验证的信息单元（**系统的主角**）
- **entity**：人/组织/产品/地点/概念
- **state**：我知道到什么程度 / 我的标注 / 我的立场

---

## 3. 双时间轴（这是结构化记忆的关键）

每一句"事实"有四个时间戳，缺一不可：

| 字段 | 含义 | 例子 |
|---|---|---|
| `world_from` / `world_to` | 在**真实世界**里，这个事实何时成立 | 2026-10-01 起该产品定价 $0.75/千次 |
| `asserted_at` | **信息源**声称的时间 | 官方公告发布于 2026-10-16 |
| `recorded_at` | **我们**记录的时间 | 我们 2026-11-10 才抓到 |
| `superseded_at` | 被更强证据取代的时间 | 2026-12-01 涨价，旧 claim 失效 |

没有这套时间轴，"记忆"会退化成"最后一条覆盖前一条"，你也永远无法回答"我上个月以为的是什么"。

---

## 4. DDL 草案

### 4.1 源与条目

```sql
CREATE TABLE source_adapter (
  id            TEXT PRIMARY KEY,          -- 'rss-main', 'arxiv', 'manual'
  kind          TEXT NOT NULL,             -- rss|atom|api|mail|manual|web
  version       TEXT NOT NULL,
  config_json   TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  health_json   TEXT,                      -- 最近一次自检
  last_run_at   TEXT,
  CHECK (json_valid(config_json))
);

CREATE TABLE source (
  id            TEXT PRIMARY KEY,
  adapter_id    TEXT NOT NULL REFERENCES source_adapter(id),
  name          TEXT NOT NULL,
  homepage      TEXT,
  tier          INTEGER NOT NULL DEFAULT 3,  -- 1=一手/官方 2=专业媒体 3=聚合/自媒体 4=未知
  lang          TEXT,
  paywalled     INTEGER DEFAULT 0,
  policy_json   TEXT,                        -- 限速、全文/摘要、屏蔽规则
  known_bias    TEXT,                        -- 立场标注（可选，影响"分歧槽"选取）
  created_at    TEXT NOT NULL
);

CREATE TABLE item (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES source(id),
  url             TEXT NOT NULL,
  url_norm        TEXT NOT NULL,
  title           TEXT,
  author          TEXT,
  published_at    TEXT,
  fetched_at      TEXT NOT NULL,
  lang            TEXT,
  media_kind      TEXT,                      -- article|video|podcast|paper|post
  content_hash    TEXT NOT NULL,
  simhash         INTEGER,                   -- L1 近重复
  raw_path        TEXT,                      -- 原文/转写文件位置
  extracted_text  TEXT,                      -- 规范化正文（长文可放文件+摘要入表）
  word_count      INTEGER,
  -- 转写质量（视频/播客源必需，见 DATA-AUDIT 第 3 节）
  asr_quality     REAL,                      -- 0..1；技术术语损坏的视频可低到 0.3
  script_variant  TEXT,                      -- hans|hant|mixed（Whisper 会漂移）
  normalization   TEXT,                      -- JSON: {punct_restored,ocr_corrected,translated}
  status          TEXT NOT NULL DEFAULT 'fresh', -- fresh|clustered|dropped|error
  UNIQUE (url_norm)
);
CREATE INDEX idx_item_published ON item(published_at);
CREATE INDEX idx_item_simhash   ON item(simhash);
CREATE INDEX idx_item_source    ON item(source_id, published_at);

-- 视频/播客：ASR 段（证据的一等公民；时间戳不能丢）
CREATE TABLE item_segment (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES item(id),
  idx         INTEGER NOT NULL,             -- 段序，与帧文件名 transcript_<idx>_<start>.jpg 对应
  start_sec   REAL NOT NULL,
  end_sec     REAL NOT NULL,
  text_raw    TEXT NOT NULL,                -- ASR 原文（永不改写，可审计）
  text_fixed  TEXT,                         -- 繁简统一/标点恢复/OCR 术语校正后
  UNIQUE (item_id, idx)
);
CREATE INDEX idx_segment_item ON item_segment(item_id, idx);

-- 截图帧：视觉证据 + 烧录字幕 OCR（纠错与人工核验入口）
CREATE TABLE frame (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES item(id),
  segment_idx INTEGER,                      -- 与 item_segment.idx 对应（实测中位数 1:1）
  at_sec      REAL NOT NULL,
  path        TEXT NOT NULL,
  ocr_text    TEXT,                         -- 烧录字幕/画面文字
  ocr_confidence REAL,
  kind        TEXT                          -- subtitle|slide|code|chart|talking_head
);
CREATE INDEX idx_frame_item ON frame(item_id, segment_idx);
```

### 4.2 事件与主张

```sql
CREATE TABLE story (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  canonical_summary TEXT,                    -- Editor Agent 维护的规范化摘要
  summary_version   INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',  -- active|cooled|archived|merged
  first_seen_at     TEXT NOT NULL,
  last_update_at    TEXT NOT NULL,
  novelty_frontier  TEXT,                    -- "读到这个时间点就没有新东西了"
  hotness           REAL DEFAULT 0,
  merged_into       TEXT REFERENCES story(id),
  embedding_ref     TEXT
);
CREATE INDEX idx_story_update ON story(last_update_at DESC);
CREATE INDEX idx_story_status ON story(status, last_update_at);

-- item 与 story 的关系（一篇文可能同时报道多件事）
CREATE TABLE story_item (
  story_id  TEXT NOT NULL REFERENCES story(id),
  item_id   TEXT NOT NULL REFERENCES item(id),
  role      TEXT NOT NULL,                   -- primary|report|analysis|contrarian|mention
  added_at  TEXT NOT NULL,
  PRIMARY KEY (story_id, item_id)
);

-- 故事的进展日志：支撑"自你上次看之后新增了什么"
CREATE TABLE story_update (
  id          TEXT PRIMARY KEY,
  story_id    TEXT NOT NULL REFERENCES story(id),
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- claim_added|claim_superseded|source_upgraded|status
  delta_json  TEXT NOT NULL,                 -- 结构化增量
  summary     TEXT,                          -- 一句话"新在哪"
  CHECK (json_valid(delta_json))
);
CREATE INDEX idx_story_update_story ON story_update(story_id, at DESC);

CREATE TABLE claim (
  id                TEXT PRIMARY KEY,
  story_id          TEXT REFERENCES story(id),   -- 可为空：长期事实不属于单一事件
  -- 类型化三元组（能类型化就类型化，不能则退化为文本）
  subject_entity_id TEXT REFERENCES entity(id),
  predicate_id      TEXT REFERENCES predicate(id),
  object_entity_id  TEXT REFERENCES entity(id),
  object_value_json TEXT,                     -- 标量/结构化值：数字、日期、枚举
  claim_text        TEXT NOT NULL,            -- 人类可读的一句话
  claim_kind        TEXT NOT NULL,            -- fact|number|quote|prediction|opinion|decision
  qualifiers_json   TEXT,                     -- 限定：地区/口径/条件/单位
  -- 双时间轴
  world_from        TEXT, world_to TEXT,
  asserted_at       TEXT, recorded_at TEXT NOT NULL, superseded_at TEXT,
  -- 状态与置信
  status            TEXT NOT NULL DEFAULT 'active',  -- active|superseded|contested|retracted|unverified
  superseded_by     TEXT REFERENCES claim(id),
  confidence        REAL NOT NULL DEFAULT 0.5,
  extraction_method TEXT,                     -- llm+typed|llm+free|manual
  created_by        TEXT,                     -- agent 名 / 'user'
  CHECK (object_value_json IS NULL OR json_valid(object_value_json))
);
CREATE INDEX idx_claim_subject  ON claim(subject_entity_id, predicate_id, status);
CREATE INDEX idx_claim_story    ON claim(story_id, status);
CREATE INDEX idx_claim_frontier ON claim(status, superseded_at);

-- 证据：同一 claim 的多源支撑/反驳
CREATE TABLE claim_evidence (
  claim_id        TEXT NOT NULL REFERENCES claim(id),
  item_id         TEXT NOT NULL REFERENCES item(id),
  stance          TEXT NOT NULL,              -- supports|contradicts|mentions
  -- 文本证据（文章源）
  excerpt         TEXT,
  excerpt_start   INTEGER,                    -- 原文偏移，用于子串校验
  excerpt_end     INTEGER,
  -- 介质证据（视频/播客源）：字符偏移没有意义，用时间轴 + 帧
  segment_idx     INTEGER,
  time_start_sec  REAL,
  time_end_sec    REAL,
  frame_id        TEXT REFERENCES frame(id),
  -- 统一校验
  verified        INTEGER NOT NULL DEFAULT 0, -- 文本=子串校验通过；视频=OCR/人工核验通过
  added_at        TEXT NOT NULL,
  PRIMARY KEY (claim_id, item_id)
);
CREATE INDEX idx_evidence_item ON claim_evidence(item_id);
```

### 4.3 实体与本体

```sql
CREATE TABLE entity (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,      -- person|org|product|place|event|concept|work
  name        TEXT NOT NULL,
  aliases_json TEXT,              -- ["DeepSeek","深度求索"]
  canonical   TEXT,               -- 外部 ID（wikidata/官网）
  embedding_ref TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_entity_type ON entity(type, name);

CREATE TABLE entity_merge_log (
  from_id TEXT, into_id TEXT, at TEXT, reason TEXT
);

-- 谓词/本体注册表：让 claim 可类型化，也让 schema 能演化
CREATE TABLE predicate (
  id            TEXT PRIMARY KEY,     -- 'priced_at', 'acquired', 'released_on'
  label         TEXT NOT NULL,
  domain        TEXT,                 -- finance|tech|policy|...
  subject_types TEXT,                 -- JSON: ["product","org"]
  object_schema TEXT,                 -- JSON: 期望的值结构（number/date/enum/entity）
  qualifier_keys TEXT,                -- JSON: ["currency","region","unit"]
  status        TEXT NOT NULL DEFAULT 'proposed', -- proposed|approved|deprecated
  proposed_by   TEXT, proposal_evidence TEXT,
  created_at    TEXT NOT NULL
);
```

> 本体策略：**能类型化就类型化**（顶 200 个常用谓词覆盖大部分事实），覆盖不了的落 `claim_text` 自由文本。LLM 遇到新模式会提议新谓词 → 你批准 → 进入注册表 → 历史数据可回填重抽。这就是"schema 演化"，不靠人预先设计完美本体。

### 4.4 我的状态（系统真正的中心）

```sql
-- 知识水位：我知道到什么程度
CREATE TABLE knowledge_state (
  scope       TEXT NOT NULL,        -- story|topic|entity|claim
  ref_id      TEXT NOT NULL,
  level       TEXT NOT NULL,        -- unseen|headline|gist|detail|exhaustive
  frontier_at TEXT,                 -- 水位对应的时间点（这之后才算新）
  known_claim_ids TEXT,             -- JSON 数组（可选，精确模式）
  updated_at  TEXT NOT NULL,
  source      TEXT NOT NULL,        -- manual|inferred|imported
  PRIMARY KEY (scope, ref_id)
);

-- 标注：只需一行就够，comment 可选
CREATE TABLE annotation (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,        -- item|story|claim|entity
  target_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,        -- known|unknown|important|wrong|agree|disagree|
                                    -- question|save|mute_topic|mute_source
  comment     TEXT,                 -- 自由文本（这是最值钱的输入）
  at          TEXT NOT NULL,
  consumed    INTEGER DEFAULT 0     -- 是否已被后台学习任务消化
);
CREATE INDEX idx_ann_target ON annotation(target_type, target_id, at DESC);
CREATE INDEX idx_ann_kind   ON annotation(kind, at DESC);

-- 我的立场：会演化的观点，本身是一等记忆
CREATE TABLE stance (
  id                TEXT PRIMARY KEY,
  subject_type      TEXT NOT NULL,  -- entity|topic|story
  subject_id        TEXT NOT NULL,
  position          TEXT NOT NULL,  -- 我的观点（自由文本）
  confidence        REAL,
  based_on_claim_ids TEXT,          -- JSON：当时依据哪些事实
  revision_of       TEXT REFERENCES stance(id),
  at                TEXT NOT NULL
);
CREATE INDEX idx_stance_subject ON stance(subject_type, subject_id, at DESC);
```

### 4.5 私有记忆（不参与外部去重）

```sql
CREATE TABLE capture (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,   -- note|link|clip|voice|file|life_event|decision
  intent      TEXT,            -- reference|readlater|idea|decision|life
  title       TEXT,
  body        TEXT NOT NULL,
  url         TEXT,
  media_path  TEXT,
  -- 结构化关联（让"存了永远看不到"变成"在对的时候出现"）
  linked_entities TEXT,        -- JSON [entity_id]
  linked_story_ids TEXT,       -- JSON [story_id]
  linked_claim_ids TEXT,       -- JSON [claim_id]
  review_at   TEXT,            -- 决策复核日
  due_at      TEXT,
  archived    INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_capture_intent ON capture(intent, created_at DESC);
CREATE INDEX idx_capture_review ON capture(review_at);

CREATE TABLE capture_link (   -- 双向：记忆 ↔ 世界事实
  capture_id TEXT, target_type TEXT, target_id TEXT, relation TEXT
);
```

### 4.6 产出、曝光与审计

```sql
CREATE TABLE digest (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, slots_json TEXT NOT NULL,
  composed_by TEXT, token_cost INTEGER, delivered_at TEXT
);

CREATE TABLE exposure (      -- 我实际看到过什么（区别于"推了但没看"）
  target_type TEXT, target_id TEXT, channel TEXT,  -- im|web
  shown_at TEXT, opened_at TEXT, dwell_ms INTEGER, depth INTEGER
);

CREATE TABLE decision_log (  -- 为什么不推 / 为什么排这么后
  id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT,
  verdict TEXT,              -- push_summary|push_web|fold|suppress
  reason_codes TEXT,         -- JSON: ["duplicate_claim","event_budget","below_watermark"]
  score_json TEXT, at TEXT
);
CREATE INDEX idx_decision_target ON decision_log(target_type, target_id);

CREATE TABLE token_ledger (
  id TEXT PRIMARY KEY, at TEXT, agent TEXT, task TEXT,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, ref_id TEXT
);

CREATE TABLE research_report (
  id TEXT PRIMARY KEY, question TEXT, story_id TEXT, entity_id TEXT,
  body_md TEXT, citations_json TEXT, created_at TEXT, token_cost INTEGER
);
```

---

## 5. 证明它"高度结构化"：六条真实查询

**① 实体页：关于某公司我知道的一切，按谓词分组**

```sql
SELECT p.id AS predicate, c.claim_text, c.status, c.world_from, c.confidence
FROM claim c JOIN predicate p ON p.id = c.predicate_id
WHERE c.subject_entity_id = :entity_id
ORDER BY p.id, COALESCE(c.world_from, c.asserted_at) DESC;
```

**② 当前有效事实（时间旅行）**

```sql
-- 此刻（或任意过去时刻）关于 X 的事实快照
SELECT * FROM claim
WHERE subject_entity_id = :entity_id AND status = 'active'
  AND (world_from IS NULL OR world_from <= :as_of)
  AND (world_to   IS NULL OR world_to   >  :as_of);
```

**③ 冲突检测：同一 (主语, 谓词, 时间窗) 有互相矛盾的活跃主张**

```sql
SELECT a.predicate_id, a.subject_entity_id, a.id, b.id, a.claim_text, b.claim_text
FROM claim a JOIN claim b
  ON a.subject_entity_id = b.subject_entity_id
 AND a.predicate_id      = b.predicate_id
 AND a.id < b.id
 AND a.status='active' AND b.status='active'
 AND a.object_value_json IS NOT b.object_value_json            -- 值不同
 AND COALESCE(a.world_from,'') <= COALESCE(b.world_to,'9999')   -- 时间重叠
 AND COALESCE(b.world_from,'') <= COALESCE(a.world_to,'9999');
```

**④ 本周真正变了什么（不是"又有人写了什么"）**

```sql
SELECT s.title, u.summary, u.kind, u.at
FROM story_update u JOIN story s ON s.id = u.story_id
WHERE u.at >= datetime('now','-7 day')
ORDER BY u.at DESC;
```

**⑤ "我对 X 了解多少 / 缺什么"（覆盖度）**

```sql
-- X 所在领域里，其他同类实体都有的谓词，X 还缺哪些
SELECT DISTINCT p.id FROM predicate p
WHERE p.status='approved' AND p.domain = :domain
  AND p.id NOT IN (SELECT DISTINCT predicate_id FROM claim
                   WHERE subject_entity_id = :entity_id AND status='active');
```

**⑥ 无限流的候选：只取"自你水位之后有新主张"的故事**

```sql
SELECT s.id, s.title, s.last_update_at, COUNT(c.id) AS new_claims
FROM story s
JOIN claim c ON c.story_id = s.id
LEFT JOIN knowledge_state k ON k.scope='story' AND k.ref_id=s.id
WHERE s.status='active'
  AND (k.frontier_at IS NULL OR c.recorded_at > k.frontier_at)
  AND c.status IN ('active','unverified')
GROUP BY s.id
ORDER BY MAX(c.recorded_at) DESC;
```

**⑦ 我的立场演化：我对 X 的看法怎么变的**

```sql
WITH RECURSIVE chain(id, position, at, based_on_claim_ids, depth) AS (
  SELECT id, position, at, based_on_claim_ids, 0 FROM stance
   WHERE subject_type=:t AND subject_id=:id
   ORDER BY at DESC LIMIT 1
  UNION ALL
  SELECT s.id, s.position, s.at, s.based_on_claim_ids, chain.depth+1
    FROM stance s JOIN chain ON s.id = chain.revision_of  -- 需补 revision_of 反向
)
SELECT * FROM chain ORDER BY at;
```

---

## 6. 索引与规模

- 量级假设：item 5k–20k/天 → 年 200 万–700 万条；claim 数量级为 item 的 2–5 倍。
- SQLite + WAL 在这个量级完全可用（重点：`item` 大字段外置、claim 表单独索引、全文用 FTS5）。
- 向量：`sqlite-vec` 存 item/claim/entity embedding，只做召回，结论仍走结构化字段。
- 冷热分离：`item` 正文存文件（`raw_path`），表里只留摘要；`decision_log`/`exposure` 按年归档。

---

## 7. 迁移与版本

- `PRAGMA user_version` + `migrations/` 目录，顺序脚本。
- 每次 schema 变更必须能被"从旧库升级"，不允许重建（记忆不能丢）。
- `predicate` 表本身是数据不是 schema，加谓词不算迁移。

---

## 8. 开放问题

1. `claim` 的粒度怎么定？一句话一条，还是一段一条？（越细越好查，但抽取误差与成本上升）
2. 实体消歧：同名公司/人物怎么办？（建议：融合分 + 人工合并 + 永不硬删）
3. `object_value_json` 的规范化到什么程度？（"$0.75/千次" 要拆成 `{value:0.75, unit:'USD', per:1000, what:'call'}` 才可比较，但抽取难度陡增）
4. 私有记忆（`capture`）与外部事实（`claim`）的关联要不要**双向自动**建立，还是靠人/agent 建议？
5. 我的 comment 是否要成为"可引用证据"（例如我指出某个 claim 错了，是否降低其置信度并触发重验证）？
