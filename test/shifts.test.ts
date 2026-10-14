import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/db.js";
import { Registry } from "../src/core/registry.js";
import { zeroUsage, type Adapter, type Event, type Handle, type Usage } from "../src/core/types.js";
import {
  loadConfig,
  getGroups,
  matchGroup,
  countLive,
  isInShiftWindow,
  nextShiftBoundary,
  shiftRefusalMessage,
  checkQuota,
  recordQuotaError,
  shiftStatus,
  __testSetNow,
  __testSetShiftCallback,
  __testTick,
  clearQuota,
  clearConfigCache,
  isQuotaError,
} from "../src/core/policy_rules.js";

const dir = mkdtempSync(join(tmpdir(), "orch-shifts-"));
const configDir = join(dir, ".orchestrator");
const configFile = join(configDir, "config.json");
// Never read or write the real ~/.orchestrator files from tests.
const noConfig = join(dir, "no-config.json");
process.env.ORCH_CONFIG_FILE = noConfig;
process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");

function writeConfig(cfg: object) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(cfg, null, 2));
  process.env.ORCH_CONFIG_FILE = configFile;
}

function clearConfig() {
  process.env.ORCH_CONFIG_FILE = noConfig;
  rmSync(configDir, { recursive: true, force: true });
  clearConfigCache();
}

const caps = {
  persistent: true,
  permissionFidelity: "native" as const,
  interrupt: true,
  structuredOutput: false,
  costUsd: false,
  subagents: false,
};

class MockAdapter implements Adapter {
  readonly id = "opencode" as const;
  readonly caps = caps;
  interrupted = 0;
  closed = 0;
  events: Event[] = [];

  constructor(private model = "test-model") {}

  async spawn(): Promise<Handle> {
    return {
      tool: "opencode",
      id: `s-${Math.random()}`,
      native: "n",
      cwd: dir,
      model: this.model,
      caps,
    };
  }

  async *send(): AsyncGenerator<Event> {
    yield { t: "turn.completed", usage: zeroUsage(), durationMs: 1, turns: 1 };
  }

  async interrupt() {
    this.interrupted += 1;
  }

  async close() {
    this.closed += 1;
  }
}

function registryWith(adapter: Adapter): Registry {
  const reg = new Registry(new Store(join(mkdtempSync(join(tmpdir(), "orch-db-")), "t.db")));
  (reg as unknown as { build: () => Adapter }).build = () => adapter;
  return reg;
}

async function openSession(reg: Registry, tool = "opencode", model = "test-model") {
  return reg.open({ tool: tool as any, cwd: dir, roots: [dir], model });
}

test("loadConfig returns empty groups when no config file", () => {
  clearConfig();
  // Set ORCH_CONFIG_FILE to a non-existent path to avoid fallback to ~/.orchestrator/config.json
  process.env.ORCH_CONFIG_FILE = join(tmpdir(), "orch-no-config-" + Math.random(), "config.json");
  const cfg = loadConfig();
  assert.deepEqual(cfg.groups, []);
  process.env.ORCH_CONFIG_FILE = noConfig;
});

test("getGroups reads groups from config file", () => {
  writeConfig({
    groups: [
      { name: "test-group", match: ["test-"], max: 2 },
    ],
  });
  const groups = getGroups();
  assert.equal(groups.length, 1);
  const g = groups[0]!;
  assert.equal(g.name, "test-group");
  assert.equal(g.max, 2);
  clearConfig();
});

test("matchGroup matches by tool and model substring", () => {
  writeConfig({
    groups: [
      { name: "group-a", tool: "agy", max: 1 },
      { name: "group-b", match: ["nvidia-"], max: 1 },
      { name: "group-c", match: ["opencode/"], max: 1 },
    ],
  });
  assert.equal(matchGroup({ tool: "agy" })?.name, "group-a");
  assert.equal(matchGroup({ tool: "opencode", model: "nvidia-model" })?.name, "group-b");
  assert.equal(matchGroup({ tool: "opencode", model: "opencode/foo" })?.name, "group-c");
  assert.equal(matchGroup({ tool: "claude", model: "unknown" }), null);
  clearConfig();
});

