import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { toClaudeFlags } from "../permissions/translate.js";
import type { Policy } from "../permissions/policy.js";
import { readJsonLines, drain } from "./ndjson.js";
import { AsyncQueue, DeltaCoalescer, normalized, asNormalized } from "../core/queue.js";
import {
  zeroUsage,
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
  child: ChildProcessWithoutNullStreams;
  raw: AsyncQueue<unknown>;
  init: { session_id?: string; model?: string; tools?: string[]; cwd?: string } | null;
  stderr: string[];
  dead: boolean;
}

/**
 * Claude Code headless, driven as one long-lived multi-turn NDJSON session.
 *
 * Verified against claude 2.1.296: `--input-format stream-json` keeps the
 * process alive across turns on the same stdin pipe. A single reader loop is
 * started at spawn time; every turn then reads from that one queue.
 */
export class ClaudeAdapter implements Adapter {
  readonly id = "claude" as const;
  readonly caps = CAPS;

  private live = new Map<string, Live>();
  private initWaiters = new Map<string, (v: Live["init"]) => void>();

  constructor(
    private readonly policy: Policy,
    private readonly binary = "claude",
  ) {}

  async spawn(opts: SpawnOptions): Promise<Handle> {
    const id = randomUUID();
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      ...toClaudeFlags(this.policy),
    ];
    if (opts.model) args.push("--model", opts.model);
    for (const dir of opts.extraDirs ?? []) args.push("--add-dir", dir);

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    const raw = new AsyncQueue<unknown>();
    const entry: Live = { child, raw, init: null, stderr: [], dead: false };
    this.live.set(id, entry);
    drain(child.stderr, (s) => entry.stderr.push(s));
    child.on("exit", () => {
      entry.dead = true;
      raw.close();
    });

    // One reader for the life of the process.
    void (async () => {
      for await (const r of readJsonLines(child.stdout)) {
        if (r && typeof r === "object" && (r as { type?: string }).type === "system" && (r as { subtype?: string }).subtype === "init") {
          entry.init = r as Live["init"];
          this.initWaiters.get(id)?.(entry.init);
        }
        raw.push(r);
      }
      raw.close();
    })();

    // Nudge an empty user turn so the process emits its init event.
    this.write(id, { type: "user", message: { role: "user", content: "" } });

