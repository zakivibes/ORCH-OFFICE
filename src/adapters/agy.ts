import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toAgyFlags } from "../permissions/translate.js";
import type { Policy } from "../permissions/policy.js";
import { readJsonLines, drain } from "./ndjson.js";
import { AsyncQueue, DeltaCoalescer, normalized, asNormalized } from "../core/queue.js";
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
  // agy has no per-rule allow/deny list; the orchestrator mediates in-band.
  permissionFidelity: "mediated",
  interrupt: true,
  structuredOutput: true,
  costUsd: false,
  subagents: true,
};

interface Live {
  child: ChildProcessWithoutNullStreams;
  raw: AsyncQueue<unknown>;
  init: Record<string, unknown> | null;
  stderr: string[];
  dead: boolean;
}

/**
 * agy headless as one long-lived stream-json session.
 *
 * Verified against agy 1.3.4: `--print --input-format stream-json` emits
 * `init`, then `step_update` records whose `state` flips ACTIVE -> DONE, then
 * a terminal `result`. Usage is reported per step and again in the result;
 * there is no USD figure, only tokens.
 */
export class AgyAdapter implements Adapter {
  readonly id = "agy" as const;
  readonly caps = CAPS;

  private live = new Map<string, Live>();
  private initWaiters = new Map<string, (v: Record<string, unknown> | null) => void>();
  /** Permission prompts intercepted from agy and answered by the policy. */
  private pendingPermissions = new Map<string, (decision: { allow: boolean }) => void>();

  constructor(
    private readonly policy: Policy,
    private readonly binary = "agy",
  ) {}

  async spawn(opts: SpawnOptions): Promise<Handle> {
    const id = randomUUID();
    // agy's --print is a *string* flag that takes the prompt as its value, so
    // it must not be passed here: it would swallow the next argument. Reading
    // turns from stdin is done with --input-format alone.
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      ...toAgyFlags(this.policy),
    ];
    if (opts.model) args.push("--model", opts.model);

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

    void (async () => {
      for await (const r of readJsonLines(child.stdout)) {
        if (r && typeof r === "object" && (r as { event?: string }).event === "init") {
          entry.init = r as Record<string, unknown>;
          this.initWaiters.get(id)?.(entry.init);
        }
        raw.push(r);
      }
      raw.close();
    })();

    const init = await this.waitForInit(id);
    const inner = (init?.init ?? {}) as Record<string, unknown>;

