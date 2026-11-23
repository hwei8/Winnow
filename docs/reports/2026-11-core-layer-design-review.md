# Winnow Core-Layer Design Review: What to Keep, Fix, Replace, and Stop

Winnow's core layer is feasible for one user, but it is not yet sound. Two parts are good: the evidence-first data model (claim → fact → story) and the explicit P0–P4 policy. Three problems matter more than any threshold:

- **Story linking pulls unrelated news into the biggest stories.** It compares mismatched text, ignores time, and prefers the largest story.
- **The gates and QA score mostly check the writer against its own tags.** They do not check whether the text is supported by the sources.
- **Fact dedup has never been tested on hard negatives.** These are pairs about the same entity with a different number, date or attribute.

All three can be fixed with cheap, local, SQLite-friendly changes. None needs new infrastructure.

## TL;DR

- **Keep the architecture; replace the yardsticks.** Claim → fact → story with evidence offsets is defensible and matches the literature (FActScore, Claimify, ALCE). But "coverage", "anchor validity" and most of the QA score come from the writer's own fact-id tags. About 85 of the 100 QA points are either self-reported or nearly constant. An independent entailment check would turn them into real quality signals. That check means NLI or a MiniCheck-style model applied claim↔quote and sentence↔cited fact.
- **"Story" is a fine reading unit but a poor clustering unit.** TDT, Miranda et al. (2018), SCStory and Story Forest all cluster articles into time-bounded events first, then thread those events into stories. Winnow instead grows one rewritten article indefinitely. It has no time signal and prefers the biggest story. The repo's own benchmark already shows the result: F1 ≈0.59 at the production threshold and ≈33% false positives on hard negatives.
- **Top 3 fixes by gain ÷ effort:**
  1. Repair story linking: same-space embeddings, a time window, a pure event question, no embedding override, and no "prefer the biggest".
  2. Add independent support checking to the extraction, gate and QA stages.
  3. Build a hard-negative fact-dedup benchmark, then use banded thresholds, compare against all member claims, and run an offline merge pass.

  Each fix comes with a falsifiable experiment sized for one developer (see Top 3 Changes).

---

## Key Findings

1. **The evidence red line checks that a quote exists, not that the claim is faithful.** "99.9% locatable" proves the quote is a substring of the source. It does not prove the Chinese claim says what the (often English) quote says. The literature treats these as separate checks: ALCE scores citation recall and precision with an NLI model, and MiniCheck exists to do exactly this check cheaply.\[1\]
2. **Fact clustering is greedy single-pass "leader" clustering, not union-find.** Each fact is represented by one arbitrary member vector. Facts are never merged later. `support_count` counts claims, not independent sources. Precision on hard negatives has never been measured.
3. **Story linking has four compounding bugs:**
   - It compares a raw (often English) article against a generated Chinese story body, using a stale cache.
   - The judge question conflates "event" and "topic".
   - Embedding heuristics can override a negative verdict from the judge.
   - Parent selection prefers the largest story.

   Together these produce attractor stories, such as the 198-fact Nvidia story. The literature's main fix is a time signal: Miranda et al.'s timestamp features (σ = 72 h) raised clustering F1 in all three languages they tested.\[2\]
4. **The P0–P4 thresholds are tuned, not calibrated.** Several came from samples of 3–10 items. One (consolidation lenRatio 0.2) was picked *because* it made every sample pass, which makes the gate circular.
5. **The gates push stories to grow forever.** Length floors of "never shorter than 80–85% of old", plus near-verbatim-only dup detection, plus no story closure, mean a story can only grow. That is the opposite of what a reader needs from a long-running story.
6. **The QA score measures self-consistency, not quality.** Of 100 points, 60 come from self-tags and length (coverageAll 22, coverageKey 18, density 8, lengthAdequacy 12). Another 25 are close to constant (near-verbatim dup 20, conflicts 5). Only titleAlign (15) is an independent semantic judgment, and it defaults to 0.8 when Jev fails. The historical mean moved from 86.8 to 80.6 mostly because the formula changed, so the series cannot be compared over time.

---

## 1. Claim Extraction (article → claims with evidence offsets)

### Is the design sound?

Mostly yes. One LLM call per article, atomic claims, a verbatim quote, and char offsets is the same basic shape as FActScore's atomic facts and Claimify's decontextualized claims. Dropping claims whose quotes cannot be found is a good, cheap hallucination filter.

**Failure modes I expect:**

