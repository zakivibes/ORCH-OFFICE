import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WORKTREE_ROOT = ".orch";
export const LOCK_FILE = ".orch-lock";

export interface Worktree {
  path: string;
  branch: string;
  repoRoot: string;
  sessionId: string;
  createdAt: number;
}

export interface LockInfo {
  pid: number;
  sessionId: string;
  createdAt: number;
}

/**
 * git worktree isolation, one tree per session.
 *
 * The pattern is standard across claude-squad, magic-cc-codex-worker and
 * subagent-worktree-mcp: parallel agents that share a checkout overwrite each
 * other's files. A worktree gives each agent its own directory and branch, so
 * a failed run costs one `git worktree remove` and nothing else.
 *
 * Note that a worktree isolates *files*, not ports, databases or background
 * processes. Runtime collisions are a separate concern.
 */
export class WorktreeManager {
  constructor(private readonly baseDirName = WORKTREE_ROOT) {}

  private root(repoRoot: string): string {
    return join(repoRoot, this.baseDirName);
  }

  async isRepo(dir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async repoRoot(dir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async currentBranch(dir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  /**
   * Derive a branch/directory name that git will actually accept.
   *
   * git check-ref-format rejects anything with "..", a component starting with
   * ".", a trailing ".lock", control characters, and a few other shapes. Rather
   * than reimplement those rules, sanitize hard and then let git be the judge;
   * if it still refuses, fall back to a short hash of the name.
   */
  private async safeName(repoRoot: string, name: string): Promise<string> {
    const cleaned =
      name
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\.\.+/g, ".")
        .replace(/\.lock$/i, "")
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .replace(/^[.\-]+/, "")
        .slice(0, 48)
        .replace(/[.\-]+$/, "") || "task";

    const valid = await this.isValidRef(repoRoot, `orch/${cleaned}`);
    if (valid) return cleaned;

    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
    return `task-${digest}`;
  }

  private async isValidRef(repoRoot: string, ref: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["check-ref-format", ref], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Keep orchestrator bookkeeping out of the agent's commits.
   *
   * `.git/info/exclude` is per-repository and shared by every worktree, and
   * unlike .gitignore it is never itself committed -- so the lock file cannot
   * leak into a diff review or a squash-merge.
   */
  async excludeFromGit(repoRoot: string): Promise<void> {
    const excludePath = join(repoRoot, ".git", "info", "exclude");
    try {
      mkdirSync(join(repoRoot, ".git", "info"), { recursive: true });
      let current = "";
      try {
        current = readFileSync(excludePath, "utf8");
      } catch {
        /* create it */
      }
      const wanted = [`${this.baseDirName}/`, LOCK_FILE];
      const missing = wanted.filter((w) => !current.split("\n").some((l) => l.trim() === w));
      if (!missing.length) return;
      const next = current && !current.endsWith("\n") ? `${current}\n` : current;
      writeFileSync(excludePath, `${next}# orchestrator bookkeeping\n${missing.join("\n")}\n`);
    } catch {
      // A repo without a .git dir (worktree of a worktree) simply has no
      // exclude file; the lock still works, it just may show up in status.
    }
  }

  async create(repoRoot: string, name: string, sessionId: string): Promise<Worktree> {
    const safe = await this.safeName(repoRoot, name);
    const branch = `orch/${safe}`;
    const dir = join(this.root(repoRoot), safe);
    mkdirSync(this.root(repoRoot), { recursive: true });

    if (existsSync(dir)) {
      throw new Error(`worktree path already exists: ${dir}`);
    }

    await this.git(["worktree", "add", dir, "-b", branch], repoRoot);
    await this.excludeFromGit(repoRoot);
    this.writeLock(dir, { pid: process.pid, sessionId, createdAt: Date.now() });

    return { path: dir, branch, repoRoot, sessionId, createdAt: Date.now() };
  }

  writeLock(dir: string, lock: LockInfo): void {
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify(lock));
  }

  readLock(dir: string): LockInfo | null {
    try {
      const raw = readFileSync(join(dir, LOCK_FILE), "utf8");
      const parsed = JSON.parse(raw) as LockInfo;
      return typeof parsed.pid === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  clearLock(dir: string): void {
    try {
      unlinkSync(join(dir, LOCK_FILE));
    } catch {
      /* already gone */
    }
  }

  /** A lock whose pid is still alive means a live agent still owns the tree. */
  isLocked(dir: string): boolean {
    const lock = this.readLock(dir);
    if (!lock) return false;
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Unified diff of everything the agent produced against its base.
   *
   * Agents usually edit files without committing, so this compares the base
   * commit to the *working tree* (not to HEAD). Diffing base...HEAD alone
   * reports "no changes" for an agent that did exactly what it was asked.
   */
  async diff(wt: Worktree, base?: string): Promise<string> {
    const baseRef = base ?? (await this.mergeBase(wt.repoRoot)) ?? "HEAD";
    try {
      return await this.git(["diff", baseRef], wt.path);
    } catch {
      return "";
    }
  }

  async changedFiles(wt: Worktree, base?: string): Promise<string[]> {
    const baseRef = base ?? (await this.mergeBase(wt.repoRoot)) ?? "HEAD";
    try {
      const out = await this.git(["diff", "--name-only", baseRef], wt.path);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** True when the agent actually changed anything. */
  async isDirty(wt: Worktree): Promise<boolean> {
    try {
      const out = await this.git(["status", "--porcelain"], wt.path);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  async hasCommits(wt: Worktree, base?: string): Promise<boolean> {
    const baseRef = base ?? (await this.mergeBase(wt.repoRoot)) ?? "HEAD";
    try {
      const out = await this.git(["log", "--oneline", `${baseRef}..HEAD`], wt.path);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async mergeBase(repoRoot: string): Promise<string | null> {
    try {
      const branch = await this.currentBranch(repoRoot);
      const ref = branch && branch !== "HEAD" ? branch : "main";
      const out = await this.git(["merge-base", "HEAD", ref], repoRoot);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Merge the agent's branch back. `squash` collapses the work into one
   * commit, which keeps the main branch history readable after a fan-out.
   */
  async merge(wt: Worktree, mode: "squash" | "merge" = "squash"): Promise<string> {
    const branch = await this.currentBranch(wt.repoRoot);
    if (!branch) throw new Error("cannot merge into a detached HEAD");

    if (!(await this.branchExists(wt.repoRoot, wt.branch))) {
      throw new Error(
        `branch ${wt.branch} no longer exists (it was merged or discarded); nothing to merge`,
      );
    }
    if (!existsSync(wt.path)) {
      throw new Error(`worktree ${wt.path} is gone; nothing to merge`);
    }

    // Agents rarely commit, and `git merge --squash` only sees commits. Commit
    // their work on the worktree branch first, otherwise the merge is a no-op.
    if (await this.isDirty(wt)) {
      await this.git(["add", "-A"], wt.path);
      await this.git(
        ["commit", "-m", `orch: changes from session ${wt.sessionId} on ${branch}`],
        wt.path,
      );
    }

    if (mode === "squash") {
      await this.git(["merge", "--squash", wt.branch], wt.repoRoot);
      return "squashed; commit the staged changes to finish";
    }
    await this.git(["merge", "--no-ff", wt.branch, "-m", `merge ${wt.branch} from orch session ${wt.sessionId}`], wt.repoRoot);
    return `merged ${wt.branch} into ${branch}`;
  }

  async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", `${branch}^{commit}`], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  /** Remove the worktree and its branch. Refuses while a live agent holds it. */
  async discard(wt: Worktree, force = false): Promise<{ removed: boolean; reason?: string }> {
    if (!force && this.isLocked(wt.path)) {
      return { removed: false, reason: "a live agent still holds this worktree; close the session first" };
    }
    this.clearLock(wt.path);
    try {
      await this.git(["worktree", "remove", "--force", wt.path], wt.repoRoot);
    } catch {
      // git refuses if the directory is gone or already pruned.
      if (existsSync(wt.path)) {
        rmSync(wt.path, { recursive: true, force: true });
      }
    }
    try {
      await this.git(["branch", "-D", wt.branch], wt.repoRoot);
    } catch {
      /* branch may already be gone or merged */
    }
    return { removed: true };
  }

  async list(repoRoot: string): Promise<Worktree[]> {
    const dir = this.root(repoRoot);
    if (!existsSync(dir)) return [];
    const out: Worktree[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const lock = this.readLock(path);
      out.push({
        path,
        branch: `orch/${name}`,
        repoRoot,
        sessionId: lock?.sessionId ?? "",
        createdAt: lock?.createdAt ?? 0,
      });
    }
    return out;
  }

  /**
   * Remove worktrees whose owning process is gone, plus branches orphaned by a
   * crash. Runs at daemon start so an unclean exit cannot leak trees forever.
   */
  async sweep(repoRoot: string): Promise<{ removed: string[]; skipped: string[] }> {
    const removed: string[] = [];
    const skipped: string[] = [];
    if (!(await this.isRepo(repoRoot))) return { removed, skipped };

    for (const wt of await this.list(repoRoot)) {
      if (this.isLocked(wt.path)) {
        skipped.push(wt.path);
        continue;
      }
      const res = await this.discard(wt, true);
      if (res.removed) removed.push(wt.path);
      else skipped.push(wt.path);
    }
    await this.git(["worktree", "prune"], repoRoot).catch(() => "");
    return { removed, skipped };
  }
}

export function worktreeFor(base: string, name: string): string {
  return join(resolve(base), WORKTREE_ROOT, basename(name));
}