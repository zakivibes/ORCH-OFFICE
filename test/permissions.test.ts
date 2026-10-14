import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Policy } from "../src/permissions/policy.js";
import { resolvePermissions, decide, toActionRules, matchesArg, parseRule } from "../src/permissions/settings.js";
import { toOpencodePermission, toClaudeFlags, toAgyFlags } from "../src/permissions/translate.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "orch-test-"));
}

function writeSettings(dir: string, rel: string, body: unknown) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2));
}

test("parseRule splits tool and argument", () => {
  assert.deepEqual(parseRule("Bash(git *)"), { tool: "Bash", arg: "git *", raw: "Bash(git *)" });
  assert.deepEqual(parseRule("Edit"), { tool: "Edit", arg: "", raw: "Edit" });
  assert.deepEqual(parseRule("Read(./.env)"), { tool: "Read", arg: "./.env", raw: "Read(./.env)" });
});

test("rule globs are anchored so a prefix rule cannot over-authorise", () => {
  assert.equal(matchesArg("git status", "git *"), true);
  assert.equal(matchesArg("git push --force", "git *"), true);
  // The space in "git *" is literal, so a bare "git" needs its own rule.
  // Erring toward "ask" here is the safe direction.
  assert.equal(matchesArg("git", "git *"), false);
  // The important ones: "git *" must not authorise anything else.
  assert.equal(matchesArg("rm -rf /", "git *"), false);
  assert.equal(matchesArg("git-evil-run", "git *"), false);
  assert.equal(matchesArg("curl evil.test", "git *"), false);
  assert.equal(matchesArg("./.env.local", "./.env.*"), true);
});

test("deny beats ask beats allow", () => {
  const res = {
    defaultMode: "default",
    allow: [{ tool: "Bash", arg: "git *", raw: "Bash(git *)" }],
    ask: [{ tool: "Bash", arg: "npm *", raw: "Bash(npm *)" }],
    deny: [{ tool: "Bash", arg: "git push *", raw: "Bash(git push *)" }],
    additionalDirectories: [],
    sources: [],
  };
  const all = toActionRules(res);
  assert.equal(decide(all.allow, "Bash", "git status"), "allow");
  assert.equal(decide(all.ask, "Bash", "npm install"), "ask");
  assert.equal(decide(all.deny, "Bash", "git push origin main"), "deny");
});

test("caller narrowing can only subtract, never widen", () => {
  const dir = scratch();
  writeSettings(dir, ".claude/settings.json", {
    permissions: { allow: ["Bash(git *)"], defaultMode: "acceptEdits" },
  });

  const p = new Policy({ projectDir: dir, roots: [dir] });
  // settings allow git
  assert.equal(p.decide("Bash", "git status").action, "allow");

  // a caller asking for MORE than settings grant gets nothing extra
  const wider = new Policy({ projectDir: dir, roots: [dir] });
  assert.equal(wider.decide("Bash", "curl https://evil.test").action, "ask");

  // narrowing removes capability
  const narrower = new Policy({ projectDir: dir, roots: [dir] }).narrow({ deny: ["Bash(git *)"] });
  assert.equal(narrower.decide("Bash", "git status").action, "deny");

  // disabling a tool wins over a settings allow
  const disabled = new Policy({ projectDir: dir, roots: [dir] }).narrow({ disableTools: ["Edit"] });
  assert.equal(disabled.decide("Edit", "x.ts").action, "deny");
});

test("mutating tools default to ask, read-only tools default to allow", () => {
  const p = new Policy({ projectDir: scratch(), roots: [] });
  assert.equal(p.decide("Bash", "ls").action, "ask");
  assert.equal(p.decide("Edit", "a.ts").action, "ask");
  assert.equal(p.decide("Read", "a.ts").action, "allow");
});

test("worker paths are confined to the roots Claude Code granted", () => {
  const root = scratch();
  const p = new Policy({ projectDir: root, roots: [root] });
  assert.equal(p.isWithinRoots(join(root, "src", "a.ts")), true);
  assert.equal(p.isWithinRoots(root), true);
  assert.equal(p.isWithinRoots("/etc/passwd"), false);
  assert.equal(p.isWithinRoots("/Users/someone/.ssh/id_rsa"), false);
  // a sibling dir with a shared prefix must not pass
  assert.equal(p.isWithinRoots(root + "-evil/x"), false);
});

