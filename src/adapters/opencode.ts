import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { toOpencodePermission, workerMcpConfig } from "../permissions/translate.js";
import type { Policy } from "../permissions/policy.js";
import { AsyncQueue, DeltaCoalescer, normalized, asNormalized } from "../core/queue.js";
import { resolveBinary } from "../core/bin.js";
import {
  zeroUsage,
  addUsage,
  type Adapter,
  type AdapterCaps,
  type Event,
  type Handle,
  type SpawnOptions,
  type Usage,
} from "../core/types.js";

const CAPS: AdapterCaps = {
  persistent: true,
  permissionFidelity: "native",
  interrupt: true,
  structuredOutput: true,
  costUsd: true,
  subagents: true,
};

interface Live {
  server: ChildProcessWithoutNullStreams;
  baseUrl: string;
  sessionId: string;
  events: AsyncQueue<Record<string, unknown>>;
  stderr: string[];
  dead: boolean;
  permissions: Map<string, (r: "once" | "always" | "reject") => void>;
  lastError: string | null;
}

/**
 * opencode driven through its headless HTTP server rather than the one-shot
 * `opencode run` command.
 *
 * This is the strongest of the three surfaces: it gives real permission
 * round-trips (POST /session/:id/permissions/:permissionID), native
 * structured output via a json_schema format, and a real sub-agent tree via
 * session.create({ parentID }).
 */
export class OpencodeAdapter implements Adapter {
  readonly id = "opencode" as const;
  readonly caps = CAPS;

  private live = new Map<string, Live>();

  constructor(
    private readonly policy: Policy,
    private readonly binary = resolveBinary("opencode"),
    /**
     * Default model. opencode's own configured default is whatever the user
     * set in opencode.json, which may point at a provider with no working
     * credentials; the orchestrator pins a known-good one unless told otherwise.
     */
    private readonly defaultModel = process.env.ORCH_OPENCODE_MODEL ?? "opencode/space-bunny-free",
  ) {}

