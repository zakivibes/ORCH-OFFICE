import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJob, extractPaths } from "../src/core/jobs.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures");

test("parseJob reads the real L2 job: numbered items, files, tests, checks", () => {
  const text = readFileSync(join(FIXTURES, "job_L2.txt"), "utf8");
  const job = parseJob(text);

  assert.equal(job.items.length, 5, "five DO items");
  assert.deepEqual(
    job.items.map((i) => i.id),
    ["1", "2", "3", "4", "5"],
  );

  const first = job.items[0]!;
  assert.ok(first.text.includes("per-track table cache"));
  assert.ok(first.files.includes("backend/src/services/levelService.js"));

  const second = job.items[1]!;
  assert.ok(second.files.includes("backend/src/services/moneyRegistry.js"));

  const testItem = job.items.find((i) => i.tests.length > 0);
  assert.ok(testItem, "an item names a test path");
  assert.ok(testItem!.tests.some((t) => t.includes("levels_engine_201.test.js")));

  assert.ok(job.checks.length > 0, "Checks: line captured");
  assert.ok(job.checks.some((c) => c.includes("npm test")));
  // The trailing "Do NOT change..." prose must not leak into item files.
  const fifth = job.items[4]!;
  assert.ok(!fifth.files.includes("giftController.js"));
});

test("parseJob falls back to every numbered line without a DO heading", () => {
  const job = parseJob("Intro text about the task.\n1) Fix the crash in src/app.ts\n2) Update README.md\n");
  assert.equal(job.items.length, 2);
  assert.equal(job.items[0]!.id, "1");
  assert.ok(job.items[0]!.files.includes("src/app.ts"));
  assert.equal(job.items[1]!.id, "2");
});

test("parseJob handles letters, bullets and continuation lines", () => {
  const text = [
    "JOB X — small",
    "DO:",
    " a) write src/core/thing.ts and keep it small",
    "   continue the thought on the next line",
    " - ship test/thing.test.ts for it",
    " b) build dist/main.js via bash",
    "Checks: npm test 2>&1 | tail -3",
  ].join("\n");
  const job = parseJob(text);
  assert.deepEqual(
    job.items.map((i) => i.id),
    ["a", "b1", "b"],
  );
  assert.equal(job.items[0]!.files.join(","), "src/core/thing.ts");
  assert.ok(job.items[0]!.text.includes("continue the thought"));
  assert.deepEqual(job.items[1]!.tests, ["test/thing.test.ts"]);
  assert.deepEqual(job.checks, ["npm test 2>&1 | tail -3"]);
});

test("extractPaths keeps slashed paths and bare source names, drops prose", () => {
  const got = extractPaths("edit backend/src/a.ts and moneyRegistry.js, see T[201] and CAP=201.");
  assert.deepEqual(got, ["backend/src/a.ts", "moneyRegistry.js"]);
});