    return {
      tool: "agy",
      id,
      native: String(init?.conversation_id ?? ""),
      cwd: opts.cwd,
      model: opts.model ?? String(inner.model ?? "default"),
      caps: CAPS,
    };
  }

  private waitForInit(id: string): Promise<Record<string, unknown> | null> {
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
      throw new Error(`agy session ${id} is not alive`);
    }
    entry.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async *send(handle: Handle, prompt: string, signal?: AbortSignal): AsyncGenerator<Event> {
    const entry = this.live.get(handle.id);
    if (!entry) {
      yield { t: "error", kind: "crash", message: `unknown agy session ${handle.id}` };
      return;
    }

    const onAbort = () => {
      void this.interrupt(handle);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Input envelope shape verified against agy 1.3.4.
    this.write(handle.id, { event: "user", message: { content: prompt } });

    let usage: Usage = zeroUsage();
    const coalescer = new DeltaCoalescer(40, (t) => entry.raw.push(normalized({ t: "text.delta", text: t })));
    let turns = 0;
    let sawText = false;

    try {
      for await (const raw of entry.raw) {
        const marker = asNormalized<Event>(raw);
        if (process.env.ORCH_DEBUG) {
          process.stderr.write(`[agy raw] ${marker ? "MARKER" : JSON.stringify(raw).slice(0, 220)}\n`);
        }
        if (marker) { yield marker; continue; }
        const r = raw as Record<string, unknown>;
        const event = String(r.event ?? "");

        if (event === "init") {
          const inner = (r.init ?? {}) as Record<string, unknown>;
          yield {
            t: "session.started",
            native: String(r.conversation_id ?? ""),
            model: String(inner.model ?? "unknown"),
            tools: Array.isArray(inner.tools) ? (inner.tools as string[]) : [],
            cwd: String(inner.cwd ?? ""),
          };
          continue;
        }

        if (event === "step_update") {
          const su = (r.step_update ?? {}) as Record<string, unknown>;
          const state = String(su.state ?? "");
          const stepType = String(su.step_type ?? "");
          const stepIndex = Number(su.step_index ?? 0);

          // Each model step reports its OWN usage (verified on agy 1.3.x: the result's usage
          // is the sum of the steps). Sum them so the total is right even if no result
          // arrives, and surface each step so dashboards can count mid-turn.
          if (su.usage && state === "DONE") {
            const u = su.usage as Record<string, unknown>;
            const step: Usage = {
              inputTokens: Number(u.input_tokens ?? 0),
              outputTokens: Number(u.output_tokens ?? 0),
              thinkingTokens: Number(u.thinking_tokens ?? 0),
              cacheReadTokens: Number(u.cache_read_tokens ?? 0),
              cacheWriteTokens: 0,
            };
            usage = addUsage(usage, step);
            yield { t: "usage.step", usage: step };
          }

          // agy is inconsistent about where the text lands: some turns stream
          // text_delta on ACTIVE records, others deliver the whole reply on the
          // DONE record. Accept it at any state and flush when the step ends.
          const delta = typeof su.text_delta === "string" ? su.text_delta : "";
          if (delta) { sawText = true; coalescer.push(delta); }

          if (state === "DONE") {
            const flushed = coalescer.flush();
            if (flushed) yield { t: "text.delta", text: flushed };
            // agy 1.3.x labels tool steps "tool"; older builds used tool_call/tool_use.
            if (stepType === "tool" || stepType === "tool_call" || stepType === "tool_use") {
              const info = (su.tool_info ?? {}) as Record<string, unknown>;
              yield {
                t: "tool.call",
                id: `${stepIndex}`,
                name: String(su.tool_name ?? info.name ?? su.step_type),
                input: { tool_info: { name: info.name, parameters: info.parameters } },
              };
              if (info.output !== undefined) {
                yield { t: "tool.result", id: `${stepIndex}`, ok: true, output: String(info.output).slice(0, 2000) };
              }
            }
          }
          continue;
        }

        if (event === "result") {
          const res = (r.result ?? {}) as Record<string, unknown>;
          const u = (res.usage ?? {}) as Record<string, unknown>;
          // The result's own total is authoritative when present.
          usage = { ...usage };
          Object.assign(usage, {
            inputTokens: Number(u.input_tokens ?? usage.inputTokens),
            outputTokens: Number(u.output_tokens ?? usage.outputTokens),
            thinkingTokens: Number(u.thinking_tokens ?? usage.thinkingTokens),
            cacheReadTokens: Number(u.cache_read_tokens ?? usage.cacheReadTokens),
          });
          const tail = coalescer.flush();
          if (tail) { sawText = true; yield { t: "text.delta", text: tail }; }
          // Some turns stream nothing and carry the whole reply only here.
          const response = typeof res.response === "string" ? res.response : "";
          if (!sawText && response) yield { t: "text.delta", text: response };
          // Headless agy cannot prompt, so a tool needing approval is
          // auto-denied and the turn ends quietly. Say so instead.
          const denied = Array.isArray(res.denied_actions) ? (res.denied_actions as Array<Record<string, unknown>>) : [];
          if (denied.length) {
            const names = denied.map((d) => String(d.display_name ?? d.action ?? "?")).join(", ");
            yield { t: "text.delta", text: `\n[orch] agy auto-denied in headless mode: ${names}\n` };
          }
          turns = Number(res.num_turns ?? 1);
          const status = String(res.status ?? "SUCCESS");
          if (status !== "SUCCESS") {
            // agy often ends a failed turn with an empty response and puts the reason
            // (e.g. "RESOURCE_EXHAUSTED ... Resets in 47m26s") only in its own log.
            const detail = String(res.response ?? "").trim() || agyLastLoggedError(entry.stderr.join(""));
            const quota = /RESOURCE_EXHAUSTED|quota|\b429\b|rate.?limit/i.test(detail);
            yield {
              t: "error",
              kind: quota ? "rate_limit" : "api",
              message: `agy ${status}: ${detail || "(no detail reported)"}`,
              ...(quota ? { retryAfterMs: parseResetIn(detail) } : {}),
            };
            return;
          }
          yield {
            t: "turn.completed",
            usage,
            durationMs: Math.round(Number(res.duration_seconds ?? 0) * 1000),
            turns,
          };
          return;
        }

        const flushed = coalescer.flush();
        if (flushed) yield { t: "text.delta", text: flushed };
      }

      yield { t: "error", kind: "crash", message: entry.dead ? "agy process exited" : "stream closed" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
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

  /**
   * Answer an agy permission prompt. The adapter surfaces the request as a
   * `permission.request` event; the registry evaluates it against the policy
   * and calls back here.
   */
  resolvePermission(id: string, allow: boolean) {
    this.pendingPermissions.get(id)?.({ allow });
    this.pendingPermissions.delete(id);
  }

  stderrOf(id: string): string {
    return (this.live.get(id)?.stderr ?? []).join("");
  }

  rootPid(id: string): number | null {
    return this.live.get(id)?.child.pid ?? null;
  }
}
/**
 * The most recent error agy logged, for turns that fail with an empty response.
 * Prefers the process's own stderr; falls back to the newest agy CLI log file.
 */
export function agyLastLoggedError(stderr: string, logDir = join(homedir(), ".gemini", "antigravity-cli", "log")): string {
  const pick = (text: string) => {
    const lines = text.split("\n").filter((l) => /^E\d{4} .*\] /.test(l) || /RESOURCE_EXHAUSTED|quota reached/i.test(l));
    const last = lines[lines.length - 1];
    return last ? last.replace(/^E\d{4} [\d:.]+\s+\d+ [\w.]+:\d+\] /, "").trim().slice(0, 400) : "";
  };
  const fromStderr = pick(stderr);
  if (fromStderr) return fromStderr;
  try {
    const newest = readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (!newest || Date.now() - newest.t > 10 * 60_000) return "";
    return pick(readFileSync(join(logDir, newest.f), "utf8").slice(-20_000));
  } catch {
    return "";
  }
}

/** "Resets in 47m26s" / "1h2m" / "30s" -> milliseconds, if present. */
export function parseResetIn(text: string): number | undefined {
  const m = /resets? in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text);
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}
