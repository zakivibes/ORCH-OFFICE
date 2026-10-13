import { homedir } from "node:os";
import { resolve, isAbsolute, relative, sep } from "node:path";
import {
  resolvePermissions,
  decide,
  toActionRules,
  matchesArg,
  type Action,
  type Rule,
  type ResolvedPermissions,
} from "./settings.js";

export interface PolicyInput {
  projectDir: string;
  /** Directories Claude Code granted this session, from roots/list. */
  roots: string[];
  /** Session id, used for audit. */
  sessionLabel?: string;
}

export interface NarrowRequest {
  /** e.g. ["Bash(git *)"]. Only ever subtracted, never added. */
  deny?: string[];
  /** e.g. ["Edit"]. Subtracts the whole tool. */
  disableTools?: string[];
}

export interface Decision {
  action: Action;
  reason: string;
}

export class Policy {
  readonly resolved: ResolvedPermissions;
  readonly roots: string[];
  readonly projectDir: string;
  private readonly extraDeny: Rule[] = [];
  private readonly disabled: Set<string> = new Set();

  constructor(input: PolicyInput) {
    this.projectDir = resolve(input.projectDir);
    this.resolved = resolvePermissions(this.projectDir);
    this.roots = dedupe([this.projectDir, ...input.roots.map((r) => resolve(r))]);
  }

  /**
   * Apply a caller-supplied narrowing request. Arguments can only remove
   * capability: a "deny" here always wins over an "allow" in settings, and a
   * disabled tool cannot be re-enabled. This is what stops the driving model
   * from widening its own permissions by asking for them.
   */
  /** Caller narrowings (e.g. Bash(ssh *)), so adapters can enforce them natively. */
  narrowedDeny(): readonly Rule[] {
    return this.extraDeny;
  }

  narrow(req: NarrowRequest | undefined): this {
    if (!req) return this;
    for (const raw of req.deny ?? []) {
      const open = raw.indexOf("(");
      const tool = open === -1 ? raw.trim() : raw.slice(0, open).trim();
      const arg = open === -1 ? "" : raw.slice(open + 1, raw.lastIndexOf(")"));
      this.extraDeny.push({ tool, arg, raw });
    }
    for (const t of req.disableTools ?? []) this.disabled.add(t.trim());
    return this;
  }

  /** deny > ask > allow, with the narrowing overlay applied on top. */
  decide(tool: string, arg = ""): Decision {
    if (this.disabled.has(tool)) {
      return { action: "deny", reason: "tool disabled by caller narrowing" };
    }

    const { allow, ask, deny } = toActionRules(this.resolved);
    const scopedDeny = deny.filter(({ rule }) => rule.tool === tool && (!rule.arg || matchesArg(arg, rule.arg)));
    if (scopedDeny.length > 0) {
      return { action: "deny", reason: `denied by ${scopedDeny.map((d) => d.rule.raw).join(", ")}` };
    }

    const narrowing = this.extraDeny.filter((r) => r.tool === tool && (!r.arg || matchesArg(arg, r.arg)));
    if (narrowing.length > 0) {
      return { action: "deny", reason: `denied by caller narrowing: ${narrowing.map((r) => r.raw).join(", ")}` };
    }

    const asked = ask.filter(({ rule }) => rule.tool === tool && (!rule.arg || matchesArg(arg, rule.arg)));
    if (asked.length > 0) {
      return { action: "ask", reason: `requires approval by ${asked.map((a) => a.rule.raw).join(", ")}` };
    }

    const allowed = allow.filter(({ rule }) => rule.tool === tool && (!rule.arg || matchesArg(arg, rule.arg)));
    if (allowed.length > 0) {
      return { action: "allow", reason: `allowed by ${allowed.map((a) => a.rule.raw).join(", ")}` };
    }

    const fallback = this.fallbackFor(tool);
    return { action: fallback.action, reason: fallback.reason };
  }

  private fallbackFor(tool: string): Decision {
    if (this.isMutating(tool)) {
      return {
        action: "ask",
        reason: "mutating tool with no matching allow rule; defaulting to ask",
      };
    }
    return { action: "allow", reason: "read-only tool with no matching rule; defaulting to allow" };
  }

  private isMutating(tool: string): boolean {
    return ["Edit", "Write", "NotebookEdit", "Bash", "MultiEdit"].includes(tool);
  }

  /** True when `target` is inside a directory Claude Code granted. */
  isWithinRoots(target: string): boolean {
    const abs = isAbsolute(target) ? resolve(target) : resolve(this.projectDir, target);
    return this.roots.some((root) => {
      const rel = relative(root, abs);
      return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel));
    });
  }

  /** Human-readable dump for `orch roots` / `orch policy`. */
  describe() {
    const list = (rules: Rule[]) =>
      rules.length ? rules.map((r) => r.raw).join("\n  ") : "(none)";
    return [
      `project:   ${this.projectDir}`,
      `mode:      ${this.resolved.defaultMode}`,
      `roots:\n  ${this.roots.join("\n  ")}`,
      `sources:   ${this.resolved.sources.join("\n  ") || "(none)"}`,
      `allow:\n  ${list(this.resolved.allow)}`,
      `ask:\n  ${list(this.resolved.ask)}`,
      `deny:\n  ${list(this.resolved.deny)}`,
      this.extraDeny.length ? `narrowed:\n  ${this.extraDeny.map((r) => r.raw).join("\n  ")}` : "narrowed: (none)",
      this.disabled.size ? `disabled tools: ${[...this.disabled].join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const k = resolve(p);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

export { homedir };