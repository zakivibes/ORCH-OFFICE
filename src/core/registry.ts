import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Store } from "./db.js";
import { Policy, type NarrowRequest } from "../permissions/policy.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { AgyAdapter } from "../adapters/agy.js";
import { OpencodeAdapter } from "../adapters/opencode.js";
import {
  zeroUsage,
  type Adapter,
  type Event,
  type Handle,
  type StoredSession,
  type ToolId,
} from "./types.js";

export interface OpenArgs {
  tool: ToolId;
  cwd: string;
  label?: string;
  model?: string;
  extraDirs?: string[];
  roots: string[];
  narrow?: NarrowRequest;
}

export interface SendArgs {
  sessionId: string;
  prompt: string;
  signal?: AbortSignal;
}

/**
 * Owns live sessions, persists history, and re-broadcasts normalized events.
 *
 * Adapters are created per session so each gets its own Policy snapshot: if
 * the caller's narrowing changes between turns, a new policy applies from the
 * next turn onward rather than retroactively.
 */
export class Registry extends EventEmitter {
  private adapters = new Map<string, Adapter>();
  private policies = new Map<string, Policy>();
  private handles = new Map<string, Handle>();

  constructor(readonly store: Store) {
    super();
    this.setMaxListeners(50);
  }

  private build(tool: ToolId, policy: Policy): Adapter {
    switch (tool) {
      case "claude":
        return new ClaudeAdapter(policy);
      case "agy":
        return new AgyAdapter(policy);
      case "opencode":
        return new OpencodeAdapter(policy);
      default:
        throw new Error(
          `unknown tool "${tool}" (expected claude, agy or opencode)`,
        );
    }
  }

  async open(args: OpenArgs): Promise<{ handle: Handle; session: StoredSession }> {
    const policy = new Policy({ projectDir: args.cwd, roots: args.roots }).narrow(args.narrow);
    const adapter = this.build(args.tool, policy);
    const handle = await adapter.spawn({
      cwd: args.cwd,
      model: args.model,
      extraDirs: args.extraDirs,
    });

    const now = Date.now();
    const session: StoredSession = {
      id: handle.id,
      tool: args.tool,
      native: handle.native,
      cwd: args.cwd,
      model: handle.model,
      label: args.label ?? "",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      rootPid: null,
      totals: zeroUsage(),
      costUsd: 0,
    };
    this.store.insertSession(session);
    this.adapters.set(handle.id, adapter);
    this.policies.set(handle.id, policy);
    this.handles.set(handle.id, handle);
    this.store.updateNative(handle.id, handle.native, handle.model);

    this.emit("session", session);
    return { handle, session };
  }

  async *send(args: SendArgs): AsyncGenerator<Event> {
    const adapter = this.adapters.get(args.sessionId);
    if (!adapter) {
      yield { t: "error", kind: "crash", message: `session ${args.sessionId} is not live` };
      return;
    }
    const handle = this.handleFor(args.sessionId);
    if (!handle) {
      yield { t: "error", kind: "crash", message: `session ${args.sessionId} has no handle` };
      return;
    }

    const turnId = this.store.startTurn(args.sessionId, args.prompt);
    let usage = zeroUsage();
    let costUsd = 0;
    let aborted = false;
    let resultText = "";
    let completed = false;

    for await (const ev of adapter.send(handle, args.prompt, args.signal)) {
      this.store.appendEvent(args.sessionId, ev);
      this.emit("event", args.sessionId, ev);

      if (ev.t === "text.delta") resultText += ev.text;
      if (ev.t === "turn.completed") {
        usage = ev.usage;
        costUsd = ev.costUsd ?? 0;
        completed = true;
      }
      if (ev.t === "error" && ev.kind === "rate_limit") aborted = true;

      yield ev;

      if (ev.t === "turn.completed" || ev.t === "error") break;
    }

    this.store.endTurn(turnId, { usage, costUsd, aborted: !completed, resultText });
    this.store.accumulate(args.sessionId, usage, costUsd);
  }

  handleFor(id: string): Handle | null {
    return this.handles.get(id) ?? null;
  }

  async interrupt(sessionId: string): Promise<void> {
    const adapter = this.adapters.get(sessionId);
    const handle = this.handles.get(sessionId);
    if (adapter && handle) await adapter.interrupt(handle);
  }

  async close(sessionId: string): Promise<void> {
    const adapter = this.adapters.get(sessionId);
    const handle = this.handles.get(sessionId);
    if (adapter && handle) await adapter.close(handle);
    this.store.closeSession(sessionId);
    this.adapters.delete(sessionId);
    this.policies.delete(sessionId);
    this.handles.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.adapters.keys()]) {
      try {
        await this.close(id);
      } catch {
        /* best effort on shutdown */
      }
    }
  }

  policyFor(sessionId: string): Policy | null {
    return this.policies.get(sessionId) ?? null;
  }

  adapterFor(sessionId: string): Adapter | null {
    return this.adapters.get(sessionId) ?? null;
  }
}