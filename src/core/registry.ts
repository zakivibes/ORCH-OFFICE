import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Store } from "./db.js";
import { WorktreeManager, type Worktree } from "./worktree.js";
import { Policy, type NarrowRequest } from "../permissions/policy.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { AgyAdapter } from "../adapters/agy.js";
import { OpencodeAdapter } from "../adapters/opencode.js";
import { fmtTokens, loadLimits, readTokens } from "./limits.js";
import { LoopGuard } from "./loopGuard.js";

/** The prompt for an automatic follow-up turn after a FIRST_WRITE stop. */
const NUDGE_PROMPT =
  "Continue the same job. Write now; do not re-read files you already read. If an item is done, " +
  "move to the next one. End with Assumptions + files + real last test lines.";
import { agentsMdWarning, buildAnchorPack, jobBasename, readJobText } from "./anchors.js";
import {
  addUsage,
  zeroUsage,
  type Adapter,
  type Event,
  type Handle,
  type StoredSession,
  type ToolId,
} from "./types.js";
import {
  matchGroup,
  countLive,
  isInShiftWindow,
  shiftRefusalMessage,
  startShiftTimer,
  checkQuota,
  recordQuotaError,
  shiftStatus,
  getGroups,
  type ShiftStatusEntry,
  type LiveSession,
  __testTick,
  isQuotaError,
} from "./policy_rules.js";

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
  /** Path to a job file; its text and code-graph anchors are added to the first prompt. */
  job?: string;
}

export interface SendArgs {
  sessionId: string;
  prompt: string;
  signal?: AbortSignal;
  /** Path to a job file (relative to the session cwd or absolute). */
  job?: string;
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
  public worktreeFor = new Map<string, Worktree>();
  public adapters = new Map<string, Adapter>();
  private policies = new Map<string, Policy>();
  public handles = new Map<string, Handle>();
  public sessionGroups = new Map<string, string>();
  /** Sessions that have called graphify, so the graph-first rule asks for it once per session. */
  private graphSessions = new Set<string>();
  /** The stop reason of the session's last turn, when a limit stopped it ("" otherwise). */
  private lastStops = new Map<string, string>();
  /** Automatic FIRST_WRITE follow-ups already spent per session (see autoNudge). */
  private nudges = new Map<string, number>();
  /** Job paths stashed by open() and consumed by the session's first send(). */
  private sessionJobs = new Map<string, string>();

