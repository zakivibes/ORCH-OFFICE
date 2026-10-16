import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/db.js";
import { Registry } from "../src/core/registry.js";
import { DEFAULT_LIMITS, loadLimits } from "../src/core/limits.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { Policy } from "../src/permissions/policy.js";
import { checkQuota, getQuotaStatus } from "../src/core/policy_rules.js";
import { type Adapter, type Event, type Handle } from "../src/core/types.js";

// ORCH config/quota/limits all point at a temp dir: nothing reads or writes ~/.orchestrator.
const dir = mkdtempSync(join(tmpdir(), "orch-retry-"));
const limitsFile = join(dir, "limits.json");
process.env.ORCH_LIMITS_FILE = limitsFile;
process.env.ORCH_CONFIG_FILE = join(dir, "config.json");
process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");
writeLimits({});

function writeLimits(l: Record<string, number>) {
  writeFileSync(limitsFile, JSON.stringify({ maxExploreBeforeGraph: 0, ...l }));
}

/**
 * A stand-in opencode binary: a real HTTP server speaking enough of the
 * opencode 1.19 API (/global/health, /session, SSE /event, prompt_async,
 * abort, delete) to drive OpencodeAdapter through a fake event stream.
 */
const fakeBin = join(dir, "fake-opencode.mjs");
writeFileSync(
  fakeBin,
  [
    "#!/usr/bin/env node",
    'import http from "node:http";',
    'import { appendFileSync } from "node:fs";',
    "const argv = process.argv.slice(2);",
    "const port = Number(argv[argv.indexOf('--port') + 1]);",
    "const clients = new Set();",
    "const pending = [];",
    'const stateFile = process.env.ORCH_FAKE_STATE || "";',
    "function mark(line) { if (!stateFile) return; try { appendFileSync(stateFile, line + '\\n'); } catch {} }",
    "function push(ev) {",
    '  const frame = "data: " + JSON.stringify(ev) + "\\n\\n";',
    "  if (clients.size === 0) { pending.push(frame); return; }",
    "  for (const c of clients) c.write(frame);",
    "}",
    "http.createServer((req, res) => {",
    '  const url = req.url || "";',
    '  if (req.method === "GET" && url === "/global/health") {',
    '    res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return;',
    "  }",
    '  if (req.method === "POST" && url === "/session") {',
    '    res.writeHead(200, { "content-type": "application/json" });',
    '    res.end(JSON.stringify({ id: "sess-1" })); return;',
    "  }",
    '  if (req.method === "GET" && url === "/event") {',
    '    res.writeHead(200, { "content-type": "text/event-stream" });',
    "    for (const f of pending) res.write(f);",
    "    pending.length = 0;",
    "    clients.add(res);",
    '    req.on("close", () => clients.delete(res));',
    "    return;",
    "  }",
    "  if (req.method === 'POST' && url.indexOf('/prompt_async') !== -1) {",
    '    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");',
    '    const scripted = JSON.parse(process.env.ORCH_FAKE_EVENTS || "[]");',
    "    for (const ev of scripted) push(ev);",
    "    return;",
    "  }",
    "  if (req.method === 'POST' && url.indexOf('/abort') !== -1) {",
    '    mark("ABORT");',
    '    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");',
    "    return;",
    "  }",
    "  if (req.method === 'DELETE' && url.indexOf('/delete') !== -1) {",
    "    for (const c of clients) c.end();",
    "    clients.clear();",
    '    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");',
    "    return;",
    "  }",
    '  res.writeHead(404, { "content-type": "application/json" }); res.end("{}");',
    "}).listen(port, '127.0.0.1');",
    "",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);

const retryStatus = (attempt: number, message: string) => ({
  type: "session.status",
  properties: { sessionID: "sess-1", status: { type: "retry", attempt, message, next: Date.now() + 60_000 } },
});
const idle = { type: "session.idle", properties: { sessionID: "sess-1" } };

/** Runs a turn through the real OpencodeAdapter against the fake server. */
async function runScenario(events: unknown[]): Promise<{ events: Event[]; aborted: () => Promise<boolean> }> {
  const state = join(dir, `state-${Math.random().toString(36).slice(2)}`);
  process.env.ORCH_FAKE_EVENTS = JSON.stringify(events);
  process.env.ORCH_FAKE_STATE = state;
  const adapter = new OpencodeAdapter(new Policy({ projectDir: dir, roots: [dir] }), fakeBin);
  const handle = await adapter.spawn({ cwd: dir });
  const out: Event[] = [];
  for await (const ev of adapter.send(handle, "go")) out.push(ev);
  await adapter.close(handle);
  const aborted = async (): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      if (existsSync(state) && readFileSync(state, "utf8").includes("ABORT")) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  return { events: out, aborted };
}

test("maxProviderRetries defaults to 3 and is tunable from limits.json", () => {
  assert.equal(DEFAULT_LIMITS.maxProviderRetries, 3);
  assert.equal(loadLimits().maxProviderRetries, 3);
  writeLimits({ maxProviderRetries: 5 });
  assert.equal(loadLimits().maxProviderRetries, 5);
  writeLimits({});
});

test("a retry whose message is a rate limit ends the turn with kind rate_limit and aborts the session", async () => {
  const { events, aborted } = await runScenario([retryStatus(1, "Rate limit exceeded")]);
  assert.ok(
    events.some((e) => e.t === "text.delta" && e.text === "[orch] provider retry 1: Rate limit exceeded\n"),
    "the retry was surfaced as text",
  );
  const last = events.at(-1);
  assert.ok(last?.t === "error");
  assert.equal(last?.t === "error" && last.kind, "rate_limit");
  assert.equal(last?.t === "error" && last.message, "provider rate-limited: Rate limit exceeded");
  assert.ok(!events.some((e) => e.t === "turn.completed"), "the turn did not report completion");
  assert.equal(await aborted(), true, "the opencode session was aborted");
});

test("generic retries stop at maxProviderRetries and abort the session", async () => {
  const { events, aborted } = await runScenario([
    retryStatus(1, "Connection error"),
    retryStatus(2, "Connection error"),
    retryStatus(3, "Connection error"),
  ]);
  const retries = events.filter((e) => e.t === "text.delta" && e.text.includes("[orch] provider retry"));
  assert.equal(retries.length, 3);
  const last = events.at(-1);
  assert.ok(last?.t === "error" && last.kind === "rate_limit");
  assert.equal(last?.t === "error" && last.message, "provider rate-limited: Connection error");
  assert.ok(!events.some((e) => e.t === "turn.completed"));
  assert.equal(await aborted(), true, "the opencode session was aborted");
});

test("a retry followed by success does not stop the turn", async () => {
  const { events, aborted } = await runScenario([retryStatus(1, "Connection error"), idle]);
  assert.ok(
    events.some((e) => e.t === "text.delta" && e.text.includes("[orch] provider retry 1")),
    "the retry was still surfaced",
  );
  assert.ok(!events.some((e) => e.t === "error"), "no error was emitted");
  assert.equal(events.at(-1)?.t, "turn.completed");
  assert.equal(await aborted(), false, "the session was left alive");
});

const caps = {
  persistent: true,
  permissionFidelity: "native" as const,
  interrupt: true,
  structuredOutput: false,
  costUsd: false,
  subagents: false,
};

/** The adapter's rate_limit outcome, as the registry sees it. */
class RateLimitedAdapter implements Adapter {
  readonly id = "opencode" as const;
  readonly caps = caps;
  async spawn(): Promise<Handle> {
    return { tool: "opencode", id: `s-${Math.random()}`, native: "n", cwd: dir, model: "deepseek/deepseek-v4.1-flash-free", caps };
  }
  async *send(): AsyncGenerator<Event> {
    yield { t: "text.delta", text: "[orch] provider retry 1: Rate limit exceeded\n" };
    yield { t: "error", kind: "rate_limit", message: "provider rate-limited: Rate limit exceeded" };
  }
  async interrupt() {}
  async close() {}
}

test("a rate_limit turn records the group quota even with quota on, and reaches the turn result", async () => {
  writeFileSync(
    process.env.ORCH_CONFIG_FILE!,
    JSON.stringify({ groups: [{ name: "free-pool", tool: "opencode", max: 2, quota: true }] }),
  );
  const reg = new Registry(new Store(join(mkdtempSync(join(tmpdir(), "orch-db-")), "t.db")));
  (reg as unknown as { build: () => Adapter }).build = () => new RateLimitedAdapter();
  const { handle } = await reg.open({ tool: "opencode", cwd: dir, roots: [dir] });

  const out: Event[] = [];
  for await (const ev of reg.send({ sessionId: handle.id, prompt: "go" })) out.push(ev);
  const last = out.at(-1);
  assert.ok(last?.t === "error" && last.kind === "rate_limit");
  assert.equal(last?.t === "error" && last.message, "provider rate-limited: Rate limit exceeded");

  // The quota block (registry.ts after the turn loop) ran for kind "rate_limit" with quota:true.
  assert.equal(checkQuota("free-pool").blocked, true);
  assert.match(getQuotaStatus()["free-pool"]?.reason ?? "", /provider rate-limited/);

  // The turn's result keeps the surfaced retry and is marked aborted, not silently completed.
  const turns = reg.store.getTurns(handle.id);
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.resultText, /provider retry 1: Rate limit exceeded/);
  assert.equal(turns[0]!.aborted, true);
});
