import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDaemon, reapStaleDaemon, isDaemonAlive, DEFAULT_PORT } from "./daemon.js";
import type { Event } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface OpenResult {
  session: {
    id: string;
    tool: string;
    native: string;
    cwd: string;
    model: string;
    label: string;
    createdAt: number;
    updatedAt: number;
    closedAt: number | null;
    totals: Record<string, number>;
    costUsd: number;
    worktreePath: string | null;
    worktreeBranch: string | null;
  };
  events?: Event[];
  log?: string;
}

/**
 * Thin client for the orchestrator daemon. Both the CLI and the MCP server use
 * this so a session opened by Claude Code is visible from the terminal, and
 * vice versa.
 */
export class DaemonClient {
  async ensure(): Promise<number> {
    const existing = readDaemon();
    if (existing) return existing.port;
    // Either no daemon, or one running a different build. Drop the old one.
    reapStaleDaemon();

    const child = spawn(process.execPath, [join(HERE, "daemon-entry.js")], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const now = readDaemon();
      if (now) return now.port;
      // A concurrent starter may have won the race and its pidfile may not
      // have landed yet; the port answering /ping is the real signal.
      if (await isDaemonAlive()) return DEFAULT_PORT;
    }
    throw new Error("orchestrator daemon failed to start");
  }

  async call<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
    const port = await this.ensure();
    const r = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!r.ok) throw new Error(String(json.error ?? `daemon returned ${r.status}`));
    return json as T;
  }

  open(body: Record<string, unknown>) {
    return this.call<OpenResult>("/open", body);
  }
  send(body: Record<string, unknown>) {
    return this.call<{ events: Event[]; log: string }>("/send", body);
  }
  stream(body: Record<string, unknown>) {
    return this.call<{ events: Array<{ seq: number; event: Event }> }>("/stream", body);
  }
  list(body: Record<string, unknown> = {}) {
    return this.call<{ sessions: OpenResult["session"][] }>("/list", body);
  }
  status(body: Record<string, unknown>) {
    return this.call<{ session: OpenResult["session"]; caps: unknown; policy: string }>("/status", body);
  }
  roots(body: Record<string, unknown>) {
    return this.call<{ policy: string }>("/roots", body);
  }
  cost() {
    return this.call<{ rows: unknown[] }>("/cost");
  }
  models(body: Record<string, unknown> = {}) {
    return this.call<{ models: string[]; total: number; default: string }>("/models", body);
  }
  diff(body: Record<string, unknown>) {
    return this.call<{ files: string[]; patch: string; note?: string }>("/diff", body);
  }
  merge(body: Record<string, unknown>) {
    return this.call<{ result: string }>("/merge", body);
  }
  discard(body: Record<string, unknown>) {
    return this.call<{ removed: boolean; reason?: string }>("/discard", body);
  }
  sweep(body: Record<string, unknown>) {
    return this.call<{ removed: string[]; skipped: string[]; note?: string }>("/sweep", body);
  }
  interrupt(body: Record<string, unknown>) {
    return this.call("/interrupt", body);
  }
  close(body: Record<string, unknown>) {
    return this.call("/close", body);
  }
  grade(body: Record<string, unknown>) {
    return this.call<{ ok: boolean; sessionId: string; pct: number }>("/grade", body);
  }
  progress(body: Record<string, unknown>) {
    return this.call<{
      sessionId: string;
      job: { path: string } | null;
      items: Array<{ id: string; text: string; score: number; evidence: string[] }>;
      autoPct: number;
      grade: { pct: number; note: string; at: number } | null;
    }>("/progress", body);
  }
  program(body: Record<string, unknown>) {
    return this.call<Record<string, unknown>>("/program", body);
  }
}