import type { Policy } from "./policy.js";
import type { Action } from "./settings.js";

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

  const put = (key: string, pattern: string, action: Action) => {
    let b = buckets.get(key);
    if (!b) {
      b = { "*": "ask" };
      buckets.set(key, b);
    }
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

  for (const root of policy.roots) {
    (perm.external_directory as Record<string, Action>)[`${root}/**`] = "allow";
  }

  for (const [key, b] of buckets) {
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
  return ["--mode", allowsEdit ? "accept-edits" : "plan"];
}