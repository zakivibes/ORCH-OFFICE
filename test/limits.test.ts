import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/db.js";
import { Registry } from "../src/core/registry.js";
import { DEFAULT_LIMITS, loadLimits } from "../src/core/limits.js";
import { zeroUsage, type Adapter, type Event, type Handle, type Usage } from "../src/core/types.js";

const dir = mkdtempSync(join(tmpdir(), "orch-limits-"));
const limitsFile = join(dir, "limits.json");
process.env.ORCH_LIMITS_FILE = limitsFile;
// Keep the real ~/.orchestrator config (groups, caps, shifts) and quota file out of these tests.
process.env.ORCH_CONFIG_FILE = join(dir, "no-config.json");
process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");

function setLimits(l: Record<string, number>) {
  // The graph-first rule is tested on its own; elsewhere it would trip first on the scripted reads.
  writeFileSync(limitsFile, JSON.stringify({ maxExploreBeforeGraph: 0, ...l }));
}

const caps = {
  persistent: true,
  permissionFidelity: "native" as const,
  interrupt: true,
  structuredOutput: false,
  costUsd: false,
  subagents: false,
};

/** An agent that calls tools forever (or until told to stop), reporting usage as it goes. */
class LoopingAdapter implements Adapter {
  readonly id = "opencode" as const;
  readonly caps = caps;
  interrupted = 0;
  constructor(private perStep: Usage = zeroUsage(), private finishAfter = Infinity) {}
  async spawn(): Promise<Handle> {
    return { tool: "opencode", id: `s-${Math.random()}`, native: "n", cwd: dir, model: "fake", caps };
  }
  async *send(): AsyncGenerator<Event> {
    let total = zeroUsage();
    for (let i = 0; i < 10_000; i++) {
      if (this.interrupted) return;
      if (i >= this.finishAfter) {
        yield { t: "turn.completed", usage: total, durationMs: 1, turns: 1 };
        return;
      }
      yield { t: "tool.call", id: String(i), name: "read", input: {} };
      total = {
        ...total,
        inputTokens: total.inputTokens + this.perStep.inputTokens,
        cacheReadTokens: total.cacheReadTokens + this.perStep.cacheReadTokens,
      };
      yield { t: "usage.progress", usage: total };
    }
  }
  async interrupt() {
    this.interrupted += 1;
  }
  async close() {}
}

function registryWith(adapter: Adapter): Registry {
  const reg = new Registry(new Store(join(mkdtempSync(join(tmpdir(), "orch-db-")), "t.db")));
  (reg as unknown as { build: () => Adapter }).build = () => adapter;
  return reg;
}

async function run(reg: Registry, sessionId: string): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of reg.send({ sessionId, prompt: "go" })) out.push(ev);
  return out;
}

test("limits fall back to defaults and accept overrides from the file", () => {
  writeFileSync(limitsFile, "{}");
  assert.deepEqual(loadLimits(), DEFAULT_LIMITS);
  setLimits({ maxTurnSteps: 7, maxSessionReadTokens: 0 });
  const l = loadLimits();
  assert.equal(l.maxTurnSteps, 7);
  assert.equal(l.maxSessionReadTokens, 0);
});

test("a per-model override replaces only the keys it names", () => {
  setLimits({
    maxTurnSteps: 9,
    maxSessionReadTokens: 500,
    overrides: [{ match: "nvidia-", maxSessionReadTokens: 0 }],
  } as unknown as Record<string, number>);
  assert.equal(loadLimits("nvidia-a/nvidia/nemotron-3-super").maxSessionReadTokens, 0);
  assert.equal(loadLimits("nvidia-a/nvidia/nemotron-3-super").maxTurnSteps, 9);
  assert.equal(loadLimits("gemini-3.8-flash-high").maxSessionReadTokens, 500);
});

test("a looping turn is stopped at maxTurnSteps and the agent is interrupted", async () => {
  setLimits({ maxTurnSteps: 5, maxSessionReadTokens: 0 });
  const adapter = new LoopingAdapter();
  const reg = registryWith(adapter);
  const { handle } = await reg.open({ tool: "opencode", cwd: dir, roots: [dir] });
  const events = await run(reg, handle.id);
  const stop = events.at(-1);
  assert.equal(stop?.t, "error");
  assert.equal(stop?.t === "error" && stop.kind, "budget");
  assert.equal(events.filter((e) => e.t === "tool.call").length, 6);
  assert.equal(adapter.interrupted, 1);
});

test("a stopped turn still counts its tokens, and the session budget then refuses new turns", async () => {
  setLimits({ maxTurnSteps: 0, maxSessionReadTokens: 1000 });
  const adapter = new LoopingAdapter({ ...zeroUsage(), inputTokens: 100, cacheReadTokens: 200 });
  const reg = registryWith(adapter);
  const { handle } = await reg.open({ tool: "opencode", cwd: dir, roots: [dir] });

  const first = await run(reg, handle.id);
  const stop = first.at(-1);
  assert.ok(stop?.t === "error" && stop.kind === "budget" && /session budget/.test(stop.message));
  const totals = reg.store.getSession(handle.id)!.totals;
  assert.ok(totals.inputTokens + totals.cacheReadTokens > 1000, "the stopped turn's usage was recorded");

  adapter.interrupted = 0;
  const second = await run(reg, handle.id);
  assert.equal(second.length, 1, "refused before the agent is even asked");
  const refused = second[0];
  assert.ok(refused?.t === "error" && refused.kind === "budget");
});