test("countLive counts only non-closed sessions", () => {
  const sessions = [
    { id: "1", group: "g", closedAt: null },
    { id: "2", group: "g", closedAt: Date.now() },
    { id: "3", group: "g", closedAt: null },
    { id: "4", group: "other", closedAt: null },
  ];
  assert.equal(countLive("g", sessions), 2);
  assert.equal(countLive("other", sessions), 1);
});

test("isInShiftWindow handles window not crossing midnight", () => {
  const group = { name: "test", shift: { from: "09:00", to: "17:00", tz: "UTC" }, max: 1 };
  const inside = new Date("2024-01-15T12:00:00Z");
  const outside = new Date("2024-01-15T20:00:00Z");
  assert.equal(isInShiftWindow(group, inside), true);
  assert.equal(isInShiftWindow(group, outside), false);
});

test("isInShiftWindow handles window crossing midnight", () => {
  const group = { name: "test", shift: { from: "22:00", to: "08:00", tz: "UTC" }, max: 1 };
  const insideNight = new Date("2024-01-15T23:00:00Z");
  const insideMorning = new Date("2024-01-16T06:00:00Z");
  const outside = new Date("2024-01-15T12:00:00Z");
  assert.equal(isInShiftWindow(group, insideNight), true);
  assert.equal(isInShiftWindow(group, insideMorning), true);
  assert.equal(isInShiftWindow(group, outside), false);
});

test("nextShiftBoundary returns correct boundaries", () => {
  const group = { name: "test", shift: { from: "22:00", to: "08:00", tz: "UTC" }, max: 1 };
  const now = new Date("2024-01-15T12:00:00Z");
  const b = nextShiftBoundary(group, now);
  assert.equal(b.active, false);
  assert.ok(b.startsAt instanceof Date);
  assert.ok(b.endsAt instanceof Date);
  assert.ok(b.startsAt! < b.endsAt!);
});

test("shiftRefusalMessage formats correctly", () => {
  // Set a fixed time outside the shift window (22:00-08:00 Asia/Shanghai)
  // 12:00 UTC = 20:00 Asia/Shanghai (UTC+8), which is outside 22:00-08:00
  __testSetNow(() => new Date("2024-01-15T12:00:00Z"));
  const group = { name: "alibaba", shift: { from: "22:00", to: "08:00", tz: "Asia/Shanghai" }, max: 1 };
  const msg = shiftRefusalMessage(group);
  assert.ok(msg.includes("alibaba works night shift only"));
  assert.ok(msg.includes("22:00–08:00"));
  assert.ok(msg.includes("Asia/Shanghai"));
  assert.ok(msg.includes("next start"));
  __testSetNow(() => new Date());
});

test("caps refuse the 5th session when max is 4", async () => {
  writeConfig({
    groups: [{ name: "cap-test", match: ["cap-model"], max: 4 }],
  });
  const adapter = new MockAdapter("cap-model");
  const reg = registryWith(adapter);
  for (let i = 0; i < 4; i++) {
    await openSession(reg, "opencode", "cap-model");
  }
  await assert.rejects(openSession(reg, "opencode", "cap-model"), /group cap-test is full \(4\/4 live\)/);
  clearConfig();
});

test("shift refuses outside window and allows inside with injected clock", async () => {
  writeConfig({
    groups: [{ name: "shift-test", match: ["shift-model"], max: 4, shift: { from: "22:00", to: "08:00", tz: "UTC" } }],
  });
  let now = new Date("2024-01-15T12:00:00Z"); // outside shift
  __testSetNow(() => now);
  const adapter = new MockAdapter("shift-model");
  const reg = registryWith(adapter);
  await assert.rejects(openSession(reg, "opencode", "shift-model"), /shift-test works night shift only/);

  now = new Date("2024-01-15T23:00:00Z"); // inside shift
  __testSetNow(() => now);
  const { handle } = await openSession(reg, "opencode", "shift-model");
  assert.ok(handle.id);
  clearConfig();
  __testSetNow(() => new Date());
});

