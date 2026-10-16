import fs from "node:fs";
import path from "node:path";
import type { Store } from "./db.js";
import type { Event } from "./types.js";
import { parseJob } from "./jobs.js";
import { jobBasename } from "./anchors.js";
import { scoreSession } from "./progress.js";
import { EDIT_TOOLS, SHELL_WRITE, TEST_CMD, commandOf, fileOf } from "./loopGuard.js";

/**
 * Job notebook: what earlier sessions of the SAME job (same cwd, same job file) already did.
 *
 * Nothing is stored twice. Every tool call, result, error and reply is already in the events
 * table, so the notebook is derived from those events when a new session of the job starts.
 * That keeps it consistent by construction and needs no worker cooperation: a session that dies
 * mid-turn still leaves its trail.
 */
export interface SessionDigest {
  id: string;
  label: string;
  model: string;
  calls: number;
  /** Tool calls made before the first edit (null: never edited). */
  callsBeforeFirstEdit: number | null;
  edits: string[];
  /** Files read through a read/view tool (for the re-read metric). */
  reads: string[];
  shellWrites: string[];
  verifies: { cmd: string; ok: boolean | null }[];
  stops: string[];
  summary: string;
  done: string[];
}

export const START_ROUTINE =
  "## Start routine (orch)\n" +
  "1) Read the hand-off below, if there is one: do not re-explore what it already lists.\n" +
  "2) Run the job's Checks / analyzer on the files already touched to see the real state.\n" +
  "3) Take the first unchecked item. Your FIRST write must happen within 10 calls.\n" +
  "4) One item at a time; after each, print `DONE <item id>` on its own line.\n" +
  "5) Run tests in the FOREGROUND (never background a command and wait: your turn ends).\n";

const VERIFY_CMD = new RegExp(`${TEST_CMD.source}|\\bdart analyze\\b|\\bflutter analyze\\b|\\btsc\\b|npm run typecheck`);