test("a normal turn under the limits is untouched", async () => {
  setLimits({ maxTurnSteps: 50, maxSessionReadTokens: 1_000_000 });
  const adapter = new LoopingAdapter({ ...zeroUsage(), inputTokens: 10 }, 3);
  const reg = registryWith(adapter);
  const { handle } = await reg.open({ tool: "opencode", cwd: dir, roots: [dir] });
  const events = await run(reg, handle.id);
  assert.equal(events.at(-1)?.t, "turn.completed");
  assert.equal(adapter.interrupted, 0);
  assert.ok(!events.some((e) => e.t === "error"));
});

test("workerMcp in config.json disables and adds MCP servers for opencode workers", async () => {
  const { workerMcpConfig } = await import("../src/permissions/translate.js");
  const home = mkdtempSync(join(tmpdir(), "orch-home-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.equal(workerMcpConfig(), undefined, "no config file: nothing changes");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".orchestrator"));
    writeFileSync(
      join(home, ".orchestrator", "config.json"),
      JSON.stringify({ workerMcp: { disable: ["Blender"], add: { graphify: { type: "local", command: ["graphify-mcp"] } } } }),
    );
    assert.deepEqual(workerMcpConfig(), {
      Blender: { enabled: false },
      graphify: { enabled: true, type: "local", command: ["graphify-mcp"] },
    });
  } finally {
    process.env.HOME = prevHome;
    if (prevProfile !== undefined) process.env.USERPROFILE = prevProfile;
    else delete process.env.USERPROFILE;
  }
});

test("workerEnv in config.json passes only well-formed variables to opencode workers", async () => {
  const { workerEnvConfig } = await import("../src/permissions/translate.js");
  const home = mkdtempSync(join(tmpdir(), "orch-home-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.deepEqual(workerEnvConfig(), {}, "no config file: nothing added");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".orchestrator"));
    writeFileSync(
      join(home, ".orchestrator", "config.json"),
      JSON.stringify({ workerEnv: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1", N: 2, "bad key": "x", OBJ: {} } }),
    );
    assert.deepEqual(workerEnvConfig(), { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1", N: "2" });
  } finally {
    process.env.HOME = prevHome;
    if (prevProfile !== undefined) process.env.USERPROFILE = prevProfile;
    else delete process.env.USERPROFILE;
  }
});

/** Plays back a fixed list of tool calls, then completes. */
class ScriptAdapter implements Adapter {
  readonly id = "opencode" as const;
  readonly caps = caps;
  interrupted = 0;
  constructor(private calls: { name: string; input: Record<string, unknown> }[]) {}
  async spawn(): Promise<Handle> {
    return { tool: "opencode", id: `s-${Math.random()}`, native: "n", cwd: dir, model: "fake", caps };
  }
  async *send(): AsyncGenerator<Event> {
    for (const [i, c] of this.calls.entries()) {
      if (this.interrupted) return;
      yield { t: "tool.call", id: String(i), name: c.name, input: c.input };
    }
    yield { t: "turn.completed", usage: zeroUsage(), durationMs: 1, turns: 1 };
  }
  async interrupt() {
    this.interrupted += 1;
  }
  async close() {}
}

async function runScript(calls: { name: string; input: Record<string, unknown> }[]) {
  const adapter = new ScriptAdapter(calls);
  const reg = registryWith(adapter);
  const { handle } = await reg.open({ tool: "opencode", cwd: dir, roots: [dir] });
  return { events: await run(reg, handle.id), adapter };
}

test("the same call repeated past maxRepeatCalls is stopped", async () => {
  setLimits({ maxTurnSteps: 0, maxSessionReadTokens: 0, maxRepeatCalls: 3 });
  const same = { name: "bash", input: { command: "grep -n foo x.dart", description: "varies" } };
  const { events, adapter } = await runScript(Array(10).fill(same));
  const stop = events.at(-1);
  assert.ok(stop?.t === "error" && stop.kind === "budget" && /same bash call was made 4 times/.test(stop.message));
  assert.equal(adapter.interrupted, 1);
});

test("re-running tests past maxTestRuns is stopped with a report-instead hint", async () => {
  setLimits({ maxTurnSteps: 0, maxSessionReadTokens: 0, maxTestRuns: 3, maxRepeatCalls: 0 });
  const calls = Array.from({ length: 8 }, (_, i) => ({
    name: "bash",
    input: { command: `cd backend && node tests/a_${i}.test.js` },
  }));
  const { events } = await runScript(calls);
  const stop = events.at(-1);
  assert.ok(stop?.t === "error" && /tests were re-run 4 times/.test(stop.message) && /Report the failing test/.test(stop.message));
});

test("fix-then-run cycles do not count as test retries", async () => {
  setLimits({ maxTurnSteps: 0, maxSessionReadTokens: 0, maxTestRuns: 2, maxRepeatCalls: 0 });
  // A script that edits the test file and runs it, ten times: each run follows a change.
  const calls = Array.from({ length: 10 }, (_, i) => ({
    name: "bash",
    input: { command: `cd backend && python3 - <<'EOF'\nopen('tests/a.test.js','w').write('${i}')\nEOF\nnode tests/a.test.js` },
  }));
  const { events } = await runScript(calls);
  assert.equal(events.at(-1)?.t, "turn.completed");
});

test("reading one file past maxSameFileReads is stopped", async () => {
  setLimits({ maxTurnSteps: 0, maxSessionReadTokens: 0, maxSameFileReads: 2 });
  const calls = Array.from({ length: 5 }, (_, i) => ({ name: "read", input: { filePath: "/big.js", offset: i * 50 } }));
  const { events } = await runScript(calls);
  const stop = events.at(-1);
  assert.ok(stop?.t === "error" && /\/big\.js was read 3 times/.test(stop.message));
});

test("a turn still editing may run past maxTurnSteps up to the hard ceiling", async () => {
  setLimits({ maxTurnSteps: 10, maxSessionReadTokens: 0, stepGraceAfterEdit: 5, hardStepMultiplier: 2 });
  // An edit every 4 calls: never more than 5 calls since the last edit.
  const calls = Array.from({ length: 30 }, (_, i) =>
    i % 4 === 0 ? { name: "edit", input: { filePath: `/f${i}.ts` } } : { name: "grep", input: { pattern: `p${i}` } },
  );
  const { events } = await runScript(calls);
  const stop = events.at(-1);
  assert.ok(stop?.t === "error" && /turn stopped after 21 tool calls/.test(stop.message) && /hard ceiling 20/.test(stop.message));
});

test("past maxTurnSteps with no recent edit the turn is stopped", async () => {
  setLimits({ maxTurnSteps: 10, maxSessionReadTokens: 0, stepGraceAfterEdit: 3, hardStepMultiplier: 3 });
  const calls = [
    { name: "edit", input: { filePath: "/a.ts" } },
    ...Array.from({ length: 20 }, (_, i) => ({ name: "grep", input: { pattern: `q${i}` } })),
  ];
  const { events } = await runScript(calls);
  const stop = events.at(-1);
  assert.ok(stop?.t === "error" && /turn stopped after 11 tool calls/.test(stop.message) && /no file edited/.test(stop.message));
});

test("exploring past maxExploreBeforeGraph without a graphify call is stopped", async () => {
  setLimits({ maxTurnSteps: 0, maxSessionReadTokens: 0, maxExploreBeforeGraph: 3 });
  const calls = Array.from({ length: 6 }, (_, i) => ({ name: "bash", input: { command: `rtk grep -n 'x${i}' lib` } }));
  const { events } = await runScript(calls);
  const stop = events.at(-1);
  assert.ok(stop?.t === "error" && /4 grep\/read calls before any graphify call/.test(stop.message) && /graphify explain/.test(stop.message));
});

test("after a graphify call, grep and reads are free again", async () => {
  setLimits({ maxTurnSteps: 0, maxSessionReadTokens: 0, maxExploreBeforeGraph: 2 });
  const calls = [
    { name: "bash", input: { command: "cd /repo && graphify explain \"giftController.js::.send()\"" } },
    ...Array.from({ length: 10 }, (_, i) => ({ name: "read", input: { filePath: `/f${i}.js` } })),
  ];
  const { events } = await runScript(calls);
  assert.equal(events.at(-1)?.t, "turn.completed");
});

test("the graph-first rule is satisfied once per session, not every turn", async () => {
  setLimits({ maxTurnSteps: 0, maxSessionReadTokens: 0, maxExploreBeforeGraph: 2 });
  let turn = 0;
  const adapter = new ScriptAdapter([]);
  (adapter as unknown as { send: () => AsyncGenerator<Event> }).send = async function* () {
    turn += 1;
    if (turn === 1) yield { t: "tool.call", id: "g", name: "bash", input: { command: "graphify query \"x\"" } };
    for (let i = 0; i < 5; i++) yield { t: "tool.call", id: `${turn}-${i}`, name: "read", input: { filePath: `/t${turn}/${i}.js` } };
    yield { t: "turn.completed", usage: zeroUsage(), durationMs: 1, turns: 1 };
  };
  const reg = registryWith(adapter);
  const { handle } = await reg.open({ tool: "opencode", cwd: dir, roots: [dir] });
  assert.equal((await run(reg, handle.id)).at(-1)?.t, "turn.completed");
  assert.equal((await run(reg, handle.id)).at(-1)?.t, "turn.completed", "second turn needs no new graphify call");
});
