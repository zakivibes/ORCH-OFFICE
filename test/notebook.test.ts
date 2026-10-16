import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/db.js";
import { zeroUsage, type StoredSession } from "../src/core/types.js";
import { buildHandoff, digestSession, verifyOutcome } from "../src/core/notebook.js";
import { buildFileMap, pickDecls } from "../src/core/digest.js";
import { parseCard, selectCards } from "../src/core/cards.js";

const JOB = `JOB demo
DO
1) Build the widget in lib/a.dart and test it in test/a_test.dart
2) Wire it into lib/b.dart
Checks:
flutter test test/a_test.dart
`;

function mkStore() {
  return new Store(join(mkdtempSync(join(tmpdir(), "orch-nb-")), "t.db"));
}
function mkSession(store: Store, id: string, cwd: string, createdAt: number) {
  const s: StoredSession = {
    id, tool: "agy", native: "n", cwd, model: "m", label: id, createdAt, updatedAt: createdAt,
    closedAt: null, rootPid: null, totals: zeroUsage(), costUsd: 0,
  };
  store.insertSession(s);
  store.setJob(id, ".worker_tmp/jobs/demo.txt", JOB, "[]");
}

test("verifyOutcome reads flutter, analyzer and node test output", () => {
  assert.equal(verifyOutcome("00:04 +41: All tests passed!"), true);
  assert.equal(verifyOutcome("00:04 +40 -2: Some tests failed."), false);
  assert.equal(verifyOutcome("14 issues found."), null, "info lints alone are not a failure");
  assert.equal(verifyOutcome("error • Undefined name x • lib/a.dart:3:1\n1 issue found."), false);
  assert.equal(verifyOutcome("No issues found!"), true);
  assert.equal(verifyOutcome("loading test/a_test.dart"), null);
});

test("digestSession: edits (opencode and agy shapes), shell writes, verification, stops, DONE lines", () => {
  const d = digestSession({ id: "s", label: "l", model: "m" }, [
    { t: "tool.call", id: "1", name: "read", input: { filePath: "/x/a.dart" } },
    { t: "tool.call", id: "2", name: "edit", input: { filePath: "/x/a.dart" } },
    { t: "tool.call", id: "3", name: "replace_file_content", input: { tool_info: { name: "replace_file_content", parameters: { TargetFile: "/x/b.dart" } } } },
    { t: "tool.call", id: "4", name: "run_command", input: { tool_info: { name: "run_command", parameters: { CommandLine: "cat > c.txt <<EOF" } } } },
    { t: "tool.call", id: "5", name: "bash", input: { command: "flutter test test/a_test.dart" } },
    { t: "tool.result", id: "5", ok: true, output: "00:04 +40 -2: Some tests failed." },
    { t: "text.delta", text: "DONE 1\nworking on 2" },
    { t: "error", kind: "budget", message: "FIRST_WRITE: 41 calls and nothing written (limit 40)." },
  ]);
  assert.deepEqual(d.edits, ["/x/a.dart", "/x/b.dart"]);
  assert.equal(d.callsBeforeFirstEdit, 1);
  assert.equal(d.shellWrites.length, 1);
  assert.deepEqual(d.verifies, [{ cmd: "flutter test test/a_test.dart", ok: false }]);
  assert.deepEqual(d.done, ["1"]);
  assert.match(d.stops[0]!, /FIRST_WRITE/);
});

