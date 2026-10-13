import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Store } from "./db.js";
import { WorktreeManager, type Worktree } from "./worktree.js";
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
  /** Create an isolated git worktree and run the agent inside it. */
  worktree?: boolean;
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
  readonly worktrees = new WorktreeManager();
  private worktreeFor = new Map<string, Worktree>();
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

  async open(args: OpenArgs): Promise<{ handle: Handle; session: StoredSession; worktree: Worktree | null }> {
    // A worktree must exist before the agent spawns, because the agent's cwd
    // is the worktree. On failure we fall back to the shared checkout rather
    // than leaving the caller with nothing.
    let worktree: Worktree | null = null;
    let cwd = args.cwd;
    if (args.worktree) {
      try {
        const repoRoot = await this.worktrees.repoRoot(args.cwd);
        if (!repoRoot) throw new Error(`${args.cwd} is not inside a git repository`);
        const id = randomUUID();
        worktree = await this.worktrees.create(repoRoot, args.label || id.slice(0, 8), id);
        cwd = worktree.path;
      } catch (err) {
        this.emit("warning", `worktree unavailable, sharing the checkout: ${err instanceof Error ? err.message : err}`);
        worktree = null;
        cwd = args.cwd;
      }
    }

    const roots = worktree ? [...args.roots, worktree.path] : args.roots;
    const policy = new Policy({ projectDir: cwd, roots }).narrow(args.narrow);
    const adapter = this.build(args.tool, policy);
    const handle = await adapter.spawn({
      cwd,
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
      worktreePath: worktree?.path ?? null,
      worktreeBranch: worktree?.branch ?? null,
      repoRoot: worktree?.repoRoot ?? null,
    };
    this.store.insertSession(session);
    this.adapters.set(handle.id, adapter);
    this.policies.set(handle.id, policy);
    this.handles.set(handle.id, handle);
    if (worktree) this.worktreeFor.set(handle.id, worktree);
    this.store.updateNative(handle.id, handle.native, handle.model);

    this.emit("session", session);
    return { handle, session, worktree };
  }

  worktree(sessionId: string): Worktree | null {
    const s = this.store.getSession(sessionId);
    if (!s?.worktreePath || !s.worktreeBranch || !s.repoRoot) return null;
    return {
      path: s.worktreePath,
      branch: s.worktreeBranch,
      repoRoot: s.repoRoot,
      sessionId,
      createdAt: 0,
    };
  }

  async diff(sessionId: string, statOnly = false) {
    const wt = this.worktree(sessionId);
    if (!wt) return null;
    const files = await this.worktrees.changedFiles(wt);
    if (statOnly) return { files, patch: "" };
    return { files, patch: await this.worktrees.diff(wt) };
  }

  async merge(sessionId: string, mode: "squash" | "merge" = "squash") {
    const wt = this.worktree(sessionId);
    if (!wt) throw new Error(`session ${sessionId} has no worktree`);
    return this.worktrees.merge(wt, mode);
  }

  async discard(sessionId: string, force = false) {
    const wt = this.worktree(sessionId);
    if (!wt) return { removed: false, reason: "session has no worktree" };
    return this.worktrees.discard(wt, force);
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