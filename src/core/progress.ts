/**
 * Evidence-based progress scoring for a session's job (plan B1).
 *
 * Pure functions over stored events so they are testable without a daemon:
 * each parsed job item is scored 0 / 0.5 / 1 from
 *  - todo evidence: the worker's todowrite calls, fuzzy-matched by token overlap >= 0.4
 *    (completed -> 1, in_progress -> 0.5),
 *  - file evidence: an edit/write/shell-write touching a file named in the item -> 0.5,
 *  - test evidence: a turn's result_text with "N passed, 0 failed" / "All tests passed"
 *    mentioning the item's test -> 1,
 *  - report evidence: the final report lists the item's file -> 0.5.
 * Session auto % = mean over items.
 */
import type { Event } from "./types.js";
import type { JobItem } from "./jobs.js";
import { extractPaths } from "./jobs.js";
import type { Store } from "./db.js";

export interface ScoredItem {
  id: string;
  text: string;
  score: number;
  evidence: string[];
}

export interface SessionProgress {
  items: ScoredItem[];
  autoPct: number;
}

const STOP = new Set([
  "the", "a", "an", "to", "of", "in", "for", "and", "or", "with", "on", "is", "are",
  "be", "it", "that", "this", "as", "at", "by", "from", "into", "when", "use",
]);

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length > 1 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** Share of the smaller token set that appears in the other (0..1). */
export function tokenOverlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "str_replace"]);
const SHELL_TOOLS = new Set(["bash", "sh"]);

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathMatches(filePath: string, file: string): boolean {
  const fp = normalize(filePath);
  const f = normalize(file);
  if (fp === f || fp.endsWith("/" + f)) return true;
  const base = f.split("/").pop()!;
  return base.length > 3 && fp.split("/").pop() === base;
}

function mentions(text: string, file: string): boolean {
  const f = normalize(file);
  if (text.includes(f)) return true;
  const base = f.split("/").pop()!;
  return base.length > 3 && text.includes(base);
}

function toolCalls(events: Event[]): Array<{ name: string; input: unknown }> {
  const out: Array<{ name: string; input: unknown }> = [];
  for (const e of events) {
    if (e.t === "tool.call") out.push({ name: e.name, input: e.input });
  }
  return out;
}

interface Todo { content: string; status: string }

function todosOf(events: Event[]): Todo[] {
  const out: Todo[] = [];
  for (const { name, input } of toolCalls(events)) {
    if (name !== "todowrite" || typeof input !== "object" || input === null) continue;
    const list = (input as { todos?: unknown }).todos;
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const o = t as { content?: unknown; status?: unknown };
      if (typeof o.content === "string" && typeof o.status === "string") {
        out.push({ content: o.content, status: o.status });
      }
    }
  }
  return out;
}

/** Paths the session wrote: edit/write inputs plus shell redirects. */
export function editedPaths(events: Event[]): string[] {
  const out: string[] = [];
  for (const { name, input } of toolCalls(events)) {
    if (EDIT_TOOLS.has(name) && typeof input === "object" && input !== null) {
      const fp = (input as { filePath?: unknown }).filePath;
      if (typeof fp === "string" && !out.includes(fp)) out.push(fp);
    } else if (SHELL_TOOLS.has(name) && typeof input === "object" && input !== null) {
      const cmd = (input as { command?: unknown }).command;
      if (typeof cmd === "string" && />\s*\S/.test(cmd)) {
        for (const p of extractPaths(cmd)) if (!out.includes(p)) out.push(p);
      }
    }
  }
  return out;
}

const TEST_OK_RE = /\b\d+\s+passed,\s*0\s+failed\b|\ball tests passed\b/i;

/**
 * Score job items from events and turn reports. `turns` is the store's turn list
 * (only resultText is used). Pure: no I/O, no store.
 */
export function scoreItems(
  items: JobItem[],
  events: Event[],
  turns: Array<{ resultText: string }>,
): SessionProgress {
  const todos = todosOf(events);
  const edits = editedPaths(events);
  const reports = turns.map((t) => t.resultText).filter((t) => t.trim().length > 0);
  const finalReport = reports.length ? reports[reports.length - 1]! : "";

  // Each todo counts for the item it best matches (>= 0.4 overlap), never for every
  // item that shares a word with it.
  const todoHits = new Map<number, Array<{ todo: Todo; score: number }>>();
  for (const todo of todos) {
    let best = -1;
    let bestOverlap = 0;
    items.forEach((item, idx) => {
      const o = tokenOverlap(item.text, todo.content);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = idx;
      }
    });
    if (best < 0 || bestOverlap < 0.4) continue;
    const score = todo.status === "completed" ? 1 : todo.status === "in_progress" ? 0.5 : 0;
    if (score === 0) continue;
    const list = todoHits.get(best) ?? [];
    list.push({ todo, score });
    todoHits.set(best, list);
  }

  const scored: ScoredItem[] = items.map((item, idx) => {
    const evidence: string[] = [];
    let score = 0;

    for (const { todo, score: s } of todoHits.get(idx) ?? []) {
      score = Math.max(score, s);
      evidence.push(`todo ${todo.status}: "${todo.content}"`);
    }

    for (const fp of edits) {
      if (!item.files.some((f) => pathMatches(fp, f))) continue;
      score = Math.max(score, 0.5);
      evidence.push(`wrote ${fp}`);
    }

    for (const rt of reports) {
      if (!TEST_OK_RE.test(rt)) continue;
      const hit = item.tests.find((t) => mentions(rt, t));
      if (!hit) continue;
      score = Math.max(score, 1);
      evidence.push(`tests pass (${hit})`);
      break;
    }

    if (finalReport) {
      const hit = item.files.find((f) => mentions(finalReport, f));
      if (hit) {
        score = Math.max(score, 0.5);
        evidence.push(`report lists ${hit}`);
      }
    }

    return { id: item.id, text: item.text, score, evidence };
  });

  const autoPct = scored.length ? scored.reduce((s, i) => s + i.score, 0) / scored.length : 0;
  return { items: scored, autoPct };
}

/** Score the job stored for this session (empty progress when the session has no job). */
export function scoreSession(store: Store, sessionId: string): SessionProgress {
  const job = store.getJob(sessionId);
  if (!job) return { items: [], autoPct: 0 };
  let items: JobItem[] = [];
  try {
    items = JSON.parse(job.items) as JobItem[];
  } catch {
    items = [];
  }
  const events = store.eventsSince(sessionId, 0, 1_000_000).map((e) => e.event);
  const turns = store.getTurns(sessionId);
  return scoreItems(items, events, turns);
}
