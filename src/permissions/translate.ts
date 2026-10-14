import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Policy } from "./policy.js";
import type { Action } from "./settings.js";

/**
 * Owner opt-in (~/.orchestrator/config.json {"workerShell": true}): let
 * headless workers run shell commands when Claude Code itself runs
 * unattended. Neither agy nor opencode can prompt a human mid-turn, so without
 * this every command is auto-denied (agy) or hangs on an unanswered "ask"
 * (opencode). Read per spawn so it takes effect without a daemon restart.
 */
export function workerShellEnabled(policy: Policy): boolean {
  const mode = policy.resolved.defaultMode;
  if (!(mode === "auto" || mode === "bypassPermissions")) return false;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".orchestrator", "config.json"), "utf8")) as {
      workerShell?: boolean;
    };
    return cfg.workerShell === true;
  } catch {
    return false;
  }
}

/**
 * Owner opt-in (~/.orchestrator/config.json "workerMcp"): which MCP servers opencode workers get.
 *
 *   "workerMcp": {
 *     "disable": ["Blender", "Roblox_Studio"],             // servers from opencode.json to switch off
 *     "add": { "graphify": { "type": "local", "command": ["graphify-mcp"] } }
 *   }
 *
 * Every enabled MCP server's tool definitions ride along in EVERY request a worker makes, so a
 * server the worker never uses costs tokens on each step. Read per spawn; returns the opencode
 * `mcp` block to merge into the inline config, or undefined when nothing is configured.
 */
export function workerMcpConfig(): Record<string, unknown> | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".orchestrator", "config.json"), "utf8")) as {
      workerMcp?: { disable?: unknown; add?: unknown };
    };
    const w = cfg.workerMcp;
    if (!w || typeof w !== "object") return undefined;
    const mcp: Record<string, unknown> = {};
    if (Array.isArray(w.disable)) {
      for (const name of w.disable) if (typeof name === "string" && name) mcp[name] = { enabled: false };
    }
    if (w.add && typeof w.add === "object") {
      for (const [name, def] of Object.entries(w.add as Record<string, unknown>)) {
        if (def && typeof def === "object") mcp[name] = { enabled: true, ...(def as object) };
      }
    }
    return Object.keys(mcp).length ? mcp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extra environment for opencode workers, from `workerEnv` in ~/.orchestrator/config.json.
 * Used for opencode's own switches, e.g. OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 stops it
 * listing every installed Claude skill in each worker's prompt (a few thousand tokens a step).
 */