- **Faithfulness gap.** The claim text is a Chinese paraphrase and translation. The quote only proves the source contains *some* related span. Typical drift is plausible but wrong:
  - a dropped hedge ("may" becomes "will");
  - a merged number from two sentences;
  - a changed attribution (the analyst's view becomes a fact);
  - a wrong unit or tense after translation.

  The repo does **not** guard against this. The 30-claim manual sample (0 hallucinations) is too small: the 95% upper bound on the error rate with 0/30 is about 10%.
- **Cross-lingual verification debt.** Translating during extraction makes every later check (claim↔quote, fact dedup across languages) a cross-lingual problem. Cheap verifiers are weakest there.
- **Truncation and the fixed cap.** The first 7,000 characters and at most 15 claims bias the system toward news ledes and against long analysis pieces. The docs admit this.
- **Doc/code mismatch.** Subject/predicate/object and the world-time fields are empty or null in production. That matters because time is exactly the field that would separate hard negatives (same entity, different date) in dedup and story linking.
- **Weak reverify.** Checking that the first 60 characters of the excerpt are a substring catches source edits, not misattribution.

### What the state of the art does

- **FActScore** (Min et al., EMNLP 2023, https://arxiv.org/abs/2305.14251) and **SAFE/LongFact** (Wei et al., 2024, https://arxiv.org/abs/2403.18802) split text into atomic facts and then *verify each one* against evidence. Extraction and verification are separate steps.
- **Claimify** (Metropolitansky & Larson, ACL 2025, https://aclanthology.org/2025.acl-long.348/):
  - Runs as multiple stages (selection, disambiguation, decomposition).
  - Refuses to extract a claim when the sentence is ambiguous and context cannot resolve it.\[3\] In the paper's runs, at most 5.4% of sentences were labelled "Cannot be disambiguated" (mistral-large-2411; 3.2% for gpt-4o, 2.4% for DeepSeek-V3).
  - Is evaluated on entailment, coverage and decontextualization. In the paper's Table 1 (judged by gpt-4o), Claimify reached 99.0% entailed claims (12,406 claims) and VeriScore 99.2% (7,420), versus SAFE 96.6% and DnD 89.1%. The authors report "no statistically significant difference between them (p=0.145)".
  - The lesson for Winnow is the *evaluation frame*: entailment by the source is measured, not assumed.
- **Dense X Retrieval / Propositionizer** (Chen et al., 2023, https://arxiv.org/abs/2312.06648) shows that proposition-level units are better retrieval keys than passages. This supports Winnow's choice of claims as the memory unit.
- **Cheap verifiers:**
  - **MiniCheck** (Tang, Laban & Durrett, EMNLP 2024, https://arxiv.org/abs/2404.10774) trains small checkers that reach GPT-4-level accuracy on grounding "for 400x lower cost". MiniCheck-FT5 (770M) averages 74.7 balanced accuracy on LLM-AggreFact versus GPT-4's 75.3.\[4\] **But the paper says its models are "trained exclusively on English data"**, so MiniCheck is only directly usable on English claim / English quote pairs.\[5\]
  - **AlignScore** (Zha et al., ACL 2023, https://github.com/yuh-zha/AlignScore) is RoBERTa-based (125M/355M) and in practice English-only.\[6\]
  - The multilingual option is **mDeBERTa-v3-base-xnli-multilingual-nli-2mil7**:\[7\]
    - about 279M parameters, MIT licence;\[8\]
    - XNLI accuracy 0.803 on Chinese and 0.871 on English;\[9\]
    - ONNX weights available for Transformers.js, so it runs inside Node.\[10\]\[11\]
    - Its model card says that for each language "a random set of 10% of the hypothesis-premise pairs was added where an English hypothesis was paired with the premise in the other language", but **no cross-lingual accuracy is published**. Treat cross-lingual use as unverified.
- **ALCE** (Gao et al., EMNLP 2023, https://arxiv.org/abs/2305.14627) defines citation recall (do the cited passages entail the statement?) and citation precision (is each citation needed?), both judged with an NLI model. Its automatic metric agreed with humans with Cohen's κ 0.698 for recall and 0.525 for precision.\[12\]\[13\]

### Is it earning its keep? What is missing?

- **Load-bearing and missing: a claim↔quote entailment check.** At about 30 stories a day this costs very little. It can be one batched Jev `noul` question per claim ("the quote supports the claim"), or a local mDeBERTa ONNX pass.
- **Extract in the source language and translate at display time.** Store `text_src` (in the quote's language) plus `text_zh`. Verification and dedup then run within one language wherever possible. For English sources that unlocks MiniCheck-class checkers.
- **Replace the 15-cap and 7k truncation with chunked extraction.** For example, use about 3–4k-character chunks with a cap per chunk, followed by a dedup pass within the article. On a 24k-character piece this costs about 6 calls instead of 1, which is still small at this volume.
- **Either populate `world_from`/event date or delete it from the docs.** A single extracted "event date" per claim is enough to power hard-negative vetoes in clustering and the time window in linking.
- **Over-engineered: nothing here.** If anything, this stage is under-built.

**Verdict: Adjust.**

---

## 2. Fact Clustering (claim → fact)

### Is the design sound?

Not as implemented. The docs describe top-8 recall plus Jev plus union-find. The code actually does this:

- It scans one *arbitrary* representative vector per fact.
- It sends the top-3 matches with cosine ≥0.55 to Jev, and accepts the best one if Jev returns ≥0.6.
- Otherwise it creates a new fact.
- Within a batch, new facts are matched by cosine ≥0.92 alone.

There is no transitive closure, no later merge, and `canonical_text` is frozen at the first claim.

**Failure modes:**

- **Order dependence and under-merging.** If the representative is an outlier phrasing, true paraphrases miss it, and a duplicate fact is born that will never be merged. Single-pass leader clustering is known to depend on input order. The 7% production redundancy versus 29.5% in the dense-corpus study is consistent with under-merging, but also with a less redundant corpus. **This is unknown; measure it.**
- **Hard-negative false merges.** Pairs such as "revenue was $30B" vs "$35B", or "resigned on Monday" vs "resigned last year", are the classic entity-resolution corner case. bge-m3 ranks them as nearest neighbours, and Jev's 45-pair benchmark (F1 1.0) contained **none**. The repo does not guard against this.
- **The 0.55 gate is close to a no-op.** With random-pair p95 at 0.65, it admits many unrelated pairs. The top-3 cap does the real work.
- **`support_count` inflation.** Two claims from one article count as two "sources", so the coverageKey "key facts" (support ≥2) are partly just facts from long articles.
- **Within-batch 0.92 cosine without Jev.** This is fine for precision but adds another path that skips the judge.

### What the state of the art does

- **Classic entity resolution is three stages: blocking → pairwise matching → clustering.**
  - Fellegi–Sunter/Splink (https://github.com/moj-analytical-services/splink) and dedupe.io (https://github.com/dedupeio/dedupe) use cheap blocking keys and then cluster matched pairs. Clustering is transitive closure or a thresholded connected-components step, often followed by repair.
  - Ditto (Li et al., VLDB 2021, https://arxiv.org/abs/2004.00584) showed that small fine-tuned cross-encoders match well.
- **LLM matching works, but prompts are brittle.** Peeters, Steiner & Bizer (EDBT 2025, https://arxiv.org/abs/2310.11244) found LLMs strong zero-shot matchers, but "there is no universally best prompt". Prompt choice and model interact with the dataset.\[14\] That matches Jev's swings between benchmarks.
- **Cluster in context instead of asking pairwise questions.** LLM-CER (Fu et al., 2025, https://arxiv.org/abs/2506.02509) asks the LLM to partition small *sets* of records. The authors report up to 5× fewer API calls than a cost-optimised baseline and 12–108× fewer than plain pairwise matching. A third-party review notes that their own Table 4 shows BoostER is cheaper in money, so treat the cost claim cautiously.\[15\] The relevant idea is "send the claim plus its 5 candidate facts and ask *which, if any*", instead of 3 separate yes/no questions.
- **Bidirectional entailment as semantic equivalence.** Kuhn et al. (ICLR 2023, https://arxiv.org/abs/2302.09664) cluster meanings by requiring entailment in both directions. Farquhar, Kossen, Kuhn & Gal (Nature 630:625–630, 2024) relaxed this to "non-defeating" entailment: at least one direction entails and neither contradicts. They did this because DeBERTa-NLI had lower recall than GPT-class judges. That is the right definition of "same core fact": A⇒B and B⇒A, with numbers and dates preserved.
- **Cross-encoder rerankers as local judges.** bge-reranker-v2-m3 (568M parameters, Apache 2.0, built on bge-m3; BAAI describes it as a "lightweight reranker model" with "strong multilingual capabilities") has GGUF builds served by `llama-server --reranking`, plus ONNX builds for Transformers.js. It fits the existing llama.cpp setup. Caveat: it is trained for relevance, not equivalence, so it will rank "$30B vs $35B" pairs highly. It is a candidate *ranker*, not the judge.
- **Mature memory systems:**
  - **Graphiti/Zep** (https://arxiv.org/abs/2501.13956) dedups fact edges with embeddings, full-text search and an LLM. Crucially, it **restricts the search to edges between the same entity pair**.\[16\]\[17\] That is a blocking key that removes most hard negatives about different entities for free. On contradiction it sets `invalid_at` rather than deleting, and new information wins by default.\[16\]\[17\]
  - **Mem0** went the other way:
    - Its 2025 paper used an LLM to choose ADD/UPDATE/DELETE/NOOP per fact (https://arxiv.org/abs/2504.19413). \[18\]
    - Its April 2026 v3 algorithm moved to "Single-pass ADD-only extraction — one LLM call, no UPDATE/DELETE. Memories accumulate; nothing is overwritten" (https://docs.mem0.ai/migration/oss-v2-to-v3). \[19\]\[20\]
    - Duplicates are now handled by hash-based dedup for exact copies, plus ranking and entity linking at retrieval time.\[21\]
    - The accuracy gains Mem0 reports are vendor numbers. The design shift itself is a meaningful signal: a large production memory system decided that aggressive online merging was not worth its errors.\[22\]

### Is it earning its keep?

The Jev pairwise step *can* be reduced substantially, and a pure-embedding replacement would be wrong on hard negatives. The recommended design:

1. **Compare against all member claims, not one representative.** Take the max cosine over the fact's members. With about 7.5k vectors, brute-force search is about 8 ms per query according to the repo's own measurements.
2. **Use banded thresholds calibrated on a hard-negative set.**
   - Auto-merge above τ_hi, but only if a cheap **number/date/negation consistency veto** passes. That means comparing the extracted digits, Chinese numerals, dates and 不/未/否认 markers.
   - Auto-reject below τ_lo.
   - Send only the middle band to Jev, as one set-wise "which of these candidates, if any" question.
3. **Add a blocking key where available.** A shared named entity or subject is enough. The empty SPO fields are the natural place for it.
4. **Run a nightly offline merge pass over all facts.** Use mutual top-k neighbours, then Jev, then union-find, plus a canonical-text refresh. At about 7k facts this is cheap and removes order dependence.
5. **Count support by distinct items or sources.**

Union-find alone is not the fix. Transitive closure amplifies false positives, which is why entity-resolution pipelines add cluster repair. With the hard-negative veto and the band, closure becomes safe enough.

**Verdict: Adjust.** Mostly this is about measuring first.

---

## 3. Story Linking and the "Story" Unit

### Is the design sound?

No. This is the weakest mechanism, and it hurts reading quality most.

**Specific failure modes, all present in the code:**

1. **The two vectors live in different spaces.** Incoming = title + 1,800 characters of the raw (often English) article. Story = first 2,000 characters of the *generated Chinese* body. bge-m3 is cross-lingual, but source-vs-summary and EN-vs-ZH both shrink and shift cosines. The 0.55 candidate gate (docs say 0.62) then admits topic-level neighbours.
2. **Stale vectors.** The cache is keyed only by story id and never invalidated after rewrites or consolidation. A story that has changed its lede is still matched on its old text.
3. **The judge question conflates event and topic.** "Same specific event/topic" is exactly what the repo's own decision D13 warned against.
4. **Heuristic override.** Fact affinity ≥0.72 or ratio ≥0.4 forces `same_event` ≥0.8 *even when Jev said no*. Shared background facts ("Nvidia is the largest GPU maker") inflate affinity for any article about the same entity. That is how hard negatives get in.
5. **Silent fallback.** On a Jev error, the raw cosine is used as a probability. A cosine of 0.7 is not a 0.7 probability.
6. **"Prefer the biggest story" plus hops toward stories with more than twice the facts.** This is a rich-get-richer rule. I found no paper that names "prefer the biggest" specifically. But it is the streaming-clustering version of a well-known problem: large, drifting clusters attract borderline members. Streaming systems counter it with centroids, time decay and windows. The 198-fact, 5,600-character Nvidia story with five "latest developments" sections is the expected outcome.
7. **No time, no closure, no split.** Stories never age out, and the split verdict is executed as an append.
8. **Measured weakness.** On the repo's own 186-pair benchmark with 60 hard negatives:
   - Production threshold 0.70 gives cloud F1 ≈0.588.
   - The best is 0.757 at 0.4, but hard-negative false positives are ≈0.33 at 0.4.

   No threshold fixes this. The judge lacks discriminating information, mainly *when* things happened.

The repo guards against none of these, apart from the empty-gap → duplicate rule.

### What the state of the art does

- **TDT** (Allan et al., 1998/2002) separated **events** (something that happens at a particular time and place) from **topics** (a seminal event plus directly related events). It also separated *first story detection* from *tracking*. Petrović et al. (NAACL 2010, https://aclanthology.org/N10-1021/) made first story detection streaming-scale with LSH.
- **Miranda et al., EMNLP 2018** (https://aclanthology.org/D18-1483/), "Multilingual Clustering of Streaming News":\[2\]
  - Each cluster is an **average centroid**, not one member and not the generated text.\[2\]\[23\]
  - Similarity combines text subvectors with **three Gaussian timestamp features**: newest, mean and oldest document in the cluster, with σ tuned to **72 hours**.\[2\]\[23\]
  - Monolingual clustering comes first; cross-lingual linking happens at cluster level.\[2\]
  - The new-cluster decision is **learned** (SVM-rank on gold data), not a fixed cosine. They report this "significantly helps to learn when to create a new cluster, compared to simple grid search".\[2\]
  - Timestamps raised F1 from 92.7 to 94.1 (English), 90.7 to 97.1 (German) and 88.8 to 94.2 (Spanish).\[2\]
- **SCStory** (Yoon et al., WWW 2023, https://arxiv.org/abs/2312.03725) and **USTORY** (SIGIR 2023, https://arxiv.org/abs/2304.04099):
  - Both operate over a **sliding window**; stories outside the window stop attracting articles.\[24\]
  - Each new article is assigned "to the most confident current story", or starts a new one.\[24\]
- **Story Forest** (Liu et al., KDD 2017 / TKDD 2020, https://arxiv.org/abs/1803.00189), built at Tencent on Chinese news, is a two-layer design:
  - First, documents are clustered into fine-grained **events** (EventX). A document-pair classifier was trained on 5,000 labelled pairs.\[25\]
  - Then events are placed into **story trees** via merge/extend/insert.\[26\]
  - In user studies the tree gave the best readability on 187 of 221 stories.\[26\]
  - 83% of its event links were judged logically correct, versus 33% for more complex story graphs.\[26\]
- **Event threading** (Nallapati et al., CIKM 2004) and **Metro Maps** (Shahaf et al., KDD 2012) model a story as a *structure of events*, not a single document.
- **Timeline summarisation:** Gholipour Ghalandari & Ifrim (ACL 2020, https://aclanthology.org/2020.acl-main.122/) and the WCEP dataset (https://aclanthology.org/2020.acl-main.120/) render long stories as dated event summaries, not one ever-longer essay.\[27\]\[28\]

### Is "story" defensible?

As a **reading unit**, yes. One coherent page per ongoing situation is what users want, and Story Forest's user study favours structured stories over flat lists.

As a **clustering and memory unit**, no. Every mature system clusters into time-bounded **events** first and then threads events. Winnow's "story = one ever-growing rewritten article" merges three jobs that the literature keeps apart: event detection, thread linking, and summary rendering.

The recommendation is not a rewrite. It is a thin event layer within the existing schema:

- **Link incoming items to events**, not stories. Use same-space signals:
  - the incoming raw item vs. the *source items'* vectors (max or centroid), raw-to-raw;
  - the incoming claims' facts vs. the event's facts, by fact-id identity first and cosine second;
  - a Gaussian or hard time window (start with Miranda's σ ≈ 72 h; tune it).\[2\]
- **A story becomes a thread of events.** The rendered article is a short rolling lede plus a dated "developments" timeline per event. This turns P2 consolidation into rendering instead of rewriting.
- **Close events after N days with no new facts.** A later development opens a new event linked to the thread (relation `follow_up`). It does not append to a 200-fact document.
- **Ask the event question with dates on both sides**, for example: "Do A and B report the same specific incident/announcement/decision (same actors, same occurrence), given A dated X and B dated Y?" Topic relatedness becomes a separate `related` link that never triggers rewrites.
- **Drop the heuristic override and the "biggest story" preference.** Pick the argmax of the calibrated score. If Jev fails, defer rather than substituting cosine.

**Verdict: Replace the linking unit (event-first). Adjust the story into a rendering of linked events.**

---

## 4. Update Policy P0–P4

### Is the design sound?

The *shape* is sound and defensible. ADR 0004's rejection of "let the LLM decide everything" is well-founded: explicit, replayable, tunable classes are what lets you calibrate at all. Mem0's own move away from LLM-chosen UPDATE/DELETE toward additive memory points the same way.\[22\] Marking degraded mode when Jev is unavailable is good practice.

**Problems:**

- **Thresholds are tuned on tiny samples, sometimes circularly:**
  - The P1 heuristic was fitted on 10 replays.
  - The gap threshold came from 3 stories.
  - Consolidation's lenRatio 0.2 was chosen because 10/10 passed, which defines the gate by its pass rate.
  - The conflict benchmark has 28 constructed pairs (P 0.733 / R 0.786).
  - Nobody has labelled the "correct severity". The ADR admits the P1 heuristic errs on about 2 of 10.
- **The P1 lede override is brittle.** It needs Chinese character-set overlap ≥0.45 plus a regex of state-change verbs. It will fire on background mentions ("previously resigned…"), and it misses state changes phrased otherwise (撤职, 下台, 宣布退出).
- **"Split" is computed but executed as an append.** A detected split silently becomes growth.
- **Gap is computed by cosine <0.85 to old facts, not by fact-id identity.** The fact layer already says whether a fact is new. The policy ignores it and recomputes novelty with a different, unvalidated threshold.
- **Pairwise contradiction checks** cover only the first 12 new facts × top-2 old facts with cosine ≥0.55. They miss contradictions phrased far apart, for example a number restated in a different sentence frame.

### What the state of the art does

- **TREC Temporal Summarization 2013–2015** (overview: https://trec.nist.gov/pubs/trec23/papers/overview-tempsumm.pdf):
  - Updates are emitted when *novel and relevant*.\[29\]
  - Updates are judged against gold **nuggets**, with Expected Latency Gain (precision-like) and comprehensiveness (recall-like).\[30\]\[31\]
  - The top runs balanced "the need for high precision and novelty with topic coverage".\[30\]
  - The transferable lesson is to evaluate update decisions against a small set of labelled nuggets or decisions.
- **FRUIT** (Logan IV et al., NAACL 2022, https://aclanthology.org/2022.naacl-main.269/) defines the exact task Winnow's rewrite does: update an existing article given new evidence, preferring the evidence when it invalidates the old text.\[32\]\[33\]
  - It evaluates only the *changed* sentences (UpdateROUGE).\[34\]
  - The authors report that even their best model, EdiT5, produced ungrounded claims in 35% of updated articles.\[33\]
  - Rewrites are where hallucination enters, so they should be rare and checked.
- **Graphiti's edge invalidation** (https://arxiv.org/abs/2501.13956) models "supersedes" with validity intervals (`valid_at`/`invalid_at`) and keeps history. Winnow's `superseded_by` is the right idea. Adding a validity time would let the story render "as of" states.
- **STORM / Co-STORM** (Shao et al., 2024, https://arxiv.org/abs/2402.14207) generates cited articles from an outline. Outline-then-section rendering, rather than whole-article rewriting, fits an event-timeline story well.

### What principled calibration looks like for one user

1. **Label 120–150 real pending updates** with the action a careful editor would take (retract / lede / append / no-op). Use stratified sampling so P0 and P1 are not swamped by P3. At about 30 seconds each, that is 1–2 hours.
2. **Check calibration.** Bin Jev's `noul` probabilities, plot predicted vs. observed, and fit isotonic or Platt scaling if needed. The fit is a one-time JSON lookup table.
3. **Set thresholds by cost, not feel.** For a calibrated probability p, act when p > C_FP / (C_FP + C_FN). If a wrong lede rewrite costs 3× a missed one, the threshold is 0.75. Write the cost ratio in the ADR. That makes the threshold explainable, which was ADR 0004's goal.
4. **Use a precision target for destructive actions.** For P0 retraction or contradiction, pick the lowest threshold whose 95% Clopper–Pearson lower bound on precision is ≥ the target on the labelled set. Split conformal prediction works similarly. With about 30 positives the bound is wide, so expect conservative thresholds. That is appropriate for destructive actions.
5. **Freeze the labelled set as a replay regression suite.** Any prompt, model or threshold change must not reduce macro-F1 on it.

### Is it earning its keep?

P0 (contradiction, retraction or supersede) is load-bearing. Keep it, and add validity times.

P1/P2's per-update classification is over-built for a corpus of about 30 new stories a day. With the event layer, most of it collapses to two steps:

- append the new event's facts, and re-render the lede only when (a) P0 fires, or (b) the new event is the most recent event *and* the lede's key fact is superseded;
- run consolidation on a schedule as re-rendering, not as a gated rewrite.

Replace the regex heuristic with one Jev question that includes the date ("does this new fact change the current status stated in the lede?"), calibrated as above.

**Verdict: Adjust.** Keep the classes; recalibrate; simplify P1 and P2; execute splits or remove them.

---

## 5. Rewrite Gates and Section Consolidation

### Is the design sound?

The *safety pattern* is good:

- snapshot → attempt → gate → restore → fall back to append;
- versioned stories;
- no information is ever lost.

The QA drop from 89.6 to 59.6 on a rejected rewrite shows rollback works. The *metrics inside the gates* are the problem:

- **Coverage = the writer's own fact-id tags.** An LLM that tags a sentence [f12] has not shown that the sentence states f12. Writers learn that tagging is rewarded, and this gate rewards tagging, not stating. Nothing detects *unsupported* content, meaning new claims introduced during rewriting. FRUIT's 35% figure says this is the main risk in update generation.\[33\]
- **Length floors (≥0.80–0.85× old) make growth one-way.** Combined with no closure, stories can only get longer. Consolidation then needs a lenRatio of 0.2 to pass at all. The header comment still says 0.6, which is a sign the gate was moved to fit the outputs.
- **Dup = char-trigram Jaccard ≥0.82.** That only catches near-verbatim repeats. Semantic repetition across "latest developments" sections (the actual reader complaint) is invisible to it.
- **Section affectedness uses trigram Jaccard ≥0.18 against a whole section.** This is size-biased, so long sections are rarely "affected". That fails exactly where the stale content usually lives.
- **realignAnchors drops all anchors and recomputes them only against the story's own source items.** Facts absorbed through updates from other items can lose their anchors, which then depresses coverage after a correct consolidation.

### What the state of the art does

- **ALCE-style citation recall and precision** (https://arxiv.org/abs/2305.14627) check, for each generated sentence, whether its cited passages **entail** it (recall), and whether each citation is needed (precision), using an NLI model.\[12\]\[35\] Applied here: sentence ↔ texts of the cited facts, or better, the quotes of those facts' claims.
- **SummaC** (Laban et al., TACL 2022, https://arxiv.org/abs/2111.09525), **AlignScore** and **MiniCheck** are the cheap NLI-family scorers designed for exactly this document-vs-summary consistency check. As above, only the mDeBERTa family or an LLM judge is usable on Chinese text.
- **Pyramid / LitePyramid** (Nenkova & Passonneau, 2004; Shapira et al., NAACL 2019, https://aclanthology.org/N19-1072/) measure *content coverage* against semantic content units. Winnow's facts already *are* SCUs. Coverage should be "fraction of required facts that some sentence entails", checked independently.

### Is it earning its keep?

The rollback machinery: yes, keep it. The four parallel rewrite paths (targeted, full, small, consolidate), each with its own hand-set thresholds (0.85 / 0.90 / 0.95; 0.80 / 0.85 / 0.35 / 0.2 length), are over-engineered relative to the evidence behind any single number. Replace them with one gate that uses three independent measures:

1. **Support (precision).** Every sentence must be entailed by at least one fact it cites. Use per-sentence NLI or Jev against the cited facts' claim quotes, with a threshold calibrated once.
2. **Key-fact recall.** Every fact with ≥2 *independent sources*, and every non-superseded lede fact, must be entailed by some sentence. Check only the top-3 sentences by embedding per fact, to keep cost linear.
3. **Semantic redundancy.** Flag sentence pairs within a story where cosine > τ, or where the checker says one entails the other (bidirectional entailment, Kuhn et al.). Drop the length floor. Use a *maximum* length budget per story type instead, because loss is now caught by key-fact recall.

**Verdict: Adjust.** Keep rollback; swap the measures; merge the gate variants.

---

## 6. QA Score ("QA v3")

### Does it measure quality or self-consistency?

Mostly self-consistency. Breaking down the 100 points:

| Component | Points | What it actually measures | Independent of writer? |
|---|---|---|---|
| coverageAll | 22 | writer self-tags ∩ facts from own items (set to 1 if there is no intersection) | No |
| coverageKey | 18 | same, over facts with per-claim (not per-source) support ≥2 | No |
| density | 8 | anchors per 100 characters, so more tags score higher | No (gameable) |
| lengthAdequacy | 12 | characters / 1200 | Trivially satisfied |
| dup | 20 | intra-story near-verbatim trigram pairs | Nearly constant |
| conflicts | 5 | Jev on fact pairs sharing tokens; the tokenizer rarely matches Chinese | Nearly constant |
| titleAlign | 15 | Jev "body consistent with title", 0.8 default on failure | Yes (only one) |

About 85 of 100 points are self-reported or near-constant. The score cannot detect:

- a hallucinated sentence;
- a stale lede that contradicts a superseded fact;
- semantic repetition;
- cross-story duplication (the docs say it measures this; the code does not, except via caps and links).

It *rewards* over-tagging. Because the formula changed three times, the 86.8 → 87.4 → 79.5 → 80.6 trend is not evidence of anything.

LLM-judge literature adds a warning. Panickssery et al. (NeurIPS 2024, https://arxiv.org/abs/2404.13076) show that LLM evaluators recognise and favour their own generations, and that the bias grows with self-recognition ability.\[36\]\[37\] If QA ever moves to "ask the writer model to grade", that bias will inflate scores. Using Jev, a different model from the writer, is the right instinct. G-Eval-style judges (https://arxiv.org/abs/2303.16634) and RAGAS faithfulness (https://arxiv.org/abs/2309.15217) are cheaper to set up, but they inherit judge bias and need validation against humans.

### What minimal, cheap, independent QA would look like

1. **Support rate**: the share of sentences entailed by their cited facts' quotes. This is ALCE citation recall, using NLI or Jev.
2. **Key-fact recall**: the share of key facts (≥2 distinct sources) entailed by some sentence. This is pyramid-style, with facts as SCUs.
3. **Staleness**: whether any superseded fact is still asserted in the lede.
4. **Redundancy**: semantic duplicate sentence pairs per 1,000 characters; separately, cross-story duplicates (same event, two stories).
5. **Human anchor**: 40–50 stories rated 1–5 by the user (or using the existing known/wrong/agree annotations, mapping "wrong" on a story to a QA failure). Report Spearman's ρ between QA and the ratings at every formula change. Without this, no formula change is justified.

**Verdict: Replace.** Keep titleAlign; drop density and lengthAdequacy as quality signals; rebuild around support, recall, staleness and redundancy, validated against the user's own ratings.

---

## Verdict Table

| # | Mechanism | Verdict | One-line justification |
|---|---|---|---|
| 1 | Claim extraction with quote offsets | **Adjust** | Right unit and right evidence discipline. Add claim↔quote entailment, extract in source language, chunk long articles, fill the event date. |
| 2 | Fact clustering (Jev pairwise, leader clustering) | **Adjust** | The idea is sound but untested on hard negatives. Use banded thresholds, max over members, a number/date veto, nightly offline merge, and per-source support. |
| 3a | Story linking | **Replace** | Mismatched vector spaces, a stale cache, a topic-vs-event question, an embedding override and "prefer biggest" create attractors. Link to time-bounded events instead. |
| 3b | "Story" as an ever-growing rewritten article | **Adjust** | Defensible as a reading view. Make it a thread of closed and open events rendered as lede + timeline, not one document. |
| 4 | Update policy P0–P4 | **Adjust** | Keep the explicit classes and P0. Calibrate on about 150 labelled updates with cost-weighted thresholds; simplify P1/P2; execute or remove split. |
| 5 | Rewrite gates and consolidation | **Adjust** | Rollback is excellent. Self-tag coverage, length floors and trigram dup measure the wrong things; replace them with support, key-fact recall and semantic redundancy. |
| 6 | QA score | **Replace** | About 85% of points are self-reported or constant. Rebuild on independent entailment checks and validate against user ratings. |

---

## Top 3 Changes, Ranked by Quality Gain ÷ Effort

### 1. Repair story linking (effort: about 1–2 days; gain: highest)

**Change:**

- Compare the incoming raw item with the story's *source items* (raw ↔ raw, max over members), plus fact-id overlap.
- Invalidate the story-vector cache by body hash, or drop it.
- Add a Gaussian time factor (start at σ = 72 h, per Miranda et al.) or a hard "last update within 7 days" window for `update`.\[2\] Anything older becomes a `follow_up` or `related` link to a new story.
- Rewrite the Jev question to a pure event question with dates.
- Delete the embedding override.
- On Jev error, defer instead of using cosine.
- Pick the parent by argmax score, with no size preference and no hops toward bigger stories.

**Experiment:**

- **Dataset.** Extend LOCAL-DECISION-BENCH from 186 to about 300 pairs. Add about 60 new hard negatives from production: pairs with the same entity, a different event, and/or a gap of more than 7 days. Many can be sampled from updates currently attached to the 10 largest stories. Labelling takes about 3 hours.
- **Metrics.** F1 at the deployed threshold; hard-negative false-positive rate (FPR).
- **Success.** F1 ≥0.75 at the deployed threshold, with hard-negative FPR ≤0.15 (today ≈0.59 F1 at 0.70, and ≈0.33 FPR at 0.4).
- **Second check.** A 30-day replay of the ingest log. The largest story's fact count and the share of updates absorbed by the top-5 stories should both fall. In a manual audit of 30 updates attached to the biggest stories, ≥90% should be judged the same event.
- **Falsified if.** The time and same-space features do not reduce hard-negative FPR below 0.2. That would show the judge itself, not the inputs, is the bottleneck. Then train a tiny logistic model on the features (cosine, Δt, fact overlap, Jev p), as Miranda et al. did with SVM-rank.\[2\]

### 2. Independent support checking for extraction, gates and QA (effort: about 2–4 days; gain: high)

**Change:**

- One "does X entail Y" primitive, implemented first as batched Jev `noul` questions. That needs no new infrastructure and Jev is not the writer.
- Optionally a local fallback: mDeBERTa-v3-base-xnli ONNX in Transformers.js for Chinese/mixed pairs, or MiniCheck-FT5 for English/English.\[10\]
- Use it in three places:
  - (a) claim ↔ quote (±1 sentence of context) at ingest. Failing claims become `unverified`, not dropped.
  - (b) sentence ↔ cited facts' quotes in every rewrite gate, replacing self-tag coverage.
  - (c) the new QA: support rate, key-fact recall, staleness, redundancy.

**Experiment:**

- **Dataset.** Label 150 claim–quote pairs (75 from English sources, 75 from Chinese) and 200 sentence–cited-fact pairs from 25 recent rewrites. The user should also rate 40 stories 1–5.
- **Metrics.**
  - Checker balanced accuracy vs. labels, separately for monolingual and cross-lingual pairs.
  - Unsupported-claim rate found.
  - Spearman's ρ of old QA vs. new QA against the user ratings.
- **Success.**
  - Checker balanced accuracy ≥0.80 overall.
  - New QA ρ ≥0.5, and higher than old QA's ρ. I expect old QA's ρ to be ≤0.3, but that is a hypothesis, not a measurement.
- **Falsified if.** The checker is below 0.75 on cross-lingual pairs but fine on monolingual ones. That is direct evidence for switching extraction to the source language. If old QA already correlates as well as new QA, keep the old score and skip the QA part of this change.

### 3. Fact-dedup hard-negative benchmark, then banded thresholds and an offline merge (effort: about 2–3 days; gain: medium-high, also cuts Jev calls)

**Change:**

- Compare against all member claims.
- Auto-accept above τ_hi only if the number/date/negation veto passes; auto-reject below τ_lo; send the band to one set-wise Jev question.
- Count support per distinct source.
- Run a nightly mutual-kNN → Jev → union-find merge pass with a canonical-text refresh.

**Experiment:**

- **Dataset.** 300 production pairs:
  - 100 cross-source paraphrases;
  - 100 hard negatives (same entity, different number/date/attribute);
  - 100 top-3 neighbours that are unrelated.
- **Measure.** The cosine distribution per class and Jev P/R. Choose τ_hi for precision ≥0.98 and τ_lo for a recall loss ≤2%.
- **Success.**
  - Hard-negative false-merge rate ≤5%.
  - ≥50% of Jev dedup calls eliminated at equal F1.
  - The offline pass over the existing 6,929 facts proposes merges, and a 50-merge audit shows ≥90% precision.
- **Bonus.** This settles the open question of 7% vs. 29.5% redundancy.
- **Falsified if.** Hard negatives and paraphrases overlap so heavily in cosine that no usable band exists. Then keep Jev on all top-k candidates and invest in the veto and blocking key instead.

**Runner-up (#4): P0–P4 calibration** on about 150 labelled updates, with reliability curves, cost-weighted thresholds and a replay suite. It is high value, but most of its benefit lands after changes 1–2 reshape what an "update" is.

---

## What the System Should Stop Doing

These are the habits to drop:

- **Choosing thresholds so a gate passes.** lenRatio 0.2 was chosen "because 10/10 passed", and others were fitted on 3–10 samples with no held-out check. Choose them from labelled decisions and an explicit cost ratio.
- **Treating the writer's own fact-id tags as evidence of coverage.** Rewarding anchor density in QA compounds this.
- **Enforcing "never shorter than before" length floors.** Together with the lack of closure, they guarantee one-way growth.
- **Letting embedding heuristics override a negative Jev verdict, and substituting raw cosine for a probability when Jev fails.**
- **Preferring the biggest story when linking.**
- **Counting two claims from one article as corroboration.**
- **Reporting a single QA mean across formula changes.**
- **Computing a "split" verdict that is silently executed as an append.**
- **Documenting mechanisms the code does not implement:** union-find, SPO triples, world-time fields, candidate threshold 0.62, cross-story duplication in QA. Every review, including this one, has to rediscover the gap.

## Prior Art Worth Reading

- **Miranda et al., "Multilingual Clustering of Streaming News", EMNLP 2018** (https://aclanthology.org/D18-1483/). The closest analogue to Winnow's linking problem: centroids, Gaussian time features (σ = 72 h), and a learned new-cluster decision. Code at https://github.com/priberam/news-clustering. \[2\]
- **Liu et al., "Growing Story Forest Online from Massive Breaking News", CIKM 2017 / TKDD 2020** (https://arxiv.org/abs/1803.00189). The event → story-tree split on Chinese news. Shows the two-layer design and its merge/extend/insert operations.
- **Yoon et al., SCStory (WWW 2023)** (https://arxiv.org/abs/2312.03725) and **USTORY (SIGIR 2023)** (https://arxiv.org/abs/2304.04099). Modern sliding-window online story discovery. Read them for windowing and confidence-based assignment, not for the self-supervised training.
- **Allan (ed.), *Topic Detection and Tracking*, 2002; Petrović et al., NAACL 2010** (https://aclanthology.org/N10-1021/). The canonical event-vs-topic definitions, plus first story detection.
- **Gao et al., ALCE, EMNLP 2023** (https://arxiv.org/abs/2305.14627). The template for replacing self-tag coverage: NLI-based citation recall and precision, validated against humans.\[1\]\[38\]
- **Tang, Laban & Durrett, MiniCheck, EMNLP 2024** (https://arxiv.org/abs/2404.10774; leaderboard https://llm-aggrefact.github.io/). The cheap grounding checker and the LLM-AggreFact benchmark.\[39\] Note that it is English-only.\[5\]
- **mDeBERTa-v3-base-xnli-multilingual-nli-2mil7** (https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7). A practical local multilingual NLI model for Chinese text, with ONNX for Transformers.js.\[7\]\[9\]\[11\] Cross-lingual accuracy is unpublished.
- **Metropolitansky & Larson, Claimify, ACL 2025** (https://aclanthology.org/2025.acl-long.348/). How to evaluate claim extraction (entailment, coverage, decontextualization) and handle ambiguity.\[3\]
- **Min et al., FActScore, EMNLP 2023** (https://arxiv.org/abs/2305.14251). The atomic-fact framing that validates Winnow's claim unit and its verification step.
- **Logan IV et al., FRUIT, NAACL 2022** (https://aclanthology.org/2022.naacl-main.269/). The formal version of "update an article with new evidence". Its ungrounded-claim rate is the reason to gate rewrites on support.\[32\]\[33\]
- **Rasmussen et al., Zep/Graphiti, 2025** (https://arxiv.org/abs/2501.13956). Edge dedup restricted to the same entity pair, plus bi-temporal invalidation instead of deletion.\[40\] Directly applicable to facts and `superseded_by`.
- **Mem0 paper (https://arxiv.org/abs/2504.19413) and v3 migration notes (https://docs.mem0.ai/migration/oss-v2-to-v3).** A production memory system that moved from LLM-chosen ADD/UPDATE/DELETE to ADD-only plus retrieval-time handling.\[20\]\[41\] A useful counterweight before investing more in online merging.
- **Peeters, Steiner & Bizer, "Entity Matching using LLMs", EDBT 2025** (https://arxiv.org/abs/2310.11244). Evidence that LLM matchers are strong but prompt-sensitive.\[14\] Read it before trusting a 45-pair F1 = 1.0.
- **Fu et al., LLM-CER, 2025** (https://arxiv.org/abs/2506.02509). Set-wise in-context clustering as a way to cut pairwise LLM calls. Its cost claims are contested.\[15\]\[42\]
- **Kuhn et al., Semantic Uncertainty, ICLR 2023** (https://arxiv.org/abs/2302.09664). Bidirectional entailment as the operational definition of "same meaning".\[43\]\[44\] This is the right spec for the "same core fact" question.
- **Aslam et al., TREC Temporal Summarization overviews** (https://trec.nist.gov/pubs/trec23/papers/overview-tempsumm.pdf). Nugget-based evaluation of update emission.\[30\] The model for a small labelled update-decision suite.
- **Panickssery et al., "LLM Evaluators Recognize and Favor Their Own Generations", NeurIPS 2024** (https://arxiv.org/abs/2404.13076). Why the QA judge must not be the writer model.\[45\]\[46\]
- **Gholipour Ghalandari & Ifrim, News Timeline Summarization, ACL 2020** (https://aclanthology.org/2020.acl-main.122/), and **WCEP** (https://aclanthology.org/2020.acl-main.120/). \[47\]\[48\] How long stories are rendered as dated event summaries: the target shape for "latest developments".

## Caveats

- **Jev / TypeSafe "System One"** has little public documentation that I could find. I treated it as a cheap LLM-based classifier, as you described. I could not verify its calibration claims; the reliability check in §4 is how to find out.
- **Cross-lingual NLI accuracy** (Chinese claim vs. English quote) for mDeBERTa, bge-reranker-v2-m3 or Bespoke-MiniCheck-7B is **not published**. Bespoke-MiniCheck-7B is built on InternLM2.5, a Chinese–English model, and is licensed CC BY-NC 4.0, which is fine for personal use.\[49\]\[50\] Its Chinese performance is untested. Measure before relying on any of them.
- **Local CPU latency** for mDeBERTa (about 279M parameters) or bge-reranker-v2-m3 (568M parameters) in Node via ONNX or llama.cpp is something I did not benchmark. At Winnow's volume (hundreds of checks a day) it is very likely acceptable, but confirm on your machine. Your local decision model is already 11–40× slower than Jev in batch.
- **The 7% vs. 29.5% redundancy gap** cannot be explained without the hard-negative and offline-merge experiment. Under-merging is plausible but unproven.
- **Mem0's v3 accuracy gains, and LLM-CER's cost reductions,** are reported by their authors.\[15\]\[22\] I cite them for design direction, not for magnitude.
- **The P3 append rendering path** ("latest developments" sections) was not fully traced in the code findings I was given. The recommendations in §4–5 assume it is produced at render or consolidation time.

## Sources

1. [Large Language Model Sourcing: A Survey](https://arxiv.org/pdf/2510.10161)
2. [Multilingual Clustering of Streaming News Sebasti˜ao Miranda♦](https://homepages.inf.ed.ac.uk/scohen/emnlp18cluster.pdf)
3. [\[2502.10855\] Towards Effective Extraction and Evaluation of Factual Claims](https://ar5iv.labs.arxiv.org/html/2502.10855)
4. [MiniCheck: Efficient Fact-Checking of LLMs on Grounding Documents](https://arxiv.org/html/2404.10774v2)
5. [MiniCheck: Efficient Fact-Checking of LLMs on Grounding Documents](https://arxiv.org/html/2404.10774v1)
6. [GitHub - yuh-zha/AlignScore: ACL2023 - AlignScore, a metric for factual consistency evaluation.](https://github.com/yuh-zha/AlignScore)
7. [MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7 · Hugging Face](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7)
8. [MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7 · Model Database](http://modeldatabase.com/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7.html)
9. [README.md · MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7 at 258fc17bc52fba21b29dc4408581bbd0f7d2fca1](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7/blame/258fc17bc52fba21b29dc4408581bbd0f7d2fca1/README.md)
10. [Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7 · Hugging Face](https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7)
11. [onnx-community/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7-ONNX · Hugging Face](https://huggingface.co/onnx-community/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7-ONNX)
12. [Enabling Large Language Models to Generate Text with Citations](https://arxiv.org/html/2305.14627v1)
13. [Enabling Large Language Models to Generate Text with ...](https://aclanthology.org/2023.emnlp-main.398.pdf)
14. [Labeling Training Data for Entity Matching Using Large Language Models](https://arxiv.org/html/2606.28823v1)
15. [In-context Clustering-based Entity Resolution with Large Language Models: A Design Space Exploration · Pith](https://pith.science/paper/2506.02509)
16. [arXiv:2501.13956v1 \[cs.CL\] 20 Jan 2025 ZEP: A TEMPORAL KNOWLEDGE GRAPH](https://arxiv.org/pdf/2501.13956)
17. [Zep: A Temporal Knowledge Graph Architecture for Agent Memory — Signals](https://signals.aktagon.com/articles/2026/07/zep-a-temporal-knowledge-graph-architecture-for-agent-memory/)
18. [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/html/2504.19413v1)
19. [GitHub - mem0ai/mem0: The Memory Layer for AI Agents - Drop-in memory infrastructure for AI agents and apps. Context that persists. Built for production. · GitHub](https://github.com/mem0ai/mem0)
20. [Open Source: Migrating to the New Memory Algorithm - Mem0](https://docs.mem0.ai/migration/oss-v2-to-v3)
21. [mem0ai/mem0 v2.0.0 on GitHub](https://newreleases.io/project/github/mem0ai/mem0/release/v2.0.0)
22. [Mem0 Rewrites Its Memory Algorithm, Hitting 94.4% Accuracy at 4x Lower Token Cost](https://alphasignal.ai/news/mem0-rewrites-its-memory-algorithm-hitting-94-4-accuracy-at-4x-lower-token-cost)
23. [Multilingual Clustering of Streaming News](https://www.researchgate.net/publication/334115598_Multilingual_Clustering_of_Streaming_News)
24. [SCStory: Self-supervised and Continual Online Story Discovery](https://arxiv.org/html/2312.03725.pdf)
25. [Story Forest: Extracting Events and Telling Stories from Breaking News](https://dl.acm.org/doi/fullHtml/10.1145/3377939)
26. [Growing Story Forest Online from Massive Breaking News](https://arxiv.org/pdf/1803.00189)
27. [(PDF) Examining the State-of-the-Art in News Timeline Summarization](https://www.researchgate.net/publication/343302326_Examining_the_State-of-the-Art_in_News_Timeline_Summarization)
28. [A Large-Scale Multi-Document Summarization Dataset ...](https://aclanthology.org/2020.acl-main.120.pdf)
29. [TREC 2013 Temporal Summarization — Lacuna](https://lacuna.tiptreesystems.com/work/trec-2013-temporal-summarization/wrk_7b0d35e52e159b98251286663192f551)
30. [TREC 2014 Temporal Summarization Track Overview Javed Aslam Fernando Diaz](https://trec.nist.gov/pubs/trec23/papers/overview-tempsumm.pdf)
31. [TREC 2013 Temporal Summarization Javed Aslam Fernando Diaz](https://trec.nist.gov/pubs/trec22/papers/TS.OVERVIEW.pdf)
32. [FRUIT: Faithfully Reflecting Updated Information in Text - ACL Anthology](https://aclanthology.org/2022.naacl-main.269/)
33. [Faithfully reflecting updated information in text: Interview with Robert Logan](https://aihub.org/2022/08/04/faithfully-reflecting-updated-information-in-text-interview-with-robert-logan-naacl2022-award-winner/)
34. [FRUIT : Faithfully Reflecting Updated Information in Text](https://aclanthology.org/2022.naacl-main.269.pdf)
35. [Enabling Large Language Models to Generate Text with Citations](https://www.alphaxiv.org/abs/2305.14627)
36. [LLM Evaluators Recognize and Favor Their Own Generations Arjun Panickssery1 |](https://proceedings.neurips.cc/paper_files/paper/2024/file/7f1f0218e45f5414c79c0679633e47bc-Paper-Conference.pdf)
37. [Breaking the Mirror: Activation-Based Mitigation of Self-Preference in LLM Evaluators](https://arxiv.org/pdf/2509.03647)
38. [\[2305.14627\] Enabling Large Language Models to Generate Text with Citations](https://arxiv.org/abs/2305.14627)
39. [LLM-AggreFact Leaderboard](https://llm-aggrefact.github.io/)
40. [Zep/Graphiti: agent memory as a bi-temporal knowledge graph - Database Learning Path](https://aviavni.github.io/database-learning-path/topics/38-graphrag-agent-memory/reading-zep-graphiti.html)
41. [Mem0 Paper: Production-Ready Agents with Long-Term Memory](https://aiagentmemory.org/articles/mem0-building-production-ready-ai-agents/)
42. [In-context Clustering-based Entity Resolution with Large Language Models: A Design Space Exploration](https://arxiv.org/pdf/2506.02509)
43. [Efficient semantic uncertainty quantification in language models via diversity-steered sampling](https://arxiv.org/html/2510.21310v1)
44. [Published as a conference paper at ICLR 2023](https://arxiv.org/pdf/2302.09664v3)
45. [\[PDF\] LLM Evaluators Recognize and Favor Their Own Generations](https://www.semanticscholar.org/paper/LLM-Evaluators-Recognize-and-Favor-Their-Own-Panickssery-Bowman/5c7f465d162aade4a4c0eefb02fd7aadeebdaf58)
46. [NeurIPS Poster LLM Evaluators Recognize and Favor Their Own Generations](https://neurips.cc/virtual/2024/poster/96672)
47. [Examining the State-of-the-Art in News Timeline ...](https://aclanthology.org/2020.acl-main.122.pdf)
48. [A Large-Scale Multi-Document Summarization Dataset from the Wikipedia Current Events Portal - ACL Anthology](https://aclanthology.org/2020.acl-main.120/)
49. [README.md · bespokelabs/Bespoke-MiniCheck-7B at 1b39a0f54d7bdcd5884a8ca3c0f72d74affeba87](https://huggingface.co/bespokelabs/Bespoke-MiniCheck-7B/blame/1b39a0f54d7bdcd5884a8ca3c0f72d74affeba87/README.md)
50. [Specialized LLMs: A Guide to Bespoke Labs' Open Models](https://intuitionlabs.ai/articles/bespoke-labs-specialized-llms)
