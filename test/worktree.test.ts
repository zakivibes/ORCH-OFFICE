import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../src/core/worktree.js";

process.env.GIT_CEILING_DIRECTORIES = tmpdir();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-wt-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "file.txt"), "original\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("isRepo distinguishes a repository from a plain directory", async () => {
  const m = new WorktreeManager();
  const plain = mkdtempSync(join(tmpdir(), "orch-plain-"));
  assert.equal(await m.isRepo(repo()), true);
  assert.equal(await m.isRepo(plain), false);
});

test("a worktree isolates the agent's edits from the main checkout", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  const wt = await m.create(dir, "feature", "sess-1");

  assert.ok(existsSync(wt.path));
  assert.equal(wt.branch, "orch/feature");

  // The agent edits inside the worktree only.
  writeFileSync(join(wt.path, "file.txt"), "CHANGED\n");

  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "original\n");
  assert.equal(readFileSync(join(wt.path, "file.txt"), "utf8"), "CHANGED\n");

  // git agrees: two worktrees, different contents.
  const list = git(dir, "worktree", "list");
  assert.match(list, /orch\/feature/);

  await m.discard(wt, true);
});

test("diff sees uncommitted edits (agents rarely commit)", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  const wt = await m.create(dir, "uncommitted", "sess-2");
  writeFileSync(join(wt.path, "file.txt"), "EDITED BY AGENT\n");

  const files = await m.changedFiles(wt);
  assert.deepEqual(files, ["file.txt"]);

  const patch = await m.diff(wt);
  assert.match(patch, /-original/);
  assert.match(patch, /\+EDITED BY AGENT/);

  assert.equal(await m.isDirty(wt), true);
  await m.discard(wt, true);
});

test("a clean worktree reports no changes", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  const wt = await m.create(dir, "clean", "sess-3");
  assert.deepEqual(await m.changedFiles(wt), []);
  assert.equal(await m.isDirty(wt), false);
  await m.discard(wt, true);
});

test("merge squashes agent work into the base checkout", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  const wt = await m.create(dir, "merged", "sess-4");
  writeFileSync(join(wt.path, "file.txt"), "MERGED CONTENT\n");

  await m.merge(wt, "squash");

  // The base checkout now has the agent's content, staged.
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "MERGED CONTENT\n");
  await m.discard(wt, true);
});

test("the lock file is excluded from git so it cannot reach a commit", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  const wt = await m.create(dir, "excluded", "sess-5");
  writeFileSync(join(wt.path, "file.txt"), "REAL CHANGE\n");

  const files = await m.changedFiles(wt);
  assert.deepEqual(files, ["file.txt"], "the lock file must not show up as a change");

  const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /\.orch-lock/);

  await m.discard(wt, true);
});

test("discard refuses while a live process holds the worktree", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  const wt = await m.create(dir, "locked", "sess-6");

  // process.pid is the test runner, which is very much alive.
  assert.equal(m.isLocked(wt.path), true);
  const refused = await m.discard(wt, false);
  assert.equal(refused.removed, false);
  assert.match(refused.reason ?? "", /live agent/);
  assert.ok(existsSync(wt.path), "worktree must survive a refused discard");

  // A dead lock is reclaimable.
  m.writeLock(wt.path, { pid: 999_999_999, sessionId: "sess-6", createdAt: Date.now() });
  assert.equal(m.isLocked(wt.path), false);
  const forced = await m.discard(wt, false);
  assert.equal(forced.removed, true);
});

test("sweep removes worktrees from dead agents but keeps live ones", async () => {
  const dir = repo();
  const m = new WorktreeManager();

  const live = await m.create(dir, "alive", "sess-live");
  const dead = await m.create(dir, "dead", "sess-dead");
  // Simulate a crash: the owning process is gone.
  m.writeLock(dead.path, { pid: 999_999_999, sessionId: "sess-dead", createdAt: Date.now() });

  const result = await m.sweep(dir);
  assert.ok(result.removed.includes(dead.path), "dead worktree should be swept");
  assert.ok(result.skipped.includes(live.path), "live worktree must be kept");

  assert.ok(existsSync(live.path));
  assert.equal(existsSync(dead.path), false);
  await m.discard(live, true);
});

test("sweep is a no-op outside a repository", async () => {
  const m = new WorktreeManager();
  const plain = mkdtempSync(join(tmpdir(), "orch-plain2-"));
  const r = await m.sweep(plain);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.skipped, []);
});

test("branch names are sanitised", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  const wt = await m.create(dir, "../../escape attempt/../x", "sess-7");
  assert.ok(!wt.branch.includes(".."), "git rejects refs containing ..");
  assert.match(wt.branch, /^orch\/[A-Za-z0-9][A-Za-z0-9._-]*$/, `unusable ref: ${wt.branch}`);
  assert.ok(wt.path.startsWith(join(dir, ".orch")), "path must stay inside the repo");
  await m.discard(wt, true);
});

test("names git dislikes fall back to a hash", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  for (const bad of ["thing.lock", "..", "-", "@{weird}"]) {
    const wt = await m.create(dir, bad, `sess-${bad}`);
    assert.match(wt.branch, /^orch\/[A-Za-z0-9][A-Za-z0-9._-]*$/, `unusable ref for ${bad}: ${wt.branch}`);
    await m.discard(wt, true);
  }
});

test("creating a worktree twice for the same name fails cleanly", async () => {
  const dir = repo();
  const m = new WorktreeManager();
  const wt = await m.create(dir, "dupe", "sess-8");
  await assert.rejects(() => m.create(dir, "dupe", "sess-9"), /already exists/);
  await m.discard(wt, true);
});

test("repoRoot resolves the top level from a subdirectory", async () => {
  const dir = repo();
  mkdirSync(join(dir, "nested", "deep"), { recursive: true });
  const m = new WorktreeManager();
  const root = await m.repoRoot(join(dir, "nested", "deep"));
  assert.equal(root, git(dir, "rev-parse", "--show-toplevel").trim());
});