export function workerEnvConfig(): Record<string, string> {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".orchestrator", "config.json"), "utf8")) as {
      workerEnv?: unknown;
    };
    const out: Record<string, string> = {};
    if (cfg.workerEnv && typeof cfg.workerEnv === "object") {
      for (const [k, v] of Object.entries(cfg.workerEnv as Record<string, unknown>)) {
        if (/^[A-Z_][A-Z0-9_]*$/.test(k) && (typeof v === "string" || typeof v === "number")) out[k] = String(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Claude Code tool name -> opencode permission key. */
const CLAUDE_TO_OPENCODE: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  MultiEdit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Task: "task",
  Skill: "skill",
};

/**
 * opencode evaluates permission rules with "last match wins", so the catch-all
 * has to be emitted before any specific rule.
 */
export function toOpencodePermission(policy: Policy): Record<string, unknown> {
  const buckets = new Map<string, Record<string, Action>>();
  const explicitStar = new Set<string>();

  const put = (key: string, pattern: string, action: Action) => {
    let b = buckets.get(key);
    if (!b) {
      b = { "*": "ask" };
      buckets.set(key, b);
    }
    if (pattern === "*") explicitStar.add(key);
    b[pattern] = action;
  };

  for (const r of policy.resolved.deny) {
    const key = CLAUDE_TO_OPENCODE[r.tool];
    if (key) put(key, r.arg ? r.arg : "*", "deny");
  }
  for (const r of policy.resolved.ask) {
    const key = CLAUDE_TO_OPENCODE[r.tool];
    if (key) put(key, r.arg ? r.arg : "*", "ask");
  }
  for (const r of policy.resolved.allow) {
    const key = CLAUDE_TO_OPENCODE[r.tool];
    if (key) put(key, r.arg ? r.arg : "*", "allow");
  }

  // opencode defaults to permissive. Reads are safe; everything that mutates
  // defaults to ask. Path scoping mirrors the roots Claude Code granted.
  const perm: Record<string, unknown> = {
    "*": "ask",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    edit: { "*": "ask" },
    bash: { "*": "ask" },
    glob: { "*": "allow" },
    grep: { "*": "allow" },
    // webfetch/websearch take a plain action string in opencode's schema;
    // they are not among the permissions that accept granular object rules.
    webfetch: "ask",
    websearch: "ask",
    external_directory: { "*": "deny" },
  };
  const full = workerShellEnabled(policy);
  if (full) {
    // Owner opt-in: full permissions. opencode cannot ask a human mid-turn,
    // so "ask" would only hang. Deny rules (settings + caller narrowings) are
    // still emitted below as specific patterns and win, last match.
    perm["*"] = "allow";
    perm.bash = { "*": "allow" };
    perm.edit = { "*": "allow" };
    perm.webfetch = "allow";
    perm.websearch = "allow";
    for (const r of policy.narrowedDeny()) {
      const key = CLAUDE_TO_OPENCODE[r.tool];
      if (key) put(key, r.arg ? r.arg : "*", "deny");
    }
  }

  for (const root of policy.roots) {
    (perm.external_directory as Record<string, Action>)[`${root}/**`] = "allow";
  }

  for (const [key, b] of buckets) {
    // put() seeds each bucket with a default "*": "ask". Under full
    // permissions that default would re-introduce the hang for the whole
    // tool, so drop it unless a rule set "*" explicitly.
    if (full && !explicitStar.has(key)) delete b["*"];
    const existing = perm[key];
    perm[key] = typeof existing === "object" && existing !== null ? { ...existing, ...b } : b;
  }

  return { permission: perm };
}

/**
 * Claude Code rule syntax is identical to the worker's own, so allow/deny
 * pass straight through.
 */
export function toClaudeFlags(policy: Policy): string[] {
  const flags: string[] = [];

  const allow = policy.resolved.allow.map((r) => r.raw);
  if (allow.length) flags.push("--allowedTools", allow.join(","));

  const deny = [
    ...policy.resolved.deny.map((r) => r.raw),
    ...policy.resolved.ask.map((r) => r.raw),
  ];
  if (deny.length) flags.push("--disallowedTools", deny.join(","));

  const mode = mapClaudeMode(policy.resolved.defaultMode);
  if (mode) flags.push("--permission-mode", mode);

  // Never answer prompts from inside the worker: the orchestrator mediates.
  flags.push("--permission-prompts", "none");

  return flags;
}

function mapClaudeMode(mode: string): string | null {
  switch (mode) {
    case "acceptEdits":
    case "auto":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "dontAsk":
      return "dontAsk";
    case "manual":
      return "manual";
    default:
      return null;
  }
}

/**
 * agy exposes no per-rule allow/deny list, only a coarse execution mode. We
 * always spawn it read-only and mediate permission requests in-band, so the
 * narrowest possible surface is exposed to the CLI itself.
 */
export function toAgyFlags(policy: Policy): string[] {
  // agy has no per-rule allow/deny list, so the coarse execution mode is all
  // we can set. Honour Claude Code's resolved defaultMode first, because
  // "ask" is not a mode agy can express -- forcing plan mode for an "auto"
  // session makes the worker silently return empty replies when it reaches for
  // a tool. Only fall back to plan when the session is genuinely read-only.
  const explicit = policy.decide("Edit").action;
  const mode = policy.resolved.defaultMode;
  const modeAllowsEdits =
    mode === "auto" || mode === "acceptEdits" || mode === "bypassPermissions";
  const allowsEdit = explicit === "allow" || (explicit === "ask" && modeAllowsEdits);
  const flags = ["--mode", allowsEdit ? "accept-edits" : "plan"];
  // agy cannot express rule-level deny lists, so shell is all-or-nothing:
  // only with the owner's workerShell opt-in, and never when Bash is denied
  // outright. Narrowings like Bash(ssh *) must also be stated in the prompt.
  if (allowsEdit && workerShellEnabled(policy) && policy.decide("Bash").action !== "deny") {
    flags.push("--dangerously-skip-permissions");
  }
  return flags;
}