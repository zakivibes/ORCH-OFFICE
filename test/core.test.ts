import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue, DeltaCoalescer } from "../src/core/queue.js";
import { Store } from "../src/core/db.js";
import { readJsonLines } from "../src/adapters/ndjson.js";
import { Readable } from "node:stream";

// fixtures live in the source tree; tsc does not copy .ndjson files
const FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures");

function scratchDb(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), "orch-db-")), "t.db"));
}

test("AsyncQueue survives a consumer leaving early (the bug that killed turn 2)", async () => {
  const q = new AsyncQueue<number>();
  const producer = (async () => {
    for (const n of [1, 2, 3, 4, 5]) q.push(n);
    q.close(); // stands in for the underlying stream ending
  })();

  // First turn: consume 1..3 then bail out early.
  const first: number[] = [];
  for await (const n of q) {
    first.push(n);
    if (n === 3) break;
  }
  assert.deepEqual(first, [1, 2, 3]);

  await producer;
  // Second turn: the queue must still be open and hold the remaining items.
  const second: number[] = [];
  for await (const n of q) second.push(n);
  assert.deepEqual(second, [4, 5]);
  assert.equal(q.size, 0);
});

test("AsyncQueue yields buffered items to a late consumer", async () => {
  const q = new AsyncQueue<string>();
  q.push("a");
  q.push("b");
  q.close();
  const out: string[] = [];
  for await (const v of q) out.push(v);
  assert.deepEqual(out, ["a", "b"]);
});

test("AsyncQueue.close ends iteration", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.close();
  const out: number[] = [];
  for await (const v of q) out.push(v);
  assert.deepEqual(out, [1]);
});

test("DeltaCoalescer batches and flushes", async () => {
  const c = new DeltaCoalescer(5);
  c.push("he");
  c.push("llo");
  assert.equal(c.flush(), "hello");
  assert.equal(c.flush(), "");
});

test("DeltaCoalescer emits on the timer instead of dropping text", async () => {
  // Regression: a timed flush used to discard the buffer, so any turn lasting
  // longer than flushMs silently lost its entire reply.
  const seen: string[] = [];
  const c = new DeltaCoalescer(10, (t) => seen.push(t));
  c.push("MUSE-");
  c.push("FIXED");
  assert.equal(seen.length, 0, "nothing should be emitted synchronously");

  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, ["MUSE-FIXED"], "timed flush must deliver the text");
  assert.equal(c.flush(), "", "buffer already drained");
});

test("normalized marker round-trips through a raw queue", async () => {
  const { normalized, asNormalized } = await import("../src/core/queue.js");
  const ev = { t: "text.delta", text: "hi" } as const;
  assert.deepEqual(asNormalized(normalized(ev)), ev);
  assert.equal(asNormalized({ type: "raw" }), null);
});

test("readJsonLines parses NDJSON and keeps banners as raw text", async () => {
  const payload = ['{"a":1}', "not json at all", '{"b":2}'].join("\n") + "\n";
  const out: unknown[] = [];
  for await (const v of readJsonLines(Readable.from([payload]))) out.push(v);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { a: 1 });
  assert.deepEqual(out[1], { __raw: "not json at all" });
  assert.deepEqual(out[2], { b: 2 });
});

test("claude fixture normalizes to the documented event stream", async () => {
  const fixture = join(FIXTURES, "claude-turn.ndjson");
  const text = (await import("node:fs")).readFileSync(fixture, "utf8");
  const records = text.trim().split("\n").map((l) => JSON.parse(l));

  const types = records.map((r) => String(r.type));
  assert.ok(types.includes("system"));
  assert.ok(types.includes("assistant"));
  assert.ok(types.includes("rate_limit_event"));
  assert.ok(types.includes("result"));

  const init = records.find((r) => r.type === "system" && r.subtype === "init");
  assert.equal(init.model, "claude-haiku-5-5");
  assert.ok(Array.isArray(init.tools));
  assert.equal(typeof init.session_id, "string");

  const result = records.find((r) => r.type === "result");
  assert.equal(typeof result.total_cost_usd, "number");
  assert.equal(typeof result.duration_ms, "number");
  assert.ok("input_tokens" in result.usage);

  const toolUse = records.find((r) => r.type === "assistant");
  assert.ok(Array.isArray(toolUse.message.content));
});

test("agy fixture matches the verified init/step_update/result shape", async () => {
  const fixture = join(FIXTURES, "agy-turn.ndjson");
  const text = (await import("node:fs")).readFileSync(fixture, "utf8");
  const records = text.trim().split("\n").map((l) => JSON.parse(l));

  const init = records.find((r) => r.event === "init");
  assert.ok(init);
  assert.equal(typeof init.conversation_id, "string");
  assert.ok(Array.isArray(init.init.tools));
  assert.ok("permission_mode" in init.init);

  const steps = records.filter((r) => r.event === "step_update");
  assert.ok(steps.some((s) => s.step_update.state === "ACTIVE"));
  assert.ok(steps.some((s) => s.step_update.state === "DONE"));

  const result = records.find((r) => r.event === "result");
  assert.equal(result.result.status, "SUCCESS");
  assert.ok("input_tokens" in result.result.usage);
});

