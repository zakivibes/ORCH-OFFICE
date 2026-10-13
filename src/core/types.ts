export type ToolId = "claude" | "agy" | "opencode";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
}

export const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  thinkingTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}

export type Event =
  | { t: "session.started"; native: string; model: string; tools: string[]; cwd: string }
  | { t: "text.delta"; text: string }
  | { t: "thinking.delta"; text: string }
  | { t: "tool.call"; id: string; name: string; input: unknown }
  | { t: "tool.result"; id: string; ok: boolean; output: string }
  | { t: "permission.request"; id: string; tool: string; input: unknown }
  | { t: "turn.completed"; usage: Usage; costUsd?: number; durationMs: number; turns: number }
  | {
      t: "error";
      kind: "rate_limit" | "api" | "crash";
      message: string;
      retryAfterMs?: number;
    }
  | { t: "turn.started" };

export type ErrorKind = Extract<Event, { t: "error" }>["kind"];

export interface AdapterCaps {
  /** Can consume further prompts on the same live process after a turn ends. */
  persistent: boolean;
  /** Rule-accurate native permissions, or only coarse/mediated control. */
  permissionFidelity: "native" | "mediated" | "coarse";
  /** Can abort an in-flight turn. */
  interrupt: boolean;
  /** Native structured output via JSON schema. */
  structuredOutput: boolean;
  /** Reports authoritative cost in USD rather than tokens only. */
  costUsd: boolean;
  /** Native sub-agent tree. */
  subagents: boolean;
}

export interface SpawnOptions {
  cwd: string;
  model?: string;
  /** Extra directories the worker may touch. Already clamped by the caller. */
  extraDirs?: string[];
  signal?: AbortSignal;
}

export interface Handle {
  tool: ToolId;
  /** Our own stable session id. */
  id: string;
  /** The CLI's own session/conversation id, used to resume across restarts. */
  native: string;
  cwd: string;
  model: string;
  caps: AdapterCaps;
}

export interface TurnResult {
  usage: Usage;
  costUsd?: number;
  durationMs: number;
  turns: number;
  aborted: boolean;
}

export interface Adapter {
  readonly id: ToolId;
  readonly caps: AdapterCaps;
  /** Long-lived. Returns once the underlying session is established. */
  spawn(opts: SpawnOptions): Promise<Handle>;
  /** Multi-turn on the same live process. Yields normalized events. */
  send(handle: Handle, prompt: string, signal?: AbortSignal): AsyncGenerator<Event>;
  /** Abort the in-flight turn, keep the session alive. */
  interrupt(handle: Handle): Promise<void>;
  close(handle: Handle): Promise<void>;
}

export interface StoredSession {
  id: string;
  tool: ToolId;
  native: string;
  cwd: string;
  model: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  rootPid: number | null;
  totals: Usage;
  costUsd: number;
}

export interface StoredTurn {
  id: number;
  sessionId: string;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  usage: Usage;
  costUsd: number;
  aborted: boolean;
  resultText: string;
}

export interface StoredEvent {
  seq: number;
  sessionId: string;
  at: number;
  event: Event;
}