  constructor(readonly store: Store) {
    super();
    this.setMaxListeners(50);
    startShiftTimer(this);
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
    const group = matchGroup({ tool: args.tool, model: args.model });
    if (group) {
      const liveSessions: LiveSession[] = [];
      const allSessions = this.store.listSessions(false);
      for (const s of allSessions) {
        const gm = matchGroup({ tool: s.tool, model: s.model });
        if (gm?.name === group.name) {
          liveSessions.push({ id: s.id, group: group.name, closedAt: s.closedAt });
        }
      }
      const live = countLive(group.name, liveSessions);
      if (live >= group.max) {
        throw new Error(`group ${group.name} is full (${live}/${group.max} live)`);
      }
      if (group.shift && !isInShiftWindow(group)) {
        throw new Error(shiftRefusalMessage(group));
      }
      const quota = checkQuota(group.name);
      if (quota.blocked) {
        throw new Error(quota.message!);
      }
    }

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
    if (group) this.sessionGroups.set(handle.id, group.name);
    if (worktree) this.worktreeFor.set(handle.id, worktree);
    if (args.job) this.sessionJobs.set(handle.id, args.job);
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

    // Job + anchor pack: prepend the job file's text and graphify anchors so
    // the worker starts at exact lines (graph-first rule satisfied by the pack).
    let prompt = args.prompt;
    const jobPath = args.job ?? this.sessionJobs.get(args.sessionId);
    this.sessionJobs.delete(args.sessionId);
    if (jobPath) {
      const warning = agentsMdWarning(handle.cwd);
      if (warning) yield { t: "text.delta", text: `[orch] ${warning}\n` };
      const jobText = readJobText(handle.cwd, jobPath);
      if (jobText) {
        const pack = await buildAnchorPack(handle.cwd, jobText);
        if (pack) this.graphSessions.add(args.sessionId);
        prompt =
          `${args.prompt}\n\n## Job (${jobBasename(jobPath)})\n${jobText}\n\n` +
          `## Anchors (from the code graph — start here, graph-first rule satisfied)\n${pack}`;
      } else {
        yield { t: "text.delta", text: `[orch] job file not readable: ${jobPath}\n` };
      }
    }

    const stored = this.store.getSession(args.sessionId);
    let groupName = this.sessionGroups.get(args.sessionId);
    let group = groupName ? getGroups().find((g) => g.name === groupName) : null;
    if (!group && stored) {
      group = matchGroup({ tool: stored.tool, model: stored.model });
    }
    if (group?.shift && !isInShiftWindow(group)) {
      yield {
        t: "error",
        kind: "budget",
        message: shiftRefusalMessage(group),
      };
      return;
    }

    // Limits are re-read every turn so ~/.orchestrator/limits.json can be tuned live.
    const limits = loadLimits(stored?.model ?? handle.model);
    const sessionReadBefore = stored ? readTokens(stored.totals) : 0;
    if (limits.maxSessionReadTokens > 0 && sessionReadBefore >= limits.maxSessionReadTokens) {
      yield {
        t: "error",
        kind: "budget",
        message:
          `session budget reached: it has read ${fmtTokens(sessionReadBefore)} tokens ` +
          `(limit ${fmtTokens(limits.maxSessionReadTokens)}). Close it and open a fresh session ` +
          `with a short hand-off; a long session re-reads its whole history on every step.`,
      };
      return;
    }
    if (
      limits.maxSessionReadTokens > 0 &&
      sessionReadBefore >= limits.maxSessionReadTokens * limits.warnAtFraction
    ) {
      yield {
        t: "text.delta",
        text:
          `[orch budget] this session has read ${fmtTokens(sessionReadBefore)} of ` +
          `${fmtTokens(limits.maxSessionReadTokens)} tokens; plan to hand off to a fresh session.\n`,
      };
    }

    const turnId = this.store.startTurn(args.sessionId, prompt);
    let usage = zeroUsage();
    let costUsd = 0;
    let resultText = "";
    let completed = false;
    // Running usage for limits and for turns that end without a turn.completed: agy reports
    // per-step deltas (usage.step), opencode a running total (usage.progress).
    let stepSum = zeroUsage();
    let progress = zeroUsage();
    // Context watchdog: one step's context is input + cache read of THAT step. agy's usage.step
    // carries it directly; opencode's progress is cumulative, so keep the previous progress and
    // take the delta (fall back to the last known step when the delta is not meaningful).
    let stepContext = 0;
    let lastStepRead = 0;
    const guard = new LoopGuard(limits, this.graphSessions.has(args.sessionId));
    let stopReason = "";
    let lastError: Event | null = null;

    for await (const ev of adapter.send(handle, prompt, args.signal)) {
      this.store.appendEvent(args.sessionId, ev);
      this.emit("event", args.sessionId, ev);

      if (ev.t === "text.delta") resultText += ev.text;
      if (ev.t === "tool.call") stopReason = guard.onToolCall(ev.name, ev.input);
      if (ev.t === "usage.step") {
        stepSum = addUsage(stepSum, ev.usage);
        lastStepRead = ev.usage.inputTokens + ev.usage.cacheReadTokens;
        stepContext = lastStepRead;
      }
      if (ev.t === "usage.progress") {
        const deltaRead =
          ev.usage.inputTokens - progress.inputTokens + (ev.usage.cacheReadTokens - progress.cacheReadTokens);
        stepContext = deltaRead > 0 ? deltaRead : lastStepRead;
        progress = ev.usage;
      }
      if (ev.t === "turn.completed") {
        usage = ev.usage;
        costUsd = ev.costUsd ?? 0;
        completed = true;
      }
      if (ev.t === "error") lastError = ev;

      yield ev;

      if (ev.t === "turn.completed" || ev.t === "error") break;

      const turnRead = Math.max(readTokens(stepSum), readTokens(progress));
      if (stopReason) {
        /* set by the loop guard on this tool call */
      } else if (limits.maxStepContextTokens > 0 && stepContext > limits.maxStepContextTokens) {
        stopReason = `CONTEXT: step context ${fmtTokens(stepContext)} tokens (limit ${fmtTokens(limits.maxStepContextTokens)}). Roll over to a fresh session`;
      } else if (limits.maxTurnReadTokens > 0 && turnRead > limits.maxTurnReadTokens) {
        stopReason = `turn stopped after reading ${fmtTokens(turnRead)} tokens (limit ${fmtTokens(limits.maxTurnReadTokens)})`;
      } else if (
        limits.maxSessionReadTokens > 0 &&
        sessionReadBefore + turnRead > limits.maxSessionReadTokens
      ) {
        stopReason = `session budget reached mid-turn: ${fmtTokens(sessionReadBefore + turnRead)} tokens read (limit ${fmtTokens(limits.maxSessionReadTokens)})`;
      }
      if (stopReason) {
        try {
          await adapter.interrupt(handle);
        } catch {
          /* the stop is recorded either way */
        }
        const stop: Event = {
          t: "error",
          kind: "budget",
          message: `${stopReason}. Work so far is kept; review it, then continue in a fresh session with a short hand-off.`,
        };
        this.store.appendEvent(args.sessionId, stop);
        this.emit("event", args.sessionId, stop);
        this.lastStops.set(args.sessionId, stopReason);
        yield stop;
        break;
      }
    }

    if (guard.usedGraph) this.graphSessions.add(args.sessionId);
    if (!stopReason) this.lastStops.delete(args.sessionId);

    // A turn that never completed (stopped, errored, aborted) still consumed tokens: record what
    // was seen so the session totals and the budget stay honest.
    if (!completed) usage = readTokens(stepSum) >= readTokens(progress) ? stepSum : progress;
    this.store.endTurn(turnId, { usage, costUsd, aborted: !completed, resultText });
    this.store.accumulate(args.sessionId, usage, costUsd);

    if (lastError && group) {
      const isQuotaErr = lastError.kind === "rate_limit" || isQuotaError(lastError.message);
      if (group.quota && isQuotaErr) {
        recordQuotaError(group.name, lastError.message);
      }
    }
  }

