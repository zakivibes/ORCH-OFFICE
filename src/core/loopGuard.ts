import type { Limits } from "./limits.js";

/**
 * Tells a worker that is stuck apart from one that is just busy.
 *
 * A flat cap on tool calls stopped productive workers mid-edit (a big feature honestly needs a
 * few hundred calls) while the real loops it was meant for looked different: the same test
 * re-run hundreds of times, the same failing edit retried, one large file paged through dozens
 * of times. So the cap now bends for a turn that keeps changing files, and the loops are caught
 * by what they repeat:
 *
 *   - the identical call (tool + input) made more than `maxRepeatCalls` times;
 *   - more than `maxTestRuns` test runs in a row with no file changed in between: re-running
 *     unchanged code will not fix a failing test (fix-then-run cycles are progress and reset it);
 *   - the same file read more than `maxSameFileReads` times;
 *   - more than `maxRangeRereads` reads whose lines (sed -n 'A,Bp', head/tail, cat, read offset/limit) were
 *     mostly read already this turn: paging through one file again and again costs the whole context each time;
 *   - more than `maxExploreBeforeGraph` grep/read calls before the session's first `graphify` call:
 *     exploring by hand re-sends the whole context per step, the code graph answers in one;
 *   - more than `maxStepsBeforeFirstEdit` tool calls with nothing written yet: a turn that has
 *     read this much already knows enough to write its first file;
 *   - more than `maxExploreSinceLastEdit` read/grep calls since the turn's last edit: re-reading
 *     after writing (the post-compaction pattern) burns context without changing anything;
 *   - past `maxTurnSteps`, a turn may continue only while it is still editing (an edit within
 *     the last `stepGraceAfterEdit` calls), up to `maxTurnSteps * hardStepMultiplier`.
 *
 * Each reason says what to do instead, because the stop message is what the coordinator (and
 * the next session's hand-off) reads.
 */
export const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "patch", "apply_patch", "str_replace_based_edit_tool",
  // agy names: its file writes and generated images are progress too.
  "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "generate_image"]);