test("hand-off: a second session of the same job gets files, failing test, stop reason, checklist and NEXT within 3000 chars", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orch-nb-cwd-"));
  mkdirSync(join(cwd, "lib"));
  writeFileSync(join(cwd, "lib/a.dart"), "class A {}\n");
  const store = mkStore();
  mkSession(store, "s1", cwd, 1000);
  for (const ev of [
    { t: "tool.call", id: "1", name: "edit", input: { filePath: join(cwd, "lib/a.dart") } },
    { t: "tool.call", id: "2", name: "bash", input: { command: "flutter test test/a_test.dart" } },
    { t: "tool.result", id: "2", ok: true, output: "00:04 +3 -1: Some tests failed." },
    { t: "text.delta", text: "DONE 1\nI was about to wire lib/b.dart" },
    { t: "error", kind: "budget", message: "FIRST_WRITE: 61 read/grep calls since the last edit (limit 60)." },
  ] as const) store.appendEvent("s1", ev);
  mkSession(store, "s2", cwd, 2000);
  const h = buildHandoff(store, { cwd, jobPath: ".worker_tmp/jobs/demo.txt", jobText: JOB, sessionId: "s2" });
  assert.ok(h.length <= 3100, `hand-off is ${h.length} chars`);
  assert.match(h, /1 earlier session of this job/);
  assert.match(h, /lib\/a\.dart/);
  assert.match(h, /FAIL\s+flutter test test\/a_test\.dart/);
  assert.match(h, /FIRST_WRITE.*write sooner/);
  assert.match(h, /\[x\] 1 /);
  assert.match(h, /\[ \] 2 /);
  assert.match(h, /NEXT: 2 /);
  // a different job file in the same cwd gets nothing, and so does the first session
  assert.equal(buildHandoff(store, { cwd, jobPath: ".worker_tmp/jobs/other.txt", jobText: JOB, sessionId: "s2" }), "");
  assert.equal(buildHandoff(store, { cwd, jobPath: ".worker_tmp/jobs/demo.txt", jobText: JOB, sessionId: "s1" }), "");
});

test("hand-off stays under the cap when the trail is huge", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orch-nb-cwd-"));
  const store = mkStore();
  mkSession(store, "s1", cwd, 1000);
  for (let i = 0; i < 80; i++) store.appendEvent("s1", { t: "tool.call", id: `e${i}`, name: "edit", input: { filePath: `${cwd}/lib/file_${i}_with_a_long_name.dart` } });
  store.appendEvent("s1", { t: "text.delta", text: "x".repeat(5000) });
  mkSession(store, "s2", cwd, 2000);
  const h = buildHandoff(store, { cwd, jobPath: ".worker_tmp/jobs/demo.txt", jobText: JOB, sessionId: "s2", maxChars: 1200 });
  assert.ok(h.length <= 1300, `${h.length}`);
  assert.match(h, /NEXT:/, "the highest-priority parts survive trimming");
});

test("file map lists declarations with line numbers for dart and ts, skips missing files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orch-fm-"));
  mkdirSync(join(cwd, "lib"));
  writeFileSync(join(cwd, "lib/p.dart"),
    "import 'x.dart';\nclass Panel extends StatefulWidget {\n}\nclass _PanelState extends State<Panel> {\n  Future<void> _placeBet(int a) async {\n  }\n  Widget build(BuildContext c) {\n    return Container();\n  }\n  void _tiny() {}\n}\n");
  writeFileSync(join(cwd, "t.ts"), "export function go() {}\nexport class K {\n  run(a: number) {\n  }\n}\n");
  const map = buildFileMap(cwd, "edit lib/p.dart and t.ts and lib/missing.dart");
  assert.match(map, /lib\/p\.dart \(\d+ lines\)/);
  assert.match(map, /2: class Panel/);
  assert.match(map, /5: Future<void> _placeBet/);
  assert.match(map, /7: Widget build/);
  assert.match(map, /1: export function go/);
  assert.doesNotMatch(map, /missing/);
  assert.equal(buildFileMap(cwd, "nothing here"), "");
  const many = Array.from({ length: 40 }, (_, i) => ({ line: i + 1, text: `m${i}`, rank: i % 3 }));
  assert.equal(pickDecls(many, 12).length, 12);
});

test("cards: pinned always, others by tag overlap, size capped, bad files skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-cards-"));
  writeFileSync(join(dir, "a.md"), "---\ntitle: Money guards\ntags: money,wallet\ndescription: never weaken\npinned: true\n---\nKeep every guard.\n");
  writeFileSync(join(dir, "b.md"), "---\ntitle: Crash panel\ntags: crash,rocket\ndescription: bets\npinned: false\n---\nUse the lobby round.\n");
  writeFileSync(join(dir, "c.md"), "---\ntitle: Roulette\ntags: roulette\ndescription: x\npinned: false\n---\nunrelated\n");
  writeFileSync(join(dir, "bad.md"), "no frontmatter");
  const out = selectCards("rebuild the crash screen", 1500, dir);
  assert.match(out, /Money guards/);
  assert.match(out, /Crash panel/);
  assert.doesNotMatch(out, /Roulette/);
  assert.ok(selectCards("crash", 150, dir).length <= 160);
  assert.equal(selectCards("x", 1500, join(dir, "nope")), "");
  assert.equal(parseCard("---\ntags: a\n---\nbody"), null);
});