  /**
   * One automatic follow-up turn after a FIRST_WRITE stop, so a session that only read does not
   * wait for the coordinator to tell it to write. The daemon calls this right after send finishes
   * (while the session is still marked running). At most `autoNudges` per session; CONTEXT stops
   * are never nudged — they need a fresh session, which the rollover hand-off handles.
   * Returns whether a nudge turn was started.
   */
  async autoNudge(sessionId: string): Promise<boolean> {
    const stop = this.lastStops.get(sessionId) ?? "";
    if (!stop.startsWith("FIRST_WRITE:")) return false;
    this.lastStops.delete(sessionId);
    const stored = this.store.getSession(sessionId);
    const limits = loadLimits(stored?.model ?? "");
    const used = this.nudges.get(sessionId) ?? 0;
    if (limits.autoNudges <= 0 || used >= limits.autoNudges) return false;
    this.nudges.set(sessionId, used + 1);
    const note: Event = { t: "text.delta", text: `[orch] auto-nudge ${used + 1}/${limits.autoNudges}\n` };
    this.store.appendEvent(sessionId, note);
    this.emit("event", sessionId, note);
    for await (const _ev of this.send({ sessionId, prompt: NUDGE_PROMPT })) {
      /* the nudge turn persists and re-broadcasts its own events */
    }
    return true;
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
    this.sessionGroups.delete(sessionId);
    this.nudges.delete(sessionId);
    this.lastStops.delete(sessionId);
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

  shiftStatus(): ShiftStatusEntry[] {
    const liveSessions: LiveSession[] = [];
    const allSessions = this.store.listSessions(false);
    for (const s of allSessions) {
      const group = matchGroup({ tool: s.tool, model: s.model });
      if (group) {
        liveSessions.push({ id: s.id, group: group.name, closedAt: s.closedAt });
      }
    }
    return shiftStatus(liveSessions);
  }
}