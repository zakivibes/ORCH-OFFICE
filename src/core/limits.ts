import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "./types.js";

/**
 * Token and step limits that stop runaway sessions.
 *
 * Almost all of a worker's cost is re-reading its own context: every model step re-sends the
 * whole conversation, so cost grows with (context size x steps). A turn stuck in a loop, or a
 * session kept alive for many turns, is where the tokens go. These limits cap both.
 *
 * Read on every turn from ~/.orchestrator/limits.json (so they can be changed without a
 * restart), then from env vars, then the defaults below. 0 disables a limit.
 *
 *   {
 *     "maxTurnSteps": 250,            // tool calls in one turn before it is stopped
 *     "maxTurnReadTokens": 0,         // tokens read (input + cache read) in one turn
 *     "maxSessionReadTokens": 60000000, // tokens read over the session's whole life
 *     "warnAtFraction": 0.8,          // warn once the session passes this share of its budget
 *     "overrides": [                  // per model, first match wins (substring of "provider/model")
 *       { "match": "nvidia-", "maxSessionReadTokens": 0 }   // e.g. free models: no token budget
 *     ]
 *   }
 *
 * The defaults are deliberately thrifty: most people pay per token. Loosen them per model for
 * providers that are free for you rather than raising them for everyone.
 */
export interface Limits {
  maxTurnSteps: number;
  maxTurnReadTokens: number;
  maxSessionReadTokens: number;
  warnAtFraction: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTurnSteps: 250,
  maxTurnReadTokens: 0,
  maxSessionReadTokens: 60_000_000,
  warnAtFraction: 0.8,
};

export function limitsPath(): string {
  return process.env.ORCH_LIMITS_FILE || join(homedir(), ".orchestrator", "limits.json");
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function loadLimits(model = ""): Limits {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(readFileSync(limitsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    /* no file, or unreadable: fall through to env and defaults */
  }
  // A per-model override replaces only the keys it names.
  const overrides = Array.isArray(file.overrides) ? (file.overrides as Record<string, unknown>[]) : [];
  const hit = overrides.find((o) => typeof o?.match === "string" && o.match && model.includes(o.match));
  if (hit) file = { ...file, ...hit };
  const env = process.env;
  return {
    maxTurnSteps: num(file.maxTurnSteps) ?? num(env.ORCH_MAX_TURN_STEPS) ?? DEFAULT_LIMITS.maxTurnSteps,
    maxTurnReadTokens:
      num(file.maxTurnReadTokens) ?? num(env.ORCH_MAX_TURN_READ_TOKENS) ?? DEFAULT_LIMITS.maxTurnReadTokens,
    maxSessionReadTokens:
      num(file.maxSessionReadTokens) ?? num(env.ORCH_MAX_SESSION_READ_TOKENS) ?? DEFAULT_LIMITS.maxSessionReadTokens,
    warnAtFraction: num(file.warnAtFraction) ?? DEFAULT_LIMITS.warnAtFraction,
  };
}

/** Tokens the model had to read: fresh input plus context served from cache. */
export function readTokens(u: Usage): number {
  return u.inputTokens + u.cacheReadTokens;
}

export function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}