/** Pass/fail from the text a test or analyzer printed; null when it cannot be told. */
export function verifyOutcome(output: string): boolean | null {
  const failed = /Some tests failed|\bFAILED\b|\[E\]|\berror •|\bnot ok\b|# fail [1-9]|failed=[1-9]/i.test(output);
  if (failed) return false;
  if (/All tests passed|No issues found|# fail 0|passed=\d+ failed=0/i.test(output)) return true;
  return null;
}

function flat(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(-max) : t;
}

export function digestSession(s: { id: string; label: string; model: string }, events: Event[]): SessionDigest {
  const d: SessionDigest = {
    id: s.id, label: s.label, model: s.model, calls: 0, callsBeforeFirstEdit: null,
    edits: [], reads: [], shellWrites: [], verifies: [], stops: [], summary: "", done: [],
  };
  const pending = new Map<string, string>();
  let text = "";
  for (const ev of events) {
    if (ev.t === "text.delta") {
      if (!ev.text.startsWith("[orch")) text += ev.text;
    } else if (ev.t === "tool.call") {
      d.calls += 1;
      const name = ev.name.toLowerCase();
      const cmd = commandOf(ev.input);
      let edited = false;
      if (name === "read" || name === "view" || name === "view_file") {
        const f = fileOf(ev.input);
        if (f && !d.reads.includes(f)) d.reads.push(f);
      }
      if (EDIT_TOOLS.has(name)) {
        const f = fileOf(ev.input);
        if (f) {
          if (!d.edits.includes(f)) d.edits.push(f);
          edited = true;
        }
      } else if (cmd && SHELL_WRITE.test(cmd)) {
        d.shellWrites.push(cmd.slice(0, 110));
        edited = true;
      }
      if (edited && d.callsBeforeFirstEdit === null) d.callsBeforeFirstEdit = d.calls - 1;
      if (cmd && VERIFY_CMD.test(cmd)) pending.set(ev.id, cmd.replace(/\s+/g, " ").slice(0, 140));
    } else if (ev.t === "tool.result") {
      const cmd = pending.get(ev.id);
      if (cmd !== undefined) {
        pending.delete(ev.id);
        const out = typeof ev.output === "string" ? ev.output : "";
        d.verifies.push({ cmd, ok: verifyOutcome(out) });
      }
    } else if (ev.t === "error") {
      const m = ev.message.replace(/\s+/g, " ").slice(0, 170);
      if (!d.stops.includes(m)) d.stops.push(m);
    }
  }
  for (const m of text.matchAll(/^\s*DONE[: ]+([A-Za-z0-9_.-]+)/gm)) if (!d.done.includes(m[1]!)) d.done.push(m[1]!);
  d.summary = flat(text, 700);
  return d;
}

/** Earlier sessions of the same job: same cwd and same job file name, oldest first. */
export function sessionsOfJob(store: Store, cwd: string, jobPath: string, exceptId: string) {
  const base = jobBasename(jobPath);
  // Only sessions that started BEFORE this one are its past; later ones are its future.
  const before = store.getSession(exceptId)?.createdAt ?? Infinity;
  return store
    .listSessions(true)
    .filter((s) => s.id !== exceptId && s.cwd === cwd && s.createdAt < before)
    .filter((s) => {
      const j = store.getJob(s.id);
      return !!j && jobBasename(j.path) === base;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function digestsOfJob(store: Store, cwd: string, jobPath: string, exceptId: string): SessionDigest[] {
  return sessionsOfJob(store, cwd, jobPath, exceptId).map((s) =>
    digestSession(s, store.eventsSince(s.id, 0, 1_000_000).map((e) => e.event)),
  );
}

function advice(stop: string): string {
  if (/FIRST_WRITE/.test(stop)) return "wrote nothing for too long: write sooner, read less";
  if (/CONTEXT/.test(stop)) return "context filled up: read line ranges, not whole files";
  if (/same .* call/.test(stop)) return "repeated one call: change approach after a failure";
  if (/graphify/.test(stop)) return "run one `graphify query` first";
  if (/quota|rate/i.test(stop)) return "provider quota/rate limit";
  if (/background|wait/i.test(stop)) return "ended by waiting on a background command";
  return "";
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export interface HandoffArgs {
  /** Item ids already proven done by progress scoring (merged with DONE lines). */
  extraDone?: string[];
  cwd: string;
  jobPath: string;
  jobText: string;
  sessionId: string;
  maxChars?: number;
}

export function formatHandoff(digests: SessionDigest[], a: HandoffArgs): string {
  if (!digests.length) return "";
  const max = a.maxChars ?? 3000;
  const edited = new Map<string, number>();
  for (const d of digests) for (const f of d.edits) edited.set(f, (edited.get(f) ?? 0) + 1);
  const parts: { w: number; text: string }[] = [];
  const head = `## Hand-off (auto-built from ${digests.length} earlier session${digests.length > 1 ? "s" : ""} of this job; trust it, do not re-explore)\n`;

  if (edited.size) {
    // Files an earlier session wrote and then deleted (scratch tests, debug files) are noise.
    const rows: string[] = [];
    for (const f of [...edited.keys()].slice(-40)) {
      const abs = path.isAbsolute(f) ? f : path.join(a.cwd, f);
      try {
        rows.push(`- ${f.replace(a.cwd + "/", "")} (${ago(fs.statSync(abs).mtimeMs)} ago)`);
      } catch {
        /* removed */
      }
    }
    if (rows.length) parts.push({ w: 9, text: `Files already edited (read these, then continue):\n${rows.slice(-25).join("\n")}\n` });
  }
  const lastVerify = new Map<string, boolean | null>();
  for (const d of digests) for (const v of d.verifies) lastVerify.set(v.cmd, v.ok);
  if (lastVerify.size) {
    const rows = [...lastVerify.entries()].slice(-6).map(([c, ok]) => `- ${ok === true ? "PASS" : ok === false ? "FAIL" : "?"}  ${c}`);
    parts.push({ w: 8, text: `Last verification (re-run before trusting):\n${rows.join("\n")}\n` });
  }
  const stops = new Map<string, string>();
  for (const d of digests) for (const s of d.stops) stops.set(s.slice(0, 90), advice(s));
  if (stops.size) {
    const rows = [...stops.entries()].slice(-5).map(([s, adv]) => `- ${s}${adv ? `  → ${adv}` : ""}`);
    parts.push({ w: 7, text: `What stopped earlier sessions:\n${rows.join("\n")}\n` });
  }
  const done = new Set([...digests.flatMap((d) => d.done), ...(a.extraDone ?? [])]);
  const items = parseJob(a.jobText).items;
  if (items.length) {
    const rows = items.map((it) => `- [${done.has(it.id) ? "x" : " "}] ${it.id} ${it.text.replace(/\s+/g, " ").slice(0, 90)}`);
    parts.push({ w: 10, text: `Checklist:\n${rows.join("\n")}\n` });
    const next = items.find((it) => !done.has(it.id));
    if (next) {
      const files = next.files.length ? ` (files: ${next.files.slice(0, 3).join(", ")})` : "";
      parts.push({ w: 10, text: `NEXT: ${next.id} ${next.text.replace(/\s+/g, " ").slice(0, 160)}${files}\n` });
    }
  }
  const last = digests[digests.length - 1]!;
  if (last.summary) parts.push({ w: 3, text: `Last worker words: "${last.summary}"\n` });

  // Hard cap: drop the lowest-priority parts first, keep the original order.
  const keep = new Set(parts.keys());
  const size = () => head.length + [...keep].reduce((n, i) => n + parts[i]!.text.length, 0);
  for (const i of [...parts.keys()].sort((x, y) => parts[x]!.w - parts[y]!.w)) {
    if (size() <= max) break;
    keep.delete(i);
  }
  return head + parts.filter((_, i) => keep.has(i)).map((p) => p.text).join("") + "\n";
}

export function buildHandoff(store: Store, a: HandoffArgs): string {
  const sessions = sessionsOfJob(store, a.cwd, a.jobPath, a.sessionId);
  const digests = sessions.map((s) => digestSession(s, store.eventsSince(s.id, 0, 1_000_000).map((e) => e.event)));
  const extraDone = new Set<string>(a.extraDone ?? []);
  for (const s of sessions) {
    try {
      for (const it of scoreSession(store, s.id).items) if (it.score >= 1) extraDone.add(it.id);
    } catch {
      /* scoring is a bonus */
    }
  }
  return formatHandoff(digests, { ...a, extraDone: [...extraDone] });
}

/** How many of a session's reads were files an earlier session of the job had already read. */
export function reReads(self: SessionDigest, earlier: SessionDigest[]): number {
  const seen = new Set(earlier.flatMap((d) => d.reads));
  return self.reads.filter((f) => seen.has(f)).length;
}
