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
 *     "maxRepeatCalls": 6,            // identical calls in one turn (loopGuard.ts)
 *     "maxTestRuns": 12,              // test runs in one turn
 *     "maxSameFileReads": 30,         // reads of one file in one turn
 *     "maxExploreBeforeGraph": 8,     // grep/read calls before the first graphify call (0 = off)
 *     "maxStepsBeforeFirstEdit": 40,  // tool calls in a turn with nothing written yet (0 = off)
 *     "maxExploreSinceLastEdit": 60,  // read/grep calls after the turn's last edit (0 = off)
 *     "autoNudges": 2,                // automatic follow-up turns after a FIRST_WRITE stop
 *     "maxProviderRetries": 3,        // provider retries (session.status retry) before the turn is stopped; 0 = wait forever
 *     "maxStepContextTokens": 0,      // one step's context (input + cache read); 0 = off
 *     "stepGraceAfterEdit": 40,       // past maxTurnSteps, keep going while an edit is this recent...
 *     "hardStepMultiplier": 2,        // ...up to maxTurnSteps x this
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
  /** Identical calls (same tool, same input) allowed in one turn (see loopGuard.ts). */
  maxRepeatCalls: number;
  /** Test runs allowed in one turn. */
  maxTestRuns: number;
  /** Reads of the same file allowed in one turn. */
  maxSameFileReads: number;
  /** grep/read calls allowed before the turn's first graphify call (0 = off). */
  maxExploreBeforeGraph: number;
  /** Tool calls a turn may make before its first edit or write (0 = off). */
  maxStepsBeforeFirstEdit: number;
  /** Read/grep calls allowed after the turn's last edit before it is stopped (0 = off). */
  maxExploreSinceLastEdit: number;
  /** Automatic follow-up turns the daemon runs after a FIRST_WRITE stop. */
  autoNudges: number;
  /** Provider retry attempts (opencode session.status type "retry") tolerated before the turn is stopped (0 = wait forever). */
  maxProviderRetries: number;
  /** One model step's context (input + cache read tokens) above which the turn is stopped (0 = off). */
  maxStepContextTokens: number;
  /** Past maxTurnSteps, a turn that edited a file within this many calls may continue... */
  stepGraceAfterEdit: number;
  /** ...up to maxTurnSteps times this. */
  hardStepMultiplier: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTurnSteps: 250,
  maxTurnReadTokens: 0,
  maxSessionReadTokens: 60_000_000,
  warnAtFraction: 0.8,
  maxRepeatCalls: 6,
  maxTestRuns: 12,
  maxSameFileReads: 30,
  maxExploreBeforeGraph: 8,
  maxStepsBeforeFirstEdit: 40,
  maxExploreSinceLastEdit: 60,
  autoNudges: 2,
  maxProviderRetries: 3,
  maxStepContextTokens: 0,
  stepGraceAfterEdit: 40,
  hardStepMultiplier: 2,
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
    maxRepeatCalls: num(file.maxRepeatCalls) ?? DEFAULT_LIMITS.maxRepeatCalls,
    maxTestRuns: num(file.maxTestRuns) ?? DEFAULT_LIMITS.maxTestRuns,
    maxSameFileReads: num(file.maxSameFileReads) ?? DEFAULT_LIMITS.maxSameFileReads,
    maxExploreBeforeGraph: num(file.maxExploreBeforeGraph) ?? DEFAULT_LIMITS.maxExploreBeforeGraph,
    maxStepsBeforeFirstEdit: num(file.maxStepsBeforeFirstEdit) ?? DEFAULT_LIMITS.maxStepsBeforeFirstEdit,
    maxExploreSinceLastEdit: num(file.maxExploreSinceLastEdit) ?? DEFAULT_LIMITS.maxExploreSinceLastEdit,
    autoNudges: num(file.autoNudges) ?? DEFAULT_LIMITS.autoNudges,
    maxProviderRetries:
      num(file.maxProviderRetries) ?? num(env.ORCH_MAX_PROVIDER_RETRIES) ?? DEFAULT_LIMITS.maxProviderRetries,
    maxStepContextTokens: num(file.maxStepContextTokens) ?? DEFAULT_LIMITS.maxStepContextTokens,
    stepGraceAfterEdit: num(file.stepGraceAfterEdit) ?? DEFAULT_LIMITS.stepGraceAfterEdit,
    hardStepMultiplier: num(file.hardStepMultiplier) ?? DEFAULT_LIMITS.hardStepMultiplier,
  };
}

/** Tokens the model had to read: fresh input plus context served from cache. */
export function readTokens(u: Usage): number {
  return u.inputTokens + u.cacheReadTokens;
}

export function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}