test("shift-end timer closes live session after grace period with fake clock", async () => {
  const quotaDir = join(tmpdir(), "orch-quota-" + Math.random());
  process.env.ORCH_QUOTA_FILE = join(quotaDir, "quota.json");
  mkdirSync(quotaDir, { recursive: true });

  writeConfig({
    groups: [{ name: "grace-test", match: ["grace-model"], max: 4, shift: { from: "22:00", to: "08:00", tz: "UTC", graceMin: 1 } }],
  });
  let now = new Date("2024-01-15T23:00:00Z"); // inside shift
  __testSetNow(() => now);
  let closedSessionId: string | null = null;
  __testSetShiftCallback((group, sessionId) => {
    closedSessionId = sessionId;
  });
  const adapter = new MockAdapter("grace-model");
  const reg = registryWith(adapter);
  const { handle } = await openSession(reg, "opencode", "grace-model");
  const sessionId = handle.id;

  now = new Date("2024-01-16T08:00:00Z"); // shift ends
  __testSetNow(() => now);
  now = new Date("2024-01-16T08:02:00Z"); // 2 min past, grace is 1 min
  __testSetNow(() => now);

  // Trigger tick manually
  await __testTick(reg);

  // Verify session was closed
  const session = reg.store.getSession(sessionId);
  assert.ok(session);
  assert.ok(session.closedAt !== null, "session should be closed");

  // Verify the note was appended
  const events = reg.store.eventsSince(sessionId, 0);
  const shiftNote = events.find(
    (e): e is { seq: number; sessionId: string; at: number; event: { t: "text.delta"; text: string } } =>
      e.event.t === "text.delta" && e.event.text.includes("[orch shift]")
  );
  assert.ok(shiftNote, "should have appended [orch shift] note");
  assert.ok(shiftNote.event.text.includes("night shift ended"));

  process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");
  rmSync(quotaDir, { recursive: true, force: true });
  clearConfig();
  __testSetNow(() => new Date());
  __testSetShiftCallback(null);
});

test("quota error records cool-down and blocks open", async () => {
  const quotaDir = join(tmpdir(), "orch-quota-" + Math.random());
  process.env.ORCH_QUOTA_FILE = join(quotaDir, "quota.json");
  mkdirSync(quotaDir, { recursive: true });

  writeConfig({
    groups: [{ name: "quota-test", match: ["quota-model"], max: 4, quota: true }],
  });
  clearQuota("quota-test");
  const adapter = new MockAdapter("quota-model");
  const reg = registryWith(adapter);
  const { handle } = await openSession(reg, "opencode", "quota-model");
  const sessionId = handle.id;

  // Simulate a quota error at end of turn
  recordQuotaError("quota-test", "RESOURCE_EXHAUSTED: quota exceeded. Resets in 1h30m");
  const q = checkQuota("quota-test");
  assert.equal(q.blocked, true);
  assert.ok(q.message?.includes("quota-test quota not renewed until"));

  // Try to open new session - should be blocked
  await assert.rejects(openSession(reg, "opencode", "quota-model"), /quota-test quota not renewed until/);

  process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");
  rmSync(quotaDir, { recursive: true, force: true });
  clearConfig();
  clearQuota("quota-test");
});

test("no config = old behaviour (no caps, no shifts, no quota)", async () => {
  clearConfig();
  const adapter = new MockAdapter("any-model");
  const reg = registryWith(adapter);
  for (let i = 0; i < 10; i++) {
    const { handle } = await openSession(reg, "opencode", "any-model");
    assert.ok(handle.id);
  }
  // shiftStatus should return empty array
  const status = reg.shiftStatus();
  assert.deepEqual(status, []);
});