  /**
   * Ask the OS for a free port. A fixed base port collides as soon as two
   * sessions overlap, and the failing "serve" then returns a bare ServeError.
   */
  private async freePort(): Promise<number> {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close(() => reject(new Error("could not reserve a port")));
        }
      });
    });
  }

  async spawn(opts: SpawnOptions): Promise<Handle> {
    const id = randomUUID();
    const port = await this.freePort();

    // opencode reads OPENCODE_CONFIG for inline config, so the translated
    // permission block is injected without touching the user's own file.
    const mcp = workerMcpConfig();
    const inline = JSON.stringify({ ...toOpencodePermission(this.policy), ...(mcp ? { mcp } : {}), $schema: undefined });

    if (process.env.ORCH_DEBUG) {
      process.stderr.write(`[opencode cfg] ${inline}\n`);
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_CONTENT: inline };
    delete childEnv.OPENCODE_SERVER_PASSWORD;
    delete childEnv.OPENCODE_SERVER_USERNAME;

    const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.binary);
    const server = spawn(this.binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isBatch,
      env: childEnv,
    }) as ChildProcessWithoutNullStreams;

    const baseUrl = `http://127.0.0.1:${port}`;
    const entry: Live = {
      server,
      baseUrl,
      sessionId: "",
      events: new AsyncQueue<Record<string, unknown>>(),
      stderr: [],
      dead: false,
      permissions: new Map(),
      lastError: null,
    };
    this.live.set(id, entry);

    server.stderr.setEncoding("utf8");
    server.stderr.on("data", (c: string) => entry.stderr.push(c));
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (c: string) => entry.stderr.push(c));
    server.on("exit", () => {
      entry.dead = true;
      entry.events.close();
    });

    await this.waitHealthy(entry);

    const created = await this.post<{ id: string }>(entry, "/session", {
      body: JSON.stringify({ title: opts.model ? `orch:${opts.model}` : "orch" }),
    });
    entry.sessionId = created?.id ?? "";
    if (!entry.sessionId) {
      const detail = entry.lastError ?? entry.stderr.join("").slice(0, 400);
      throw new Error(`opencode session creation failed: ${detail || "no session id returned"}`);
    }

    void this.pumpEvents(entry);

    return {
      tool: "opencode",
      id,
      native: entry.sessionId,
      cwd: opts.cwd,
      model: opts.model ?? this.defaultModel,
      caps: CAPS,
    };
  }

  private async waitHealthy(entry: Live, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (entry.dead) throw new Error(`opencode server exited: ${entry.stderr.join("")}`);
      try {
        const r = await fetch(`${entry.baseUrl}/global/health`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`opencode server did not become healthy: ${entry.stderr.join("")}`);
  }

  private async pumpEvents(entry: Live) {
    try {
      // No AbortSignal here on purpose: this stream must stay open for the
      // life of the session. AbortSignal.timeout(0) would abort immediately.
      const res = await fetch(`${entry.baseUrl}/event`, {
        headers: { accept: "text/event-stream" },
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const parsed = JSON.parse(line.slice(5).trim());
              if (parsed && typeof parsed === "object") entry.events.push(parsed as Record<string, unknown>);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
      entry.lastError = "event stream ended by server";
    } catch (err) {
      entry.lastError = `event stream: ${err instanceof Error ? err.message : String(err)}`;
      entry.events.close();
    }
  }

  private async post<T>(entry: Live, path: string, init: RequestInit = {}): Promise<T | null> {
    try {
      const r = await fetch(`${entry.baseUrl}${path}`, {
        method: "POST",
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
      if (r.status === 204) return null;
      const text = await r.text();
      if (!r.ok) {
        entry.lastError = `${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`;
        return null;
      }
      return (text ? JSON.parse(text) : null) as T;
    } catch (err) {
      entry.lastError = `${path} -> ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
  }

  async *send(handle: Handle, prompt: string, signal?: AbortSignal): AsyncGenerator<Event> {
    const entry = this.live.get(handle.id);
    if (!entry) {
      yield { t: "error", kind: "crash", message: `unknown opencode session ${handle.id}` };
      return;
    }

    const onAbort = () => {
      void this.interrupt(handle);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const coalescer = new DeltaCoalescer(40, (t) => entry.events.push(normalized({ t: "text.delta", text: t })));
    let usage: Usage = zeroUsage();
    // opencode records one assistant message per step (each tool round-trip), and
    // message.updated carries that message's own totals. Keep the latest figures
    // per message and sum them; overwriting kept only the last step of the turn.
    const perMessage = new Map<string, { usage: Usage; cost: number }>();
    let lastProgressAt = 0;
    const assistantIds = new Set<string>();
    // opencode sends the *cumulative* text of a part on each update, so we
    // remember what we already emitted per message and send only the suffix.
    const emitted = new Map<string, string>();
    // opencode re-sends a tool part on every state change (pending -> running -> completed), so one
    // call arrives several times. Report it once, when its input is known, or the turn's step count
    // (and the maxTurnSteps budget) triples.
    const toolCallsSeen = new Set<string>();
    const startedAt = Date.now();
    let costUsd = 0;
    let turns = 0;

    // opencode requires model as an object; a "provider/model" string is a 400.
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: prompt }],
    };
    if (handle.model && handle.model !== "default") {
      const slash = handle.model.indexOf("/");
      if (slash > 0) {
        body.model = {
          providerID: handle.model.slice(0, slash),
          modelID: handle.model.slice(slash + 1),
        };
      }
    }

    // The event queue is shared across turns. A turn that ended on an error or an abort can
    // leave its trailing events (session.idle, session.error) buffered; the next turn would read
    // that stale idle first and "complete" instantly with nothing done. Discard the leftovers.
    entry.events.drain();
    let sawActivity = false;

    // prompt_async so the SSE stream carries progress; we end on message.completed.
    void this.post(entry, `/session/${entry.sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    try {
      for await (const ev of entry.events) {
        const marker = asNormalized<Event>(ev);
        if (marker) { yield marker; continue; }
        const type = String(ev.type ?? "");
        const props = (ev.properties ?? {}) as Record<string, unknown>;

        if (type === "message.updated" || type === "message.part.updated" || type === "message.part.delta") {
          sawActivity = true;
        }

        if (type === "message.part.updated" || type === "message.part.delta") {
          const part = (props.part ?? props.delta ?? {}) as Record<string, unknown>;
          const ptype = String(part.type ?? "");
          const partMessageId = String(part.messageID ?? "");
          if (ptype === "text" && typeof part.text === "string") {
            // The user's prompt is echoed back as a text part belonging to a
            // non-assistant message; never stream those.
            if (!assistantIds.has(partMessageId)) continue;
            const full = part.text;
            const prev = emitted.get(partMessageId) ?? "";
            if (full === prev) continue;
            const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
            emitted.set(partMessageId, full);
            if (delta) coalescer.push(delta);
            continue;
          }
          if (ptype === "tool" || ptype === "tool-invocation") {
            const callId = String(part.callID ?? part.id ?? "");
            const state = part.state as { status?: string; input?: unknown } | undefined;
            const input = state?.input ?? (part.input as unknown) ?? {};
            const known = input && typeof input === "object" && Object.keys(input).length > 0;
            if (callId && toolCallsSeen.has(callId)) continue;
            if (state?.status === "pending" && !known) continue;
            if (callId) toolCallsSeen.add(callId);
            const flushed = coalescer.flush();
            if (flushed) yield { t: "text.delta", text: flushed };
            yield {
              t: "tool.call",
              id: callId,
              name: String(part.tool ?? part.name ?? "tool"),
              input,
            };
            continue;
          }
          continue;
        }

        if (type === "permission.requested" || type === "session.permission") {
          const permId = String(props.permissionID ?? props.id ?? "");
          const allowed = this.policy.decide(String(props.title ?? "bash"), JSON.stringify(props.input ?? {})).action;
          const decision = allowed === "allow" ? "once" : allowed === "deny" ? "reject" : null;
          if (decision) {
            await this.post(entry, `/session/${entry.sessionId}/permissions/${permId}`, {
              method: "POST",
              body: JSON.stringify({ response: decision }),
            });
            yield {
              t: "permission.request",
              id: permId,
              tool: String(props.title ?? "unknown"),
              input: props.input ?? {},
            };
          }
          continue;
        }

        if (type === "message.updated" || type === "message.completed") {
          const info = (props.info ?? {}) as Record<string, unknown>;
          if (String(info.role ?? "") === "assistant" && info.id) {
            assistantIds.add(String(info.id));
          }
          const u = (info.tokens ?? info.usage ?? {}) as Record<string, unknown>;
          if (String(info.role ?? "") === "assistant" && info.id && Object.keys(u).length) {
            const cache = (u.cache ?? {}) as { read?: number; write?: number };
            perMessage.set(String(info.id), {
              usage: {
                inputTokens: Number(u.input ?? 0),
                outputTokens: Number(u.output ?? 0),
                cacheReadTokens: Number(cache.read ?? 0),
                cacheWriteTokens: Number(cache.write ?? 0),
                thinkingTokens: Number(u.reasoning ?? 0),
              },
              cost: typeof info.cost === "number" ? info.cost : 0,
            });
            usage = [...perMessage.values()].reduce((acc, m) => addUsage(acc, m.usage), zeroUsage());
            costUsd = [...perMessage.values()].reduce((acc, m) => acc + m.cost, 0);
            // Throttled running total so the registry can enforce token budgets mid-turn.
            if (Date.now() - lastProgressAt > 5000) {
              lastProgressAt = Date.now();
              yield { t: "usage.progress", usage };
            }
          }
          continue;
        }

        if (type === "session.error" || type === "message.error") {
          const flushed = coalescer.flush();
          if (flushed) yield { t: "text.delta", text: flushed };
          yield { t: "error", kind: "api", message: JSON.stringify(props).slice(0, 500) };
          return;
        }

        if ((type === "session.idle" || type === "message.completed.idle") && !sawActivity && Date.now() - startedAt < 3000) {
          // A late idle from the previous turn, arriving before this turn did anything: ignore.
          continue;
        }
        if (type === "session.idle" || type === "message.completed.idle") {
          const flushed = coalescer.flush();
          if (flushed) yield { t: "text.delta", text: flushed };
          turns += 1;
          yield { t: "turn.completed", usage, costUsd, durationMs: Date.now() - startedAt, turns };
          return;
        }
      }

      yield {
        t: "error",
        kind: "crash",
        message:
          "opencode event stream closed" +
          (entry.lastError ? ` (${entry.lastError})` : "") +
          (entry.stderr.length ? ` [server: ${entry.stderr.join("").slice(-1200)}]` : ""),
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async interrupt(handle: Handle): Promise<void> {
    const entry = this.live.get(handle.id);
    if (entry) await this.post(entry, `/session/${entry.sessionId}/abort`, { method: "POST" });
  }

  async close(handle: Handle): Promise<void> {
    const entry = this.live.get(handle.id);
    if (!entry) return;
    await this.post(entry, `/session/${entry.sessionId}/delete`, { method: "DELETE" });
    entry.events.close();
    if (!entry.server.killed) entry.server.kill("SIGTERM");
    this.live.delete(handle.id);
  }

  stderrOf(id: string): string {
    return (this.live.get(id)?.stderr ?? []).join("");
  }

  rootPid(id: string): number | null {
    return this.live.get(id)?.server.pid ?? null;
  }

  baseUrlOf(id: string): string | null {
    return this.live.get(id)?.baseUrl ?? null;
  }
}