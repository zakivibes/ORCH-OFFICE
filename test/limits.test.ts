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

function setLimits(l: Record<string, number>) {
  writeFileSync(limitsFile, JSON.stringify(l));
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
  setLimits({});
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
  const prev = process.env.HOME;
  process.env.HOME = home;
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
    process.env.HOME = prev;
  }
});

test("workerEnv in config.json passes only well-formed variables to opencode workers", async () => {
  const { workerEnvConfig } = await import("../src/permissions/translate.js");
  const home = mkdtempSync(join(tmpdir(), "orch-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
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
    process.env.HOME = prev;
  }
});