test("shiftStatus returns correct info for groups", async () => {
  const quotaDir = join(tmpdir(), "orch-quota-" + Math.random());
  process.env.ORCH_QUOTA_FILE = join(quotaDir, "quota.json");
  mkdirSync(quotaDir, { recursive: true });

  writeConfig({
    groups: [
      { name: "status-a", match: ["model-a"], max: 2 },
      { name: "status-b", match: ["model-b"], max: 3, shift: { from: "09:00", to: "17:00", tz: "UTC" } },
      { name: "status-c", match: ["model-c"], max: 1, quota: true },
    ],
  });
  clearQuota("status-c");
  let now = new Date("2024-01-15T12:00:00Z");
  __testSetNow(() => now);
  const adapter = new MockAdapter("model-a");
  const reg = registryWith(adapter);
  await openSession(reg, "opencode", "model-a");
  await openSession(reg, "opencode", "model-a");
  const status = reg.shiftStatus();
  assert.equal(status.length, 3);
  const a = status.find((s) => s.group === "status-a");
  assert.ok(a);
  assert.equal(a.live, 2);
  assert.equal(a.max, 2);
  assert.equal(a.quotaBlocked, false);
  const b = status.find((s) => s.group === "status-b");
  assert.ok(b);
  assert.equal(b.active, true); // 12:00 is within 09-17

  process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");
  rmSync(quotaDir, { recursive: true, force: true });
  clearConfig();
  clearQuota("status-c");
  __testSetNow(() => new Date());
});

test("quota cool-down uses different default hours for gemini/agy vs others", () => {
  const quotaDir = join(tmpdir(), "orch-quota-" + Math.random());
  process.env.ORCH_QUOTA_FILE = join(quotaDir, "quota.json");
  mkdirSync(quotaDir, { recursive: true });

  clearQuota("gemini");
  clearQuota("other-group");
  const now = Date.now();
  recordQuotaError("gemini", "quota exhausted");
  recordQuotaError("other-group", "quota exhausted");
  const q1 = checkQuota("gemini");
  const q2 = checkQuota("other-group");
  assert.ok(q1.until);
  assert.ok(q2.until);
  const diff1 = q1.until!.getTime() - now;
  const diff2 = q2.until!.getTime() - now;
  // gemini: 5 hours = 18_000_000 ms, other: 1 hour = 3_600_000 ms
  assert.ok(diff1 > 17_000_000 && diff1 < 19_000_000);
  assert.ok(diff2 > 3_000_000 && diff2 < 4_500_000);
  clearQuota("gemini");
  clearQuota("other-group");

  process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");
  rmSync(quotaDir, { recursive: true, force: true });
});

test("isQuotaError detects quota-related errors", () => {
  assert.equal(isQuotaError("rate limit exceeded"), true);
  assert.equal(isQuotaError("quota exhausted"), true);
  assert.equal(isQuotaError("RESOURCE_EXHAUSTED"), true);
  assert.equal(isQuotaError("usage limit reached"), true);
  assert.equal(isQuotaError("limit reached"), true);
  assert.equal(isQuotaError("insufficient credit"), true);
  assert.equal(isQuotaError("429 Too Many Requests"), true);
  assert.equal(isQuotaError("random error"), false);
  assert.equal(isQuotaError("network timeout"), false);
});

test("timezone math: Asia/Shanghai 22:00-08:00", () => {
  // 2026-10-15T00:30:00Z = 2026-10-15T08:30:00+08:00 (Asia/Shanghai) -> outside shift (after 08:00)
  const group = { name: "test", shift: { from: "22:00", to: "08:00", tz: "Asia/Shanghai" }, max: 1 };
  const now1 = new Date("2026-10-15T00:30:00Z");
  const b1 = nextShiftBoundary(group, now1);
  assert.equal(b1.active, false);
  // Next shift starts at 2026-10-15T22:00 Asia/Shanghai = 2026-10-15T14:00:00Z
  assert.ok(b1.startsAt);
  assert.equal(b1.startsAt!.toISOString(), "2026-10-15T14:00:00.000Z");

  // 2026-10-14T15:00:00Z = 2026-10-14T23:00:00+08:00 -> inside shift (after 22:00)
  const now2 = new Date("2026-10-14T15:00:00Z");
  const b2 = nextShiftBoundary(group, now2);
  assert.equal(b2.active, true);
  // Shift ends at 2026-10-15T08:00 Asia/Shanghai = 2026-10-15T00:00:00Z
  assert.ok(b2.endsAt);
  assert.equal(b2.endsAt!.toISOString(), "2026-10-15T00:00:00.000Z");
});