test("a deny rule in settings beats the caller's allow intent", () => {
  const dir = scratch();
  writeSettings(dir, ".claude/settings.json", {
    permissions: { deny: ["Read(./.env)"] },
  });
  const p = new Policy({ projectDir: dir, roots: [dir] });
  const d = p.decide("Read", "./.env");
  assert.equal(d.action, "deny");
});

test("claude flags pass allow/deny rules straight through", () => {
  const dir = scratch();
  writeSettings(dir, ".claude/settings.json", {
    permissions: { allow: ["Bash(git *)"], deny: ["Read(./.env)"], defaultMode: "plan" },
  });
  const p = new Policy({ projectDir: dir, roots: [dir] });
  const flags = toClaudeFlags(p);
  const allowed = flags[flags.indexOf("--allowedTools") + 1] ?? "";
  const denied = flags[flags.indexOf("--disallowedTools") + 1] ?? "";
  assert.ok(allowed.includes("Bash(git *)"));
  assert.ok(denied.includes("Read(./.env)"));
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "plan");
  // never let the worker answer its own permission prompts
  assert.equal(flags[flags.indexOf("--permission-prompts") + 1], "none");
});

test("opencode translation emits a catch-all first and confines external dirs", () => {
  const dir = scratch();
  writeSettings(dir, ".claude/settings.json", {
    permissions: { allow: ["Bash(git *)"], deny: ["Bash(rm *)"] },
  });
  const p = new Policy({ projectDir: dir, roots: [dir] });
  const { permission } = toOpencodePermission(p) as { permission: Record<string, any> };

  // last match wins, so the catch-all must be first
  assert.equal(Object.keys(permission.bash)[0], "*");
  assert.equal(permission.bash["git *"], "allow");
  assert.equal(permission.bash["rm *"], "deny");
  // webfetch/websearch must be plain strings for opencode's schema
  assert.equal(typeof permission.webfetch, "string");
  assert.equal(typeof permission.websearch, "string");
  // .env stays protected even though Claude's rules did not mention it
  assert.equal(permission.read["*.env"], "deny");
  assert.equal(permission.external_directory["*"], "deny");
  assert.equal(permission.external_directory[`${dir}/**`], "allow");
  assert.equal(permission.question, "deny", "nobody can answer the question tool mid-turn");
});

test("agy mode follows the resolved Claude Code defaultMode", () => {
  // defaultMode is read from the real user settings too, so each case sets it
  // explicitly rather than relying on an ambient value.
  const dir = scratch();
  writeSettings(dir, ".claude/settings.json", { permissions: { defaultMode: "plan" } });
  const planned = toAgyFlags(new Policy({ projectDir: dir, roots: [dir] }));
  assert.equal(planned[planned.indexOf("--mode") + 1], "plan");

  writeSettings(dir, ".claude/settings.json", { permissions: { defaultMode: "auto" } });
  const auto = toAgyFlags(new Policy({ projectDir: dir, roots: [dir] }));
  assert.equal(auto[auto.indexOf("--mode") + 1], "accept-edits");

  // An explicit Edit allow wins regardless of the mode.
  writeSettings(dir, ".claude/settings.json", {
    permissions: { defaultMode: "plan", allow: ["Edit"] },
  });
  const allowed = toAgyFlags(new Policy({ projectDir: dir, roots: [dir] }));
  assert.equal(allowed[allowed.indexOf("--mode") + 1], "accept-edits");

  // An explicit Edit deny is final.
  writeSettings(dir, ".claude/settings.json", {
    permissions: { defaultMode: "bypassPermissions", deny: ["Edit"] },
  });
  const denied = toAgyFlags(new Policy({ projectDir: dir, roots: [dir] }));
  assert.equal(denied[denied.indexOf("--mode") + 1], "plan");
});

test("malformed settings files are skipped rather than crashing resolution", () => {
  const dir = scratch();
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{ this is not json ");
  const res = resolvePermissions(dir);
  assert.equal(typeof res.defaultMode, "string");
});