import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsMdWarning, buildAnchorPack, extractAnchors } from "../src/core/anchors.js";
import { Registry } from "../src/core/registry.js";
import { Store } from "../src/core/db.js";
import { zeroUsage, type Adapter, type AdapterCaps, type Event, type Handle } from "../src/core/types.js";

process.env.ORCH_CONFIG_FILE = join(tmpdir(), "orch-anchors-no-config.json");
process.env.ORCH_QUOTA_FILE = join(tmpdir(), "orch-anchors-quota.json");

// fixtures live in the source tree; tsc does not copy them next to the compiled test
const fixtureText = readFileSync(join(import.meta.dirname, "..", "..", "test", "fixtures", "job_L2.txt"), "utf8");

const FAKE_EXPLAIN = [
  "Node: .send()",
  "  ID:        src_core_registry_registry_send",
  "  Source:    src/core/registry.ts L206",
  "  Type:      code",
  "  Degree:    24",
  "",
  "Connections (24):",
  "  --> .send() [calls] [EXTRACTED] src/core/registry.ts:L272",
  "  <-- Registry [method] [EXTRACTED] src/core/registry.ts:L206",
  "  ... and 4 more (--all lists all 24)",
  "  Grouped by file:",
  "    --> src/core/registry.ts: 4 connections",
].join("\n");

const caps: AdapterCaps = {
  persistent: true,
  permissionFidelity: "native",
  interrupt: true,
  structuredOutput: false,
  costUsd: false,
  subagents: false,
};

test("extractAnchors finds path::symbol tokens and bare paths from a real job", () => {
  const anchors = extractAnchors(fixtureText);
  assert.ok(anchors.length > 0 && anchors.length <= 12);
  assert.ok(anchors.includes("levelService.js::levelForSpend"));
  assert.ok(anchors.includes("backend/src/services/levelService.js"));
  // repeated bare paths collapse to one
  assert.equal(anchors.filter((a) => a === "tests/levels_curve.test.js").length, 1);
  // no duplicates at all
  assert.equal(new Set(anchors).size, anchors.length);
});

test("extractAnchors prefers the symbol anchor over the bare path and caps at 12", () => {
  const text = "src/core/registry.ts::.send() and src/core/registry.ts again";
  assert.deepEqual(extractAnchors(text), ["src/core/registry.ts::.send()"]);
  const many = Array.from({ length: 15 }, (_, i) => `src/mod${i}.ts`).join(" ");
  assert.equal(extractAnchors(many).length, 12);
});

test("buildAnchorPack keeps only Source and :L lines from stubbed graphify output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-anchors-"));
  mkdirSync(join(dir, "graphify-out"));
  const jobText = "look at src/core/registry.ts::.send()";
  const calls: string[][] = [];
  const pack = await buildAnchorPack(dir, jobText, {
    run: async (args) => {
      calls.push(args);
      return FAKE_EXPLAIN;
    },
  });
  assert.deepEqual(calls, [["explain", "src/core/registry.ts::.send()"]]);
  assert.ok(pack.startsWith("src/core/registry.ts::.send()\n"));
  assert.ok(pack.includes("Source:    src/core/registry.ts L206"));
  assert.ok(pack.includes("src/core/registry.ts:L272"));
  assert.ok(!pack.includes("Grouped by file"));
  assert.ok(!pack.includes("and 4 more"));
  assert.ok(!pack.includes("ID:"));
  // budget: pack is small in tokens (chars/4)
  assert.ok(pack.length / 4 <= 800);
});

test("buildAnchorPack stops adding anchors once the token budget is reached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-anchors-"));
  mkdirSync(join(dir, "graphify-out"));
  const jobText = `a src/a.ts::foo b src/b.ts::bar c src/c.ts::baz`;
  const pack = await buildAnchorPack(dir, jobText, {
    maxTokens: 10,
    run: async () => FAKE_EXPLAIN,
  });
  assert.ok(pack.includes("src/a.ts::foo"));
  assert.ok(!pack.includes("src/c.ts::baz"));
  assert.ok(pack.length / 4 <= 10 + FAKE_EXPLAIN.length / 4, "first block always lands, the rest stop");
});

