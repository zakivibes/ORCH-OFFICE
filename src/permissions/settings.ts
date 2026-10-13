import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Action = "allow" | "ask" | "deny";

/**
 * Claude Code permission rule, e.g. "Bash(git *)", "Read(./.env)", "Edit",
 * "WebFetch(domain:example.com)". Bare "Edit" with no parens is also valid.
 */
export interface Rule {
  tool: string;
  /** Everything inside the parens, verbatim. Empty string when unscoped. */
  arg: string;
  raw: string;
}

export interface SettingsShape {
  permissions?: {
    defaultMode?: string;
    allow?: string[];
    deny?: string[];
    ask?: string[];
    additionalDirectories?: string[];
  };
  [k: string]: unknown;
}

export interface ResolvedPermissions {
  defaultMode: string;
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
  additionalDirectories: string[];
  /** Settings files that were actually read, in precedence order. */
  sources: string[];
}

/** Precedence highest-first. Managed settings resolve from several locations. */
function managedPaths(): string[] {
  const home = homedir();
  return [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/etc/claude-code/managed-settings.json",
    join(home, "Library/Application Support/ClaudeCode/managed-settings.json"),
  ];
}

function readJson(path: string): SettingsShape | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SettingsShape;
  } catch {
    // A malformed settings file is skipped, matching Claude Code's own
    // "Settings Warning" behaviour rather than aborting the orchestrator.
    return null;
  }
}

export function parseRule(raw: string): Rule {
  const open = raw.indexOf("(");
  if (open === -1) return { tool: raw.trim(), arg: "", raw };
  const close = raw.lastIndexOf(")");
  const tool = raw.slice(0, open).trim();
  const arg = close > open ? raw.slice(open + 1, close) : raw.slice(open + 1);
  return { tool, arg, raw };
}

export function parseRules(list: string[] | undefined): Rule[] {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => typeof r === "string" && r.trim().length > 0).map(parseRule);
}

/**
 * Resolve the effective Claude Code permission set for a project directory.
 *
 * Precedence (highest first): managed, command line, project local, shared
 * project, user. Lists MERGE across levels rather than overriding, and a
 * deny beats an ask which beats an allow.
 */
export function resolvePermissions(
  projectDir: string,
  cliSettings?: SettingsShape,
): ResolvedPermissions {
  const home = homedir();
  const layers: Array<{ path: string; data: SettingsShape | null }> = [];

  for (const p of managedPaths()) layers.push({ path: p, data: readJson(p) });
  if (cliSettings) layers.push({ path: "<--settings>", data: cliSettings });
  layers.push({
    path: join(projectDir, ".claude", "settings.local.json"),
    data: readJson(join(projectDir, ".claude", "settings.local.json")),
  });
  layers.push({
    path: join(projectDir, ".claude", "settings.json"),
    data: readJson(join(projectDir, ".claude", "settings.json")),
  });
  layers.push({
    path: join(home, ".claude", "settings.json"),
    data: readJson(join(home, ".claude", "settings.json")),
  });

  const allow: Rule[] = [];
  const ask: Rule[] = [];
  const deny: Rule[] = [];
  const additionalDirectories: string[] = [];
  let defaultMode: string | null = null;
  const sources: string[] = [];

  for (const layer of layers) {
    if (!layer.data?.permissions) continue;
    sources.push(layer.path);
    const perms = layer.data.permissions;

    // Layers are visited highest-precedence first (managed, --settings,
    // project local, project shared, user), so the FIRST value wins. Letting
    // a later, lower-precedence layer overwrite would invert the real order.
    if (typeof perms.defaultMode === "string" && defaultMode === null) {
      // Claude Code ignores 'auto' and 'bypassPermissions' from project and
      // local settings files; mirror that rather than honouring them.
      const isUserOrManaged =
        layer.path === "<--settings>" ||
        layer.path === join(home, ".claude", "settings.json") ||
        managedPaths().includes(layer.path);
      if (isUserOrManaged || (perms.defaultMode !== "auto" && perms.defaultMode !== "bypassPermissions")) {
        defaultMode = perms.defaultMode;
      }
    }

    allow.push(...parseRules(perms.allow));
    ask.push(...parseRules(perms.ask));
    deny.push(...parseRules(perms.deny));
    if (Array.isArray(perms.additionalDirectories)) {
      additionalDirectories.push(...perms.additionalDirectories.filter((d) => typeof d === "string"));
    }
  }

  return { defaultMode: defaultMode ?? "default", allow, ask, deny, additionalDirectories, sources };
}

export interface ActionRule {
  rule: Rule;
  action: Action;
}

/** deny > ask > allow. Returns null when no rule matches. */
export function decide(rules: ActionRule[], tool: string, arg: string): Action | null {
  let best: Action | null = null;
  let rank = -1;
  const weight: Record<Action, number> = { deny: 3, ask: 2, allow: 1 };

  for (const { rule, action } of rules) {
    if (rule.tool !== tool) continue;
    if (rule.arg && !matchesArg(arg, rule.arg)) continue;
    if (weight[action] > rank) {
      rank = weight[action];
      best = action;
    }
  }
  return best;
}

export function toActionRules(res: ResolvedPermissions): {
  allow: ActionRule[];
  ask: ActionRule[];
  deny: ActionRule[];
} {
  return {
    allow: res.allow.map((rule) => ({ rule, action: "allow" as const })),
    ask: res.ask.map((rule) => ({ rule, action: "ask" as const })),
    deny: res.deny.map((rule) => ({ rule, action: "deny" as const })),
  };
}

/**
 * Claude rule patterns are prefix-globs: "git *" matches "git status",
 * "./.env.*" matches "./.env.local". We anchor the whole argument so a rule
 * for "git *" cannot accidentally authorise "rm -rf" or "git-evil".
 */
export function matchesArg(value: string, pattern: string): boolean {
  if (pattern === "") return true;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" || c === "?" ? c : "\\" + c));
  const rx = new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return rx.test(value);
}