import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/db.js";
import { zeroUsage } from "../src/core/types.js";
import type { Event } from "../src/core/types.js";
import { parseJob, type JobItem } from "../src/core/jobs.js";
import { scoreItems, scoreSession, tokenOverlap } from "../src/core/progress.js";
import {
  loadPrograms,
  savePrograms,
  addProgram,
  link,
  setWeight,
  programPct,
} from "../src/core/programs.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures");
const jobText = readFileSync(join(FIXTURES, "job_L2.txt"), "utf8");

function scratchDb(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), "orch-prog-")), "t.db"));
}

/** Events shaped like the L2 session: todos, an edit, a shell write, a report. */
function fixtureEvents(items: JobItem[]): Event[] {
  return [
    {
      t: "tool.call",
      id: "t1",
      name: "todowrite",
      input: {
        todos: [
          { content: "Add a per-track table cache to levelService", status: "completed" },
          { content: "Seed the level rule keys in moneyRegistry", status: "in_progress" },
        ],
      },
    },
    { t: "tool.call", id: "t2", name: "edit", input: { filePath: "/work/YemanChat/backend/src/services/levelService.js" } },
    { t: "tool.call", id: "t3", name: "bash", input: { command: "echo x > backend/src/services/ruleWriteService.js" } },
    {
      t: "text.delta",
      text: `Files changed: backend/src/services/levelService.js, backend/src/services/ruleWriteService.js\n${items[4]!.tests[0]}: 12 passed, 0 failed\n`,
    },
    { t: "turn.completed", usage: zeroUsage(), durationMs: 1000, turns: 1 },
  ];
}

test("tokenOverlap is containment of the smaller set", () => {
  assert.ok(tokenOverlap("Add a per-track table cache", "per-track table cache in levelService") >= 0.4);
  assert.ok(tokenOverlap("write the report", "paint the bike shed far away from here") < 0.4);
});

test("scoreItems: todo, file, shell-write, test and report evidence", () => {
  const job = parseJob(jobText);
  const { items, autoPct } = scoreItems(job.items, fixtureEvents(job.items), [
    {
      resultText:
        `job done.\nFiles changed: backend/src/services/levelService.js\n` +
        `${job.items[4]!.tests[0]}: 12 passed, 0 failed`,
    },
  ]);

  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get("1")!.score, 1, "todo completed + edit + report");
  assert.ok(byId.get("1")!.evidence.some((e) => e.startsWith("todo completed")));
  assert.equal(byId.get("2")!.score, 0.5, "in_progress todo");
  assert.equal(byId.get("3")!.score, 0.5, "shell write to the item's file");
  assert.deepEqual(byId.get("3")!.evidence, ["wrote backend/src/services/ruleWriteService.js"]);
  assert.equal(byId.get("4")!.score, 0, "no evidence");
  assert.equal(byId.get("5")!.score, 1, "result_text 'N passed, 0 failed' naming the item's test");
  assert.equal(autoPct, 0.6);
});

test("scoreItems: all tests passed wording and report-only evidence", () => {
  const job = parseJob(jobText);
  const item4 = job.items[3]!;
  const item4Only = [item4];
  const { items } = scoreItems(item4Only, [], [{ resultText: "All tests passed. Files: meController.js" }]);
  assert.equal(items[0]!.score, 0.5, "report lists the item's file");
  const { items: noReport } = scoreItems(item4Only, [], [{ resultText: "All tests passed." }]);
  assert.equal(noReport[0]!.score, 0, "passing tests that are not the item's test do not count");
});

test("scoreSession scores a stored job from stored events and turns", () => {
  const store = scratchDb();
  const sessionId = "sess-l2";
  const job = parseJob(jobText);
  store.insertSession({
    id: sessionId,
    tool: "opencode",
    native: "n-1",
    cwd: "/work/YemanChat",
    model: "opencode/qwen",
    label: "L2",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    closedAt: null,
    rootPid: null,
    totals: zeroUsage(),
    costUsd: 0,
  });
  store.setJob(sessionId, "jobs/L2_levels_engine.txt", jobText, JSON.stringify(job.items));
  for (const ev of fixtureEvents(job.items)) store.appendEvent(sessionId, ev);
  const turnId = store.startTurn(sessionId, "do the L2 job");
  store.endTurn(turnId, {
    usage: zeroUsage(),
    costUsd: 0,
    aborted: false,
    resultText:
      "Files changed: backend/src/services/levelService.js\n" +
      `${job.items[4]!.tests[0]} 12 passed, 0 failed`,
  });

  const progress = scoreSession(store, sessionId);
  assert.equal(progress.items.length, 5);
  assert.equal(progress.autoPct, 0.6);

  store.setGrade(sessionId, 0.85, "tests green, curve plugged");
  const grade = store.getGrade(sessionId)!;
  assert.equal(grade.pct, 0.85);
  assert.equal(grade.note, "tests green, curve plugged");

  // A session without a stored job scores empty, not an error.
  store.insertSession({
    id: "sess-nojob",
    tool: "opencode",
    native: "n-2",
    cwd: "/tmp",
    model: "m",
    label: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    closedAt: null,
    rootPid: null,
    totals: zeroUsage(),
    costUsd: 0,
  });
  assert.deepEqual(scoreSession(store, "sess-nojob"), { items: [], autoPct: 0 });
  assert.equal(scoreSession(store, "sess-unknown").autoPct, 0);
  store.close();
});

test("programs: add, link, weight, pct and tokens spent from a temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-programs-"));
  process.env.ORCH_PROGRAMS_FILE = join(dir, "programs.json");

  const loaded = loadPrograms();
  assert.deepEqual(loaded, { programs: [] });

  addProgram(loaded, "levels", "Levels engine 1-201");
  assert.throws(() => addProgram(loaded, "levels", "again"));
  const item = link(loaded, "levels", "jobs/L2_levels_engine.txt", "sess-l2");
  link(loaded, "levels", "jobs/L2_levels_engine.txt", "sess-l2"); // dedupe
  assert.deepEqual(item.sessions, ["sess-l2"]);
  link(loaded, "levels", "jobs/L1_level_curve.txt", "sess-l1");
  setWeight(loaded, "levels", "jobs/L2_levels_engine.txt", 3);
  assert.equal(setWeight(loaded, "levels", "jobs/L1_level_curve.txt", 1).weight, 1);
  assert.throws(() => setWeight(loaded, "levels", "jobs/none.txt", 2));

  const program = loaded.programs[0]!;
  const pctOf = (id: string) => (id === "sess-l2" ? 0.6 : id === "sess-l1" ? 1 : null);
  const tokensOf = (id: string) => (id === "sess-l2" ? 1_000_000 : id === "sess-l1" ? 20_000 : 0);
  const { pct, tokensSpent } = programPct(program, pctOf, tokensOf);
  // (3*0.6 + 1*1) / (3+1) = 0.7; a failed session (null -> 0) would still burn its tokens.
  assert.equal(pct, 0.7);
  assert.equal(tokensSpent, 1_020_000);

  savePrograms(loaded);
  const reloaded = loadPrograms();
  assert.equal(reloaded.programs[0]!.items.length, 2);
  assert.equal(reloaded.programs[0]!.items[0]!.weight, 3);
  const again = programPct(reloaded.programs[0]!, pctOf, tokensOf);
  assert.equal(again.pct, 0.7);

  const failed = loadPrograms();
  const burn = addProgram(failed, "burn", "the failed session counts");
  link(failed, "burn", "jobs/L2_levels_engine.txt", "sess-zero");
  assert.equal(programPct(burn, () => null, () => 5_000_000).tokensSpent, 5_000_000);
  assert.equal(programPct(burn, () => null, () => 5_000_000).pct, 0);
});