test("buildAnchorPack returns empty when the cwd has no graphify-out or graphify is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-anchors-"));
  assert.equal(await buildAnchorPack(dir, fixtureText, { run: async () => FAKE_EXPLAIN }), "");

  mkdirSync(join(dir, "graphify-out"));
  const err = new Error("spawn graphify ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  assert.equal(await buildAnchorPack(dir, fixtureText, { run: async () => { throw err; } }), "");
});

test("agentsMdWarning fires only above 8 KB", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-anchors-"));
  assert.equal(agentsMdWarning(dir), "");
  writeFileSync(join(dir, "AGENTS.md"), "x".repeat(8 * 1024));
  assert.equal(agentsMdWarning(dir), "");
  writeFileSync(join(dir, "AGENTS.md"), "x".repeat(8 * 1024 + 1));
  assert.ok(agentsMdWarning(dir).includes("> 8 KB"));
});

class JobAdapter implements Adapter {
  readonly id = "opencode" as const;
  readonly caps = caps;
  lastPrompt = "";
  async spawn(): Promise<Handle> {
    return { tool: "opencode", id: "s-job", native: "n", cwd: this.cwd, model: "fake", caps };
  }
  constructor(readonly cwd: string) {}
  async *send(_handle: Handle, prompt: string): AsyncGenerator<Event> {
    this.lastPrompt = prompt;
    yield { t: "turn.completed", usage: zeroUsage(), durationMs: 1, turns: 1 };
  }
  async interrupt() {}
  async close() {}
}

test("registry.send with a job file prepends the job text and anchors heading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-anchors-"));
  writeFileSync(join(dir, "job.txt"), "fix the level cap in backend/src/services/levelService.js");
  const adapter = new JobAdapter(dir);
  const reg = new Registry(new Store(join(mkdtempSync(join(tmpdir(), "orch-db-")), "t.db")));
  (reg as unknown as { build: () => Adapter }).build = () => adapter;
  const { handle } = await reg.open({ tool: "opencode", cwd: dir, roots: [dir], job: "job.txt" });

  const events: Event[] = [];
  for await (const ev of reg.send({ sessionId: handle.id, prompt: "go" })) events.push(ev);
  assert.ok(adapter.lastPrompt.startsWith("go\n\n## Start routine (orch)\n"));
  assert.ok(adapter.lastPrompt.includes("\n## Job (job.txt)\n"));
  assert.ok(adapter.lastPrompt.includes("fix the level cap"));
  assert.ok(adapter.lastPrompt.includes("## Anchors (from the code graph"));
  // no graphify-out in cwd -> empty pack -> the session is not marked as graph-covered
  assert.ok(!events.some((e) => e.t === "text.delta"), "no warning when AGENTS.md is absent");
});

test("a job turn warns when the cwd's AGENTS.md is over 8 KB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-anchors-"));
  writeFileSync(join(dir, "job.txt"), "do the thing");
  writeFileSync(join(dir, "AGENTS.md"), "x".repeat(8 * 1024 + 1));
  const adapter = new JobAdapter(dir);
  const reg = new Registry(new Store(join(mkdtempSync(join(tmpdir(), "orch-db-")), "t.db")));
  (reg as unknown as { build: () => Adapter }).build = () => adapter;
  const { handle } = await reg.open({ tool: "opencode", cwd: dir, roots: [dir] });

  const events: Event[] = [];
  for await (const ev of reg.send({ sessionId: handle.id, prompt: "go", job: "job.txt" })) events.push(ev);
  const warning = events.find((e) => e.t === "text.delta");
  assert.ok(warning?.t === "text.delta" && warning.text.includes("[orch]") && warning.text.includes("AGENTS.md"));
  assert.ok(adapter.lastPrompt.includes("## Job (job.txt)"));
});