export const TEST_CMD = /\b(npm (run )?test|flutter test|dart test|node (--test )?tests?\/|jest|pytest|vitest|go test)\b/;
const READ_TOOLS = new Set(["read", "view", "view_file"]);
/** A shell command that writes a file: heredoc/redirect, sed -i, or a script that opens a file for writing. */
export const SHELL_WRITE = /(^|[;&|]\s*)(cat|tee) [^|]*>|sed -i|perl -pi|open\([^)]*['"]w['"]|\.write(_text)?\(|writeFileSync/;
const EXPLORE_TOOLS = new Set(["read", "view", "grep", "glob", "list", "ls",
  "view_file", "list_dir", "grep_search", "find_by_name"]);
const EXPLORE_CMD = /^\s*(cd [^;&]+(&&|;)\s*)?(rtk )?(grep|rg|sed -n|cat|head|tail|find|ls|wc)\b/;
const GRAPH_CMD = /\bgraphify (explain|query|path)\b/;

/** agy wraps a call's arguments as `{tool_info: {name, parameters}}`; the rules read the arguments. */
export function argsOf(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const info = i.tool_info as Record<string, unknown> | undefined;
  if (info && info.parameters && typeof info.parameters === "object") return info.parameters as Record<string, unknown>;
  return i;
}

export function commandOf(input: unknown): string {
  const i = argsOf(input);
  if (!i) return "";
  const c = i.command ?? i.CommandLine;
  return typeof c === "string" ? c : "";
}

export function fileOf(input: unknown): string {
  const i = argsOf(input);
  if (!i) return "";
  const f = i.filePath ?? i.file_path ?? i.path ?? i.AbsolutePath ?? i.TargetFile;
  return typeof f === "string" ? f : "";
}

/** The call's identity, without fields that vary between otherwise identical calls. */
function signature(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object" || Object.keys(input).length === 0) return null;
  // agy reports view_file without its line range, so paging through one big file in ranges
  // would look like the identical call; same-file reads have their own rule.
  if (READ_TOOLS.has(name)) return null;
  // agy reports a file edit with only its TargetFile, so successive edits to one file look identical;
  // a stuck edit loop shows up as no progress elsewhere (first-write and step limits), not here.
  if (EDIT_TOOLS.has(name)) return null;
  const { description: _d, workdir: _w, timeout: _t, ...rest } = input as Record<string, unknown>;
  return `${name} ${JSON.stringify(rest)}`;
}


/** A read of `file` covering lines [from, to] (inclusive); to = Infinity means the whole rest of the file. */
export interface RangeRead {
  file: string;
  from: number;
  to: number;
}

/** Line-range reads in a tool call: the read tool's offset/limit, or sed -n 'A,Bp' / head / tail / cat in a shell command. */
export function rangeReadsOf(name: string, input: unknown): RangeRead[] {
  const out: RangeRead[] = [];
  const a = argsOf(input);
  if (READ_TOOLS.has(name) && name !== "view_file") {
    const f = fileOf(input);
    if (f) {
      const off = Number(a?.offset ?? 0);
      const lim = Number(a?.limit ?? 0);
      out.push({ file: f, from: off > 0 ? off : 1, to: lim > 0 ? (off > 0 ? off : 1) + lim - 1 : Infinity });
    }
    return out;
  }
  const cmd = commandOf(input);
  if (!cmd) return out;
  for (const m of cmd.matchAll(/\bsed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(\S+)/g)) {
    out.push({ file: m[3]!, from: Number(m[1]), to: Number(m[2]) });
  }
  for (const m of cmd.matchAll(/\bhead\s+(?:-n\s*|-)(\d+)\s+(\S+)/g)) out.push({ file: m[2]!, from: 1, to: Number(m[1]) });
  for (const m of cmd.matchAll(/(?:^|[;&|]\s*)(?:rtk\s+)?cat\s+([^\s|;&<>]+)\s*(?:$|[;&|])/g)) {
    out.push({ file: m[1]!, from: 1, to: Infinity });
  }
  return out;
}

/** Share of [from, to] already covered by earlier reads of the same file (0..1). */
function coveredShare(read: RangeRead, seen: [number, number][]): number {
  // A whole-file read has no known length: after 100+ lines of that file were already read, it
  // repeats most of what is in context.
  if (read.to === Infinity) {
    const lines = seen.reduce((n, [f, t]) => n + (Math.min(t, 1_000_000) - f + 1), 0);
    return lines >= 100 ? 1 : 0;
  }
  const hi = Math.min(read.to, 1_000_000);
  const span = hi - read.from + 1;
  if (span <= 0) return 0;
  const parts = seen.map(([f, t]) => [Math.max(f, read.from), Math.min(t, hi)] as [number, number]).filter(([f, t]) => t >= f).sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let end = read.from - 1;
  for (const [f, t] of parts) {
    const start = Math.max(f, end + 1);
    if (t >= start) {
      covered += t - start + 1;
      end = t;
    }
  }
  return covered / span;
}

export class LoopGuard {
  private steps = 0;
  private lastEditStep = 0;
  private testRuns = 0;
  private lastTestStep = 0;
  private graphUsed = false;
  private exploreBeforeGraph = 0;
  private exploreSinceEdit = 0;
  private readonly seen = new Map<string, number>();
  private readonly fileReads = new Map<string, number>();
  private readonly rangesRead = new Map<string, [number, number][]>();
  private rangeRereads = 0;

  /** `graphAlreadyUsed`: the session called graphify in an earlier turn (the rule is per session). */
  constructor(private readonly limits: Limits, graphAlreadyUsed = false) {
    this.graphUsed = graphAlreadyUsed;
  }

  /** Whether this session has called graphify (this turn or an earlier one). */
  get usedGraph(): boolean {
    return this.graphUsed;
  }

  get stepCount(): number {
    return this.steps;
  }

  /** Records one tool call; returns why the turn must stop, or "" to let it run. */
  onToolCall(name: string, input: unknown): string {
    this.steps += 1;
    const l = this.limits;
    const tool = name.toLowerCase();
    const cmd = commandOf(input);

    const edited = EDIT_TOOLS.has(tool) || SHELL_WRITE.test(cmd);
    if (edited) {
      this.lastEditStep = this.steps;
      this.exploreSinceEdit = 0;
    }

    if (GRAPH_CMD.test(cmd)) this.graphUsed = true;
    if (!this.graphUsed && l.maxExploreBeforeGraph > 0 && (EXPLORE_TOOLS.has(tool) || EXPLORE_CMD.test(cmd))) {
      this.exploreBeforeGraph += 1;
      if (this.exploreBeforeGraph > l.maxExploreBeforeGraph) {
        return `${this.exploreBeforeGraph} grep/read calls before any graphify call (limit ${l.maxExploreBeforeGraph}). ` +
          `Graph first: graphify explain "file::symbol" (or graphify query "...") gives exact file:line in one step; ` +
          `then read only those lines`;
      }
    }

    // First-write guard: reading is not progress on its own. Before the turn's first edit the
    // only excuse for many calls is that they are about to become a write; after it, reads
    // without a following edit are the compaction loop.
    if (l.maxStepsBeforeFirstEdit > 0 && this.lastEditStep === 0 && this.steps > l.maxStepsBeforeFirstEdit) {
      return `FIRST_WRITE: ${this.steps} calls and nothing written (limit ${l.maxStepsBeforeFirstEdit}). ` +
        `Write the first file now from what you already know`;
    }
    const exploring = (EXPLORE_TOOLS.has(tool) || EXPLORE_CMD.test(cmd)) && !GRAPH_CMD.test(cmd);
    if (this.lastEditStep > 0) {
      if (exploring) this.exploreSinceEdit += 1;
      if (l.maxExploreSinceLastEdit > 0 && this.exploreSinceEdit > l.maxExploreSinceLastEdit) {
        return `FIRST_WRITE: ${this.exploreSinceEdit} read/grep calls since the last edit (limit ${l.maxExploreSinceLastEdit}). ` +
          `Write the next change now; do not re-read`;
      }
    }

    const sig = signature(tool, input);
    if (sig && l.maxRepeatCalls > 0) {
      const n = (this.seen.get(sig) ?? 0) + 1;
      this.seen.set(sig, n);
      if (n > l.maxRepeatCalls) {
        return `the same ${tool} call was made ${n} times (limit ${l.maxRepeatCalls}); it is not changing anything. ` +
          `Report what you are stuck on instead of retrying`;
      }
    }

    // Only a re-run with nothing changed since the last run counts: fix-then-run cycles are progress.
    if (cmd && TEST_CMD.test(cmd) && l.maxTestRuns > 0) {
      if (edited || this.lastEditStep > this.lastTestStep) this.testRuns = 0;
      this.lastTestStep = this.steps;
      this.testRuns += 1;
      if (this.testRuns > l.maxTestRuns) {
        return `tests were re-run ${this.testRuns} times with no file changed in between (limit ${l.maxTestRuns}); ` +
          `Report the failing test and its error instead of re-running`;
      }
    }

    // agy's view_file carries no line range, so paging one file looks like re-reading it; only count real reads.
    const file = READ_TOOLS.has(tool) && tool !== "view_file" ? fileOf(input) : "";
    if (file && l.maxSameFileReads > 0) {
      const n = (this.fileReads.get(file) ?? 0) + 1;
      this.fileReads.set(file, n);
      if (n > l.maxSameFileReads) {
        return `${file} was read ${n} times (limit ${l.maxSameFileReads}). Find the lines with grep -n and read only those`;
      }
    }

    if (l.maxRangeRereads > 0) {
      for (const r of rangeReadsOf(tool, input)) {
        const seen = this.rangesRead.get(r.file) ?? [];
        // An 8+ line read that is at least 60% lines already read this turn is a re-read.
        if (r.to - r.from >= 7 && seen.length && coveredShare(r, seen) >= 0.6) {
          this.rangeRereads += 1;
          if (this.rangeRereads > l.maxRangeRereads) {
            return `REREAD: ${this.rangeRereads} reads of lines already read this turn (last: ${r.file} ${r.from}-${r.to === Infinity ? "end" : r.to}; limit ${l.maxRangeRereads}). ` +
              `You have these lines in context: use them, or grep -n for the exact symbol; write the next change now`;
          }
        }
        seen.push([r.from, r.to]);
        this.rangesRead.set(r.file, seen);
      }
    }

    if (l.maxTurnSteps > 0 && this.steps > l.maxTurnSteps) {
      const ceiling = l.maxTurnSteps * Math.max(1, l.hardStepMultiplier);
      const stillEditing = this.lastEditStep > 0 && this.steps - this.lastEditStep <= l.stepGraceAfterEdit;
      if (!stillEditing || this.steps > ceiling) {
        return `turn stopped after ${this.steps} tool calls (limit ${l.maxTurnSteps}` +
          `${stillEditing ? `, hard ceiling ${ceiling}` : `, no file edited in the last ${l.stepGraceAfterEdit} calls`}); ` +
          `the agent is probably looping`;
      }
    }
    return "";
  }
}