test("shift-end timer closes live session after grace with fake clock and writes note", async () => {
  const quotaDir = join(tmpdir(), "orch-quota-" + Math.random());
  process.env.ORCH_QUOTA_FILE = join(quotaDir, "quota.json");
  mkdirSync(quotaDir, { recursive: true });

  writeConfig({
    groups: [{ name: "grace-test", match: ["grace-model"], max: 4, shift: { from: "22:00", to: "08:00", tz: "UTC", graceMin: 1 } }],
  });
  let now = new Date("2024-01-15T23:00:00Z"); // inside shift
  __testSetNow(() => now);
  let closedSessionId: string | null = null;
  __testSetShiftCallback((group, sessionId) => {
    closedSessionId = sessionId;
  });
  const adapter = new MockAdapter("grace-model");
  const reg = registryWith(adapter);
  const { handle } = await openSession(reg, "opencode", "grace-model");
  const sessionId = handle.id;

  // Advance time to shift end (08:00 UTC)
  now = new Date("2024-01-16T08:00:00Z");
  __testSetNow(() => now);

  // Advance past grace period (1 min grace)
  now = new Date("2024-01-16T08:02:00Z");
  __testSetNow(() => now);

  // Trigger tick manually
  await __testTick(reg);

  // Verify session was closed
  const session = reg.store.getSession(sessionId);
  assert.ok(session);
  assert.ok(session.closedAt !== null, "session should be closed");

  // Verify the note was appended
  const events = reg.store.eventsSince(sessionId, 0);
  const shiftNote = events.find(
    (e): e is { seq: number; sessionId: string; at: number; event: { t: "text.delta"; text: string } } =>
      e.event.t === "text.delta" && e.event.text.includes("[orch shift]")
  );
  assert.ok(shiftNote, "should have appended [orch shift] note");
  assert.ok(shiftNote.event.text.includes("night shift ended"));

  // Cleanup
  process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");
  rmSync(quotaDir, { recursive: true, force: true });
  clearConfig();
  __testSetNow(() => new Date());
  __testSetShiftCallback(null);
});

test("quota uses ORCH_QUOTA_FILE and respects custom path", () => {
  const quotaDir = join(tmpdir(), "orch-quota-test-" + Math.random());
  const quotaFile = join(quotaDir, "custom-quota.json");
  mkdirSync(quotaDir, { recursive: true });
  process.env.ORCH_QUOTA_FILE = quotaFile;

  clearQuota("custom-quota-group");
  recordQuotaError("custom-quota-group", "quota exhausted");
  const q = checkQuota("custom-quota-group");
  assert.equal(q.blocked, true);
  assert.ok(q.until);

  // Verify file was created at custom path
  assert.ok(existsSync(quotaFile));

  // Cleanup
  process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");
  rmSync(quotaDir, { recursive: true, force: true });
  clearQuota("custom-quota-group");
});

test("parseResetIn handles various formats", () => {
  const quotaDir = join(tmpdir(), "orch-quota-" + Math.random());
  process.env.ORCH_QUOTA_FILE = join(quotaDir, "quota.json");
  mkdirSync(quotaDir, { recursive: true });

  // This tests the internal parseResetTime logic via recordQuotaError
  clearQuota("parse-test");
  recordQuotaError("parse-test", "reset at 14:30");
  let q = checkQuota("parse-test");
  assert.ok(q.until);
  const until1 = q.until!.getTime();
  assert.ok(until1 > Date.now());

  clearQuota("parse-test");
  recordQuotaError("parse-test", "retry after 30m");
  q = checkQuota("parse-test");
  assert.ok(q.until);
  const until2 = q.until!.getTime();
  assert.ok(until2 > Date.now() + 25 * 60 * 1000);
  assert.ok(until2 < Date.now() + 35 * 60 * 1000);

  clearQuota("parse-test");
  recordQuotaError("parse-test", "resets in 2h 15m");
  q = checkQuota("parse-test");
  assert.ok(q.until);
  const until3 = q.until!.getTime();
  assert.ok(until3 > Date.now() + 130 * 60 * 1000);
  assert.ok(until3 < Date.now() + 140 * 60 * 1000);

  clearQuota("parse-test");

  process.env.ORCH_QUOTA_FILE = join(dir, "quota.json");
  rmSync(quotaDir, { recursive: true, force: true });
});