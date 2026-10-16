import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.js";
import { Registry, type OpenArgs } from "./registry.js";
import { Policy, type NarrowRequest } from "../permissions/policy.js";
import type { Event, ToolId } from "./types.js";
import { scoreSession } from "./progress.js";
import { loadPrograms, savePrograms, addProgram, link, setWeight, findProgram, programPct } from "./programs.js";
import { readTokens } from "./limits.js";

const HOME = join(homedir(), ".orchestrator");
const PIDFILE = join(HOME, "daemon.json");
const LOG_DIR = join(HOME, "logs");

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: number;
  /** Build stamp, so a daemon running older code is never trusted. */
  build: string;
}

export const BUILD_ID = "0.5.2";

export function readDaemon(): DaemonInfo | null {
  try {
    if (!existsSync(PIDFILE)) return null;
    const raw = readFileSync(PIDFILE, "utf8").trim();
    if (!raw) return null;
    const info = JSON.parse(raw) as DaemonInfo;
    process.kill(info.pid, 0);
    // A daemon from an older build would silently serve stale behaviour.
    if (info.build !== BUILD_ID) return null;
    return info;
  } catch {
    return null;
  }
}

/** Stop a daemon whose build stamp no longer matches. */
export function reapStaleDaemon(): boolean {
  try {
    if (!existsSync(PIDFILE)) return false;
    const info = JSON.parse(readFileSync(PIDFILE, "utf8")) as DaemonInfo;
    if (info.build === BUILD_ID) return false;
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    clearDaemon();
    return true;
  } catch {
    return false;
  }
}

export function writeDaemon(info: DaemonInfo) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(PIDFILE, JSON.stringify(info, null, 2));
}

export function clearDaemon() {
  try {
    if (existsSync(PIDFILE)) writeFileSync(PIDFILE, "");
  } catch {
    /* best effort */
  }
}

function writeLog(sessionId: string, events: Event[]): string {
  mkdirSync(LOG_DIR, { recursive: true });
  const p = join(LOG_DIR, `${sessionId}.ndjson`);
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

import { resolveBinary } from "./bin.js";

let modelCache: { at: number; models: string[] } | null = null;

/**
 * Ask opencode which models it can actually reach. Cached briefly because the
 * call shells out and the list changes only when credentials change.
 */
async function listModels(binary = resolveBinary("opencode")): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < 300_000) return modelCache.models;
  try {
    const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
    const { stdout } = await execFileAsync(binary, ["models"], {
      shell: isBatch,
      maxBuffer: 8 * 1024 * 1024,
    });
    const models = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith(" "));
    modelCache = { at: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}

/**
 * Long-lived process that owns every live session. Both the CLI and the MCP
 * server are thin clients of this, which is what lets a session opened by
 * Claude Code be inspected from the terminal and vice versa.
 */
export const DEFAULT_PORT = Number(process.env.ORCH_PORT ?? 47811);

export async function isDaemonAlive(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean };
    return j?.ok === true;
  } catch {
    return false;
  }
}