    const init = await this.waitForInit(id);
    return {
      tool: "claude",
      id,
      native: init?.session_id ?? "",
      cwd: opts.cwd,
      model: opts.model ?? init?.model ?? "default",
      caps: CAPS,
    };
  }

  private waitForInit(id: string): Promise<Live["init"]> {
    const entry = this.live.get(id);
    if (!entry) return Promise.resolve(null);
    if (entry.init) return Promise.resolve(entry.init);
    return new Promise((resolve) => {
      this.initWaiters.set(id, resolve);
      setTimeout(() => {
        if (this.initWaiters.get(id) === resolve) {
          this.initWaiters.delete(id);
          resolve(entry.init);
        }
      }, 15_000).unref?.();
    });
  }

  private write(id: string, payload: unknown) {
    const entry = this.live.get(id);
    if (!entry || entry.dead || entry.child.stdin.destroyed) {
      throw new Error(`claude session ${id} is not alive`);
    }
    entry.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async *send(handle: Handle, prompt: string, signal?: AbortSignal): AsyncGenerator<Event> {
    const entry = this.live.get(handle.id);
    if (!entry) {
      yield { t: "error", kind: "crash", message: `unknown claude session ${handle.id}` };
      return;
    }

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void this.interrupt(handle);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    this.write(handle.id, { type: "user", message: { role: "user", content: prompt } });

    const usage: Usage = zeroUsage();
    let costUsd = 0;
    let turns = 0;
    const coalescer = new DeltaCoalescer(40, (t) => entry.raw.push(normalized({ t: "text.delta", text: t })));

    try {
      for await (const raw of entry.raw) {
        const marker = asNormalized<Event>(raw);
        if (marker) { yield marker; continue; }
        const norm = this.normalize(raw, usage, (u) => Object.assign(usage, u), (c) => (costUsd = c));

        if (norm.t === "text.delta" || norm.t === "thinking.delta") {
          coalescer.push(norm.text);
          continue;
        }

        const flushed = coalescer.flush();
        if (flushed) yield { t: "text.delta", text: flushed };

        if (norm.t === "turn.completed") {
          turns += norm.turns;
          yield { ...norm, usage, costUsd, turns, durationMs: norm.durationMs };
          return;
        }
        if (norm.t === "error" && norm.kind === "rate_limit") {
          yield norm;
          return;
        }
        if (norm.t === "error") {
          yield norm;
          return;
        }
        if (norm.t === "tool.call" || norm.t === "tool.result") yield norm;
      }

      yield aborted
        ? { t: "turn.completed", usage, costUsd, durationMs: 0, turns }
        : { t: "error", kind: "crash", message: entry.dead ? "claude process exited" : "stream closed" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private normalize(raw: unknown, usage: Usage, setUsage: (u: Usage) => void, setCost: (c: number) => void): Event {
    const e = raw as Record<string, unknown>;
    const type = String(e.type ?? "");

    if (type === "system" && e.subtype === "init") {
      return {
        t: "session.started",
        native: String(e.session_id ?? ""),
        model: String(e.model ?? "unknown"),
        tools: Array.isArray(e.tools) ? (e.tools as string[]) : [],
        cwd: String(e.cwd ?? ""),
      };
    }

    if (type === "rate_limit_event") {
      const info = (e.rate_limit_info ?? {}) as Record<string, unknown>;
      const resetsAt = Number(info.resetsAt ?? 0);
      return {
        t: "error",
        kind: "rate_limit",
        message: String(info.message ?? "rate limited"),
        retryAfterMs: resetsAt ? Math.max(0, resetsAt * 1000 - Date.now()) : undefined,
      };
    }

    if (type === "assistant") {
      const msg = (e.message ?? {}) as Record<string, unknown>;
      const u = (msg.usage ?? {}) as Record<string, unknown>;
      setUsage({
        inputTokens: Number(u.input_tokens ?? 0),
        outputTokens: Number(u.output_tokens ?? 0),
        cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
        cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
        thinkingTokens: Number((u.output_tokens_details as { thinking_tokens?: number })?.thinking_tokens ?? 0),
      });
      const content = Array.isArray(msg.content) ? msg.content : [];
      const toolUse = content.find((c) => (c as { type?: string }).type === "tool_use") as
        | { id?: string; name?: string; input?: unknown }
        | undefined;
      if (toolUse?.name) {
        return { t: "tool.call", id: String(toolUse.id ?? ""), name: toolUse.name, input: toolUse.input };
      }
      const text = content
        .filter((c) => (c as { type?: string }).type === "text")
        .map((c) => String((c as { text?: string }).text ?? ""))
        .join("");
      return text ? { t: "text.delta", text } : { t: "turn.started" };
    }

    if (type === "user") {
      const msg = (e.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const tr = content.find((c) => (c as { type?: string }).type === "tool_result") as
        | { tool_use_id?: string; is_error?: boolean; content?: unknown }
        | undefined;
      if (tr?.tool_use_id) {
        return {
          t: "tool.result",
          id: String(tr.tool_use_id),
          ok: !tr.is_error,
          output: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? ""),
        };
      }
      return { t: "turn.started" };
    }

    if (type === "result") {
      setCost(Number(e.total_cost_usd ?? 0));
      if (e.is_error === true) {
        return {
          t: "error",
          kind: e.api_error_status === 429 ? "rate_limit" : "api",
          message: String(e.result ?? "claude reported an error"),
        };
      }
      return {
        t: "turn.completed",
        usage,
        costUsd: Number(e.total_cost_usd ?? 0),
        durationMs: Number(e.duration_ms ?? 0),
        turns: Number(e.num_turns ?? 1),
      };
    }

    return { t: "turn.started" };
  }

  async interrupt(handle: Handle): Promise<void> {
    const entry = this.live.get(handle.id);
    if (entry && !entry.dead) entry.child.kill("SIGINT");
  }

  async close(handle: Handle): Promise<void> {
    const entry = this.live.get(handle.id);
    if (entry && !entry.dead) entry.child.kill("SIGTERM");
    entry?.raw.close();
    this.live.delete(handle.id);
    this.initWaiters.delete(handle.id);
  }

  stderrOf(id: string): string {
    return (this.live.get(id)?.stderr ?? []).join("");
  }

  rootPid(id: string): number | null {
    return this.live.get(id)?.child.pid ?? null;
  }
}