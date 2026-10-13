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

export const BUILD_ID = "0.3.2";

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

let modelCache: { at: number; models: string[] } | null = null;

/**
 * Ask opencode which models it can actually reach. Cached briefly because the
 * call shells out and the list changes only when credentials change.
 */
async function listModels(binary = "opencode"): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < 300_000) return modelCache.models;
  try {
    const { stdout } = await execFileAsync(binary, ["models"], { maxBuffer: 8 * 1024 * 1024 });
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
        model: body.model as string | undefined,
        narrow: body.narrow as NarrowRequest | undefined,
      });
      if (body.prompt) {
        const events = await collect(ctx, session.id, String(body.prompt));
        return json(res, 200, { session, events, log: writeLog(session.id, events) });
      }
      return json(res, 200, { session });
    }

    case "/send": {
      const sessionId = String(body.sessionId);
      const prompt = String(body.prompt ?? "");
      const ac = new AbortController();
      const waitMs = Number(body.waitMs ?? 0);
      if (waitMs > 0) setTimeout(() => ac.abort(), waitMs).unref?.();

      const events = await collect(ctx, sessionId, prompt, ac.signal);
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