export function startDaemon(port = DEFAULT_PORT): DaemonInfo {
  const store = new Store();
  const registry = new Registry(store);

  // Recover from an unclean exit: worktrees whose owning process is gone would
  // otherwise leak forever, since nothing else runs after a crash.
  void (async () => {
    for (const s of store.listSessions(true)) {
      if (!s.repoRoot) continue;
      try {
        const r = await registry.worktrees.sweep(s.repoRoot);
        if (r.removed.length) {
          process.stderr.write(`swept ${r.removed.length} stale worktree(s)\n`);
        }
      } catch {
        /* best effort */
      }
    }
  })();

  const server = createServer((req, res) => {
    handle(req, res, { store, registry }).catch((err) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  // Concurrent `orch open` calls can race to spawn a daemon. If one already
  // owns the port, stand down quietly instead of crashing with EADDRINUSE.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      void isDaemonAlive(port).then((alive) => {
        if (alive) {
          // Another daemon owns the port; leave its pidfile alone.
          process.stderr.write("orchestrator daemon already running\n");
          process.exit(0);
        }
        process.stderr.write(`orchestrator daemon cannot bind ${port}: ${err.message}\n`);
        process.exit(1);
      });
      return;
    }
    process.stderr.write(`orchestrator daemon error: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const info: DaemonInfo = { pid: process.pid, port, startedAt: Date.now(), build: BUILD_ID };
    writeDaemon(info);
    process.stderr.write(`orchestrator daemon listening on 127.0.0.1:${port} (pid ${process.pid})\n`);
  });

  const shutdown = async () => {
    await registry.closeAll();
    store.close();
    clearDaemon();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", clearDaemon);

  return { pid: process.pid, port, startedAt: Date.now(), build: BUILD_ID };
}

interface Ctx {
  store: Store;
  registry: Registry;
}

/** Accept a full id or any unambiguous prefix, so `orch ls` short ids work. */
function resolveId(ctx: Ctx, raw: string): string {
  if (!raw) return raw;
  if (ctx.store.getSession(raw)) return raw;
  const matches = ctx.store.listSessions(true).filter((s) => s.id.startsWith(raw));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new Error(`"${raw}" matches ${matches.length} sessions: ${matches.map((m) => m.id).join(", ")}`);
  }
  return raw;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = await readBody(req);
  if (typeof body.sessionId === "string") body.sessionId = resolveId(ctx, body.sessionId);

  switch (url.pathname) {
    case "/ping":
      return json(res, 200, { ok: true });

    case "/open": {
      const { session } = await ctx.registry.open({
        tool: String(body.tool) as ToolId,
        cwd: String(body.cwd),
        roots: (body.roots as string[]) ?? [String(body.cwd)],
        label: body.label as string | undefined,
        job: body.job as string | undefined,
        model: body.model as string | undefined,
        narrow: body.narrow as NarrowRequest | undefined,
        worktree: body.worktree === true,
      });
      if (body.prompt) {
        const events = await collectBounded(ctx, session.id, String(body.prompt), MAX_WAIT_MS);
        return json(res, 200, { session, events, log: writeLog(session.id, events) });
      }
      return json(res, 200, { session });
    }

    case "/send": {
      const sessionId = String(body.sessionId);
      const prompt = String(body.prompt ?? "");
      // waitMs bounds how long THIS CALL waits, never the turn. It used to
      // abort the turn, which SIGINTed the agent (agy then reported an empty
      // "agy ERROR:"), so any task longer than the wait was killed. Now the
      // turn keeps running here and the caller follows it with orch_stream.
      // The wait is also capped below Node fetch's 300 s headers timeout,
      // which otherwise surfaces client-side as a bare "fetch failed".
      if (running.has(sessionId)) {
        const busy: Event[] = [{ t: "error", kind: "crash", message: "session busy: a turn is still running; follow it with orch_stream" }];
        return json(res, 200, { events: busy, log: writeLog(sessionId, busy) });
      }
      const requested = Number(body.waitMs ?? 0);
      const waitMs = Math.min(requested > 0 ? requested : MAX_WAIT_MS, MAX_WAIT_MS);
      const events = await collectBounded(ctx, sessionId, prompt, waitMs, body.job as string | undefined);
      return json(res, 200, { events, log: writeLog(sessionId, events) });
    }

    case "/stream":
      return json(res, 200, { events: ctx.store.eventsSince(String(body.sessionId), Number(body.sinceSeq ?? 0)) });

    case "/list":
      return json(res, 200, { sessions: ctx.store.listSessions(body.includeClosed !== false) });

    case "/status": {
      const s = ctx.store.getSession(String(body.sessionId));
      if (!s) return json(res, 404, { error: "no such session" });
      const caps = ctx.registry.adapterFor(s.id)?.caps;
      return json(res, 200, { session: s, caps, policy: ctx.registry.policyFor(s.id)?.describe() });
    }

    case "/diff": {
      const sessionId = String(body.sessionId);
      const statOnly = body.statOnly === true;
      const d = await ctx.registry.diff(sessionId, statOnly);
      if (!d) return json(res, 200, { files: [], patch: "", note: "session has no worktree" });
      return json(res, 200, d);
    }

    case "/merge": {
      const sessionId = String(body.sessionId);
      const mode = body.mode === "merge" ? "merge" : "squash";
      const result = await ctx.registry.merge(sessionId, mode);
      return json(res, 200, { result });
    }

    case "/discard": {
      const sessionId = String(body.sessionId);
      const r = await ctx.registry.discard(sessionId, body.force === true);
      return json(res, 200, r);
    }

    /**
     * Run one prompt against several models at the same time. Model diversity
     * is the point: asking a single model twice converges on its own bias, so
     * a second opinion has to come from a different model.
     */
    case "/compare": {
      const prompt = String(body.prompt ?? "");
      const models = Array.isArray(body.models) ? (body.models as string[]) : [];
      const tool = (String(body.tool ?? "opencode") as ToolId);
      const cwd = String(body.cwd ?? process.cwd());
      const roots = (body.roots as string[]) ?? [cwd];

      const run = async (model: string) => {
        try {
          const { session } = await ctx.registry.open({ tool, cwd, roots, model, label: `cmp-${model.split("/").pop()}` });
          const events = await collect(ctx, session.id, prompt);
          const text = events
            .filter((e) => e.t === "text.delta")
            .map((e) => (e as { text: string }).text)
            .join("");
          const err = events.find((e) => e.t === "error") as { t: "error"; message: string } | undefined;
          return { model, ok: !err, text: err ? err.message : text, sessionId: session.id };
        } catch (err) {
          return {
            model,
            ok: false,
            text: err instanceof Error ? err.message : String(err),
            sessionId: "",
          };
        }
      };

      const results = await Promise.all(models.map(run));
      return json(res, 200, { results });
    }

    case "/sweep": {
      const cwd = String(body.cwd ?? process.cwd());
      const repoRoot = await ctx.registry.worktrees.repoRoot(cwd);
      if (!repoRoot) return json(res, 200, { removed: [], skipped: [], note: "not a git repository" });
      return json(res, 200, await ctx.registry.worktrees.sweep(repoRoot));
    }

    case "/interrupt":
      await ctx.registry.interrupt(String(body.sessionId));
      return json(res, 200, { ok: true });

    case "/close":
      await ctx.registry.close(String(body.sessionId));
      return json(res, 200, { ok: true });

    case "/roots":
      return json(res, 200, { policy: new Policy({ projectDir: String(body.cwd), roots: (body.roots as string[]) ?? [] }).describe() });

    case "/cost":
      return json(res, 200, { rows: ctx.store.totalsByTool() });

    case "/grade": {
      const sessionId = String(body.sessionId);
      if (!ctx.store.getSession(sessionId)) return json(res, 404, { error: "no such session" });
      const pct = Number(body.pct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return json(res, 400, { error: "pct must be 0..100" });
      ctx.store.setGrade(sessionId, pct / 100, String(body.note ?? ""));
      return json(res, 200, { ok: true, sessionId, pct });
    }

    case "/progress": {
      const sessionId = String(body.sessionId);
      if (!ctx.store.getSession(sessionId)) return json(res, 404, { error: "no such session" });
      const job = ctx.store.getJob(sessionId);
      const progress = scoreSession(ctx.store, sessionId);
      const grade = ctx.store.getGrade(sessionId);
      return json(res, 200, {
        sessionId,
        job: job ? { path: job.path } : null,
        items: progress.items,
        autoPct: progress.autoPct,
        grade: grade ? { pct: grade.pct, note: grade.note, at: grade.at } : null,
      });
    }

    case "/program": {
      const action = String(body.action ?? "show");
      const programs = loadPrograms();
      const id = String(body.id ?? "");
      try {
        if (action === "add") {
          addProgram(programs, id, String(body.name ?? id));
          savePrograms(programs);
          return json(res, 200, { ok: true, id, name: String(body.name ?? id) });
        }
        if (action === "link") {
          link(programs, id, String(body.job), String(body.sessionId));
          savePrograms(programs);
          return json(res, 200, { ok: true, id, job: String(body.job), sessionId: String(body.sessionId) });
        }
        if (action === "weight") {
          setWeight(programs, id, String(body.job), Number(body.weight));
          savePrograms(programs);
          return json(res, 200, { ok: true, id, job: String(body.job), weight: Number(body.weight) });
        }
        // show
        const pctOf = (sessionId: string): number | null => {
          const g = ctx.store.getGrade(sessionId);
          if (g) return g.pct;
          if (!ctx.store.getSession(sessionId)) return null;
          return scoreSession(ctx.store, sessionId).autoPct;
        };
        const tokensOf = (sessionId: string): number => {
          const s = ctx.store.getSession(sessionId);
          return s ? readTokens(s.totals) : 0;
        };
        if (id) {
          const program = findProgram(programs, id);
          if (!program) return json(res, 404, { error: `no program "${id}"` });
          return json(res, 200, { program, ...programPct(program, pctOf, tokensOf) });
        }
        return json(res, 200, { programs: programs.programs });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    case "/models": {
      const models = await listModels();
      const filter = typeof body.filter === "string" ? body.filter.toLowerCase() : "";
      const matched = filter ? models.filter((m) => m.toLowerCase().includes(filter)) : models;
      return json(res, 200, { models: matched, total: models.length, default: process.env.ORCH_OPENCODE_MODEL ?? "opencode/space-bunny-free" });
    }

    default:
      return json(res, 404, { error: `no route ${url.pathname}` });
  }
}

async function collect(
  ctx: Ctx,
  sessionId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const ev of ctx.registry.send({ sessionId, prompt, signal })) {
    events.push(ev);
  }
  return events;
}

/** Sessions whose turn is still running in the background. */
const running = new Set<string>();
const MAX_WAIT_MS = Number(process.env.ORCH_MAX_WAIT_MS ?? 240_000);

/**
 * Start a turn and wait at most waitMs for it. If it is still going, return
 * what has arrived so far plus a "still running" note; the turn finishes on
 * its own and its events land in the store for orch_stream.
 */
async function collectBounded(ctx: Ctx, sessionId: string, prompt: string, waitMs: number, job?: string): Promise<Event[]> {
  const events: Event[] = [];
  running.add(sessionId);
  const done = (async () => {
    try {
      for await (const ev of ctx.registry.send({ sessionId, prompt, job })) events.push(ev);
      // A FIRST_WRITE stop gets automatic follow-up turn(s) before the session is marked
      // idle again, so orch_send keeps reporting the session as busy until the nudge ends.
      await ctx.registry.autoNudge(sessionId);
    } catch (e) {
      events.push({ t: "error", kind: "crash", message: String((e as Error)?.message ?? e) });
    } finally {
      running.delete(sessionId);
    }
    return true;
  })();
  let timer: NodeJS.Timeout | undefined;
  const finished = await Promise.race([
    done,
    new Promise<false>((r) => { timer = setTimeout(() => r(false), waitMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (finished) return events;
  return [
    ...events,
    { t: "text.delta", text: `\n[orch] turn still running after ${Math.round(waitMs / 1000)} s; it continues in the daemon. Follow it with orch_stream; orch_send will answer "session busy" until it ends.\n` },
  ];
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: ServerResponse, code: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}