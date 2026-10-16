# ORCH OFFICE update — fewer tokens per job, and "% of the goal done" per worker (2026-10-16)

Two asks from the owner of the orch:
1. Workers burn tokens exploring, not generating. Push them to generate, and get real value from graphify (or similar).
2. The Office should show, per session, what share of the job the orchestrator gave it was done — and, per program
   (the coordinator's main job), how much the workers achieved overall.

## What the data says (orch.db, last 24 h)

| Session | tool calls | edits | reads/greps | graphify | tokens read |
|---|---|---|---|---|---|
| qwen-levels-server-w24 | 306 | **0** | 181 | 3 | 9.1M |
| qwen-one-room-w23b | 522 | 15 | 358 | 33 | 5.4M |
| qflash-L2-engine | 304 | 24 | 30 | 19 | 10.0M (2 turns, compaction mid-way) |
| qwen-L1-curve (anchors pasted in the job) | ~20 | 2 | few | 1 | **0.02M** |
| nemo-closeroom-w20 (Bunny, free) | 544 | 48 | 236 | 0 | 30.9M |

- ~97 % of every session's cost is **cached context re-sent per step**: cost ≈ context size × steps. Output tokens are 1–3 %.
- The waste has one shape: **long exploration with no write** (w24: 306 calls, 0 edits), then a compaction, then re-reading the
  same files (w23b read `room_service.dart` 31 times). The loop guard (88e3dad…79b7902) catches the loops after the fact; nothing
  yet makes the worker *write earlier*.
- When the coordinator pastes `graphify explain` anchors (file:line) into the job, the session is ~40× cheaper (L1 vs L2, same
  engine area). The worker's own graphify use is rare (0–33 calls) and often noisy (`query`).
- The DB stores `tool.call` (with inputs: paths, commands, **todowrite todos**), `text.delta`, `usage.progress`, `turn.completed`
  (`result_text`). It does **not** store tool results. Jobs live only as `.worker_tmp/jobs/*.txt` files; the orch does not know
  which job a session is on.

## Part A — push the generation (token thrift)

Principle: **tokens per accepted job** is the metric, not tokens per step. Every measure below either cuts steps before the
first write, caps the context a step re-sends, or front-loads exact anchors so exploration is unnecessary.

### A1. The job becomes a first-class object
- `orch_open` / `orch_send` get `job: <path>` (job file). The daemon stores it (`jobs` table: session_id, path, text, items JSON)
  and **parses** it: numbered items (`1)`, `a)`, `-` bullets under DO), files mentioned (`backend/src/…`, `lib/…`), the
  `Checks:` commands, and test paths. This is the backbone of Part B and of the guards below.
- The job's parsed item list is also appended to the first prompt as a compact checklist, so the model and the office share the
  same numbering.

### A2. Anchor pack (graphify, automated, coordinator-side)
- When a job is attached, the daemon runs `graphify explain "<anchor>"` for each `file::symbol` it finds in the job text (and
  `graphify explain "<file>"` for each file with no symbol), trims each answer to its `file:line` lines (≤ 40 lines per anchor,
  ≤ 800 tokens total) and prepends an **"Anchors (from the code graph)"** block to the prompt.
- Effect: the worker starts with exact lines and the graph-first rule is already satisfied. This is what made L1 cost 20k tokens.
- Fallback: no graph in the cwd → skip silently. "Similar tools": keep the CLI (the graphify MCP server costs ~2.5k tokens/step);
  optionally add an `ast-grep`/`ctags` symbol lookup for the Dart-member and JS `obj.method` cases the graph does not index.

### A3. First-write guard + auto-nudge (loopGuard + daemon)
- New limit `maxStepsBeforeFirstEdit` (default 40): a turn with no edit/write by then is **stopped** with the reason
  "40 calls, nothing written — write the first file from what you already know".
- New limit `maxExploreSinceLastEdit` (default 60): once the turn has written, more than 60 read/grep/bash-read calls with no
  further edit stops it the same way (this is the post-compaction re-read pattern).
- **Auto-nudge**: instead of waiting for the coordinator, the daemon sends ONE follow-up turn by itself:
  "Continue. Write now; do not re-read. Done so far: <items marked done>. Next: <first open item>." At most `autoNudges`
  (default 2) per session, then it reports to the coordinator as today. The nudge is cheap (context is cached).
- Measured need: the coordinator did exactly this by hand three times tonight (w33d twice, L2 once).

### A4. Context watchdog + session rollover
- Per step, `usage.progress` gives the context size (input + cache read). New limit `maxStepContextTokens` per model
  (paid Alibaba 60k, NVIDIA 120k, free Bunny 0 = off). When a step exceeds it, the daemon ends the turn and **rolls the session
  over**: opens a fresh session with the same model, the job file, the anchor pack and a "done so far" list (from Part B's
  progress model + the last `result_text`), and links it to the old one (`sessions.rolled_from`).
- This turns cost from (growing context × steps) into a flat per-step cost. Compaction inside opencode stays on as a backstop,
  but rollover happens before the model gets confused by a summary.

### A5. Thrift metrics in the Office (so the effect is visible)
Per session and in the dashboard strip: **tokens per edit**, **explore ratio** (reads+greps / edits), **graphify calls**,
**steps before first write**, **cached share** (cache read / total read), **waste** (tokens spent after the last edit of a turn
that produced nothing). Colour: green/amber/red against the limits. Sorting by "tokens per accepted job" on the Turns view.

### A6. Smaller fixed context (already measured, keep enforcing)
- Root `AGENTS.md` ≤ 5 KB (done for YemanChat: 32k → 23k tokens/step). Add a daemon warning when the cwd's AGENTS.md is > 8 KB.
- Workers pipe tests through `tail`; the daemon warns on a bash command running a test suite without `tail`/`grep` (pattern in
  loopGuard's TEST_CMD).

## Part B — "% of the goal" per session and per program

### B1. Progress model (automatic, evidence-based)
For each parsed job item, score 0 / 0.5 / 1 from stored events only:
- **Todo evidence**: the worker's `todowrite` calls (already stored with `status`) are fuzzy-matched to job items by token
  overlap; `completed` → 1, `in_progress` → 0.5.
- **File evidence**: an edit/write/shell-write event whose path matches a file named in the item → at least 0.5.
- **Test evidence**: the turn's `result_text` contains `N passed, 0 failed` / `All tests passed` for a test path named in the
  item → 1 for that item.
- **Report evidence**: the final report lists the item's file under "files changed" → 0.5 if nothing else.
Session **auto %** = mean over items. Each item shows its evidence (which event, which file, which line of the report) so the
coordinator can see *why* it is 50 % and not guess.

### B2. Coordinator grade (ground truth)
- New MCP tool `orch_grade(sessionId, pct, note)` (and an Office button) → `grades` table. This is what the coordinator sets after
  running the tests and reading the diff. The Office shows **auto %** and **accepted %** side by side; a big gap flags a worker
  that claims more than it did (e.g. w33b reported two test files that did not exist).

### B3. Programs (the coordinator's main job)
- `~/.orchestrator/programs.json` (also editable from the Office): `{ id, name, items: [{ job, weight, sessions: [ids] }] }`.
  `orch_program(add|link|set-weight)` MCP tool, so the coordinator registers "Levels engine 1–201" = {L1 10 %, L2 25 %, L3 25 %,
  A1 10 %, A2a 10 %, A2b 10 %, A2c 10 %}.
- Program % = Σ weight × accepted % (auto % until graded). The Office gets a **Programs** strip on the dashboard: name, % done,
  tokens spent, tokens per % point, which sessions contributed, and per session "did X % of its job = Y % of the program".
- History: a program keeps every session that touched an item, including the failed ones, so "how much did the workers do" is
  honest: tokens burned by a 0 % session count against the program.

### B4. Office UI
- New **Job** tab in the worker panel: checklist of items with score, evidence, auto % vs accepted %, grade button, and the
  thrift metrics (A5).
- Dashboard: Programs strip (B3) + the thrift totals; the Turns view adds the per-turn "edits / explore / first write at step".
- Everything stays plain HTML in `office/index.html` + `office/server.mjs`, same style as today.

## Work split (small jobs, one worker each, NVIDIA GLM-flash unless noted)

| Job | Scope | Files | Tests |
|---|---|---|---|
| **O1 core jobs + progress** | A1 parse, `jobs`/`grades` tables, progress scoring (B1), `orch_grade`, `orch_program`, `programs.json` | `src/core/db.ts`, new `src/core/jobs.ts`, `src/core/progress.ts`, `src/mcp/server.ts` | `test/jobs.test.ts`, `test/progress.test.ts` (fixture events from tonight's sessions) |
| **O2 guards + nudge + rollover** | A3, A4, `limits.json` keys, daemon auto-nudge and rollover | `src/core/loopGuard.ts`, `limits.ts`, `registry.ts`, `daemon.ts` | extend `test/loopGuard.test.ts`; rollover test with a fake adapter |
| **O3 anchor pack** | A2 (`graphify` runner, trimming, prompt prepend, warnings A6) | new `src/core/anchors.ts`, `registry.ts` | `test/anchors.test.ts` (graphify stubbed) |
| **O4 Office** | A5 metrics, B4 Job tab, Programs strip, grade button, `/api/job`, `/api/programs` | `office/server.mjs`, `office/index.html` | manual + `office/demo-db.mjs` fixture |

Order: O1 → O4; O2 and O3 are independent. Each is one session, with anchors pasted (the orch repo has no graph yet: run
`graphify update . --no-cluster` in `~/Desktop/orchestrator` first). Changes are made in the Desktop repo (tests 74/74 must stay
green), copied to `~/orchestrator`, and the daemon restarted at a shift change (03:00 Istanbul) so no live worker is cut.

## Expected effect (from tonight's numbers)
- Zero-edit sessions (3 tonight, ~25M tokens) become ≤ 40-step turns (~1M) via A3.
- Anchor packs move most jobs toward the L1 profile (tens of k instead of millions) for jobs with named symbols.
- Rollover keeps paid Qwen steps at ≤ 60k context instead of growing to 100k+ before compaction.
- Target to verify after one week in the Office: **tokens per accepted job down ≥ 5×** on Alibaba, with accepted % per session
  visible for every job the coordinator hands out.

## Owner decisions
✅ **Approved 2026-10-16 (owner): all three as recommended** — O1–O4 on NVIDIA, the defaults below, auto-nudge without the coordinator.

1. Approve the split (O1–O4) and NVIDIA for all four (Alibaba night shift only if NVIDIA is rate-limited).
2. Defaults: `maxStepsBeforeFirstEdit` 40, `maxExploreSinceLastEdit` 60, `autoNudges` 2, `maxStepContextTokens` 60k (Alibaba) /
   120k (NVIDIA) / off (free).
3. Whether the auto-nudge may run without the coordinator (recommended yes — it only sends "write now", never new instructions).