test("agy 1.3 tool steps say \"tool\" and per-step usage sums to the result", async () => {
  // Captured from agy 1.3.x running ls + view_file. The adapter relies on both facts:
  // step_type "tool" (not tool_call/tool_use) and each DONE step carrying its own usage.
  const fixture = join(FIXTURES, "agy-tool-turn.ndjson");
  const text = (await import("node:fs")).readFileSync(fixture, "utf8");
  const records = text.trim().split("\n").map((l) => JSON.parse(l));
  const done = records.filter((r) => r.event === "step_update" && r.step_update.state === "DONE").map((r) => r.step_update);

  const tools = done.filter((s) => s.step_type === "tool");
  assert.deepEqual(tools.map((s) => s.tool_name), ["run_command", "view_file"]);
  assert.equal(tools[0].tool_info.parameters.CommandLine, "ls");

  const sum = (k: string) => done.reduce((a, s) => a + Number(s.usage?.[k] ?? 0), 0);
  const result = records.find((r) => r.event === "result").result.usage;
  for (const k of ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens"]) {
    assert.equal(sum(k), result[k], k);
  }
});

test("agy: an empty failed turn reports the logged reason and its reset time", async () => {
  const { agyLastLoggedError, parseResetIn } = await import("../src/adapters/agy.js");
  const log = [
    "I1014 05:28:52.653956     258 quota_manager.go:45] doRefreshQuota: starting reload (force=true)",
    "E1014 05:28:54.276377     568 errorreport.go:224] agent executor error: generating and executing: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 47m26s.",
  ].join("\n");
  const reason = agyLastLoggedError(log, "/nonexistent");
  assert.match(reason, /RESOURCE_EXHAUSTED/);
  assert.ok(!reason.startsWith("E1014"), "the glog prefix is stripped");
  assert.equal(parseResetIn(reason), (47 * 60 + 26) * 1000);
  assert.equal(parseResetIn("Resets in 1h2m"), 62 * 60 * 1000);
  assert.equal(parseResetIn("no reset here"), undefined);
});

test("AsyncQueue.drain discards buffered items so a new turn starts clean", async () => {
  const { AsyncQueue } = await import("../src/core/queue.js");
  const q = new AsyncQueue<string>();
  q.push("stale-idle");
  q.push("stale-error");
  assert.equal(q.drain(), 2);
  assert.equal(q.size, 0);
  q.push("fresh");
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: "fresh", done: false });
});

test("store round-trips sessions, turns and events", () => {
  const store = scratchDb();
  const id = "sess-1";
  store.insertSession({
    id,
    tool: "agy",
    native: "conv-1",
    cwd: "/tmp",
    model: "m",
    label: "l",
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
    rootPid: null,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    costUsd: 0,
  });

  const turnId = store.startTurn(id, "hello");
  store.endTurn(turnId, {
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    costUsd: 0.25,
    aborted: false,
    resultText: "hi",
  });
  store.accumulate(id, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
  }, 0.25);

  store.appendEvent(id, { t: "text.delta", text: "hi" });
  store.appendEvent(id, { t: "turn.completed", usage: {
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, thinkingTokens: 0,
  }, costUsd: 0.25, durationMs: 5, turns: 1 });

  const s = store.getSession(id);
  assert.equal(s?.totals.inputTokens, 10);
  assert.equal(s?.costUsd, 0.25);

  const turns = store.getTurns(id);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.prompt, "hello");
  assert.equal(turns[0]?.aborted, false);

  const evs = store.eventsSince(id, 0);
  assert.equal(evs.length, 2);
  assert.equal(evs[1]?.event.t, "turn.completed");

  assert.equal(store.eventsSince(id, evs[1]!.seq).length, 0);
  store.close();
});

test("closed sessions are excluded when asked", () => {
  const store = scratchDb();
  store.insertSession({
    id: "live-1", tool: "claude", native: "", cwd: "/tmp", model: "m", label: "",
    createdAt: 1, updatedAt: 1, closedAt: null, rootPid: null,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
    costUsd: 0,
  });
  store.insertSession({
    id: "dead-1", tool: "claude", native: "", cwd: "/tmp", model: "m", label: "",
    createdAt: 1, updatedAt: 1, closedAt: null, rootPid: null,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
    costUsd: 0,
  });
  store.closeSession("dead-1");
  assert.equal(store.listSessions(false).length, 1);
  assert.equal(store.listSessions(true).length, 2);
  store.close();
});