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
 *   - more than `maxExploreBeforeGraph` grep/read calls before the turn's first `graphify` call:
 *     exploring by hand re-sends the whole context per step, the code graph answers in one;
 *   - past `maxTurnSteps`, a turn may continue only while it is still editing (an edit within
 *     the last `stepGraceAfterEdit` calls), up to `maxTurnSteps * hardStepMultiplier`.
 *
 * Each reason says what to do instead, because the stop message is what the coordinator (and
 * the next session's hand-off) reads.
 */
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "patch", "apply_patch", "str_replace_based_edit_tool"]);
const TEST_CMD = /\b(npm (run )?test|flutter test|dart test|node (--test )?tests?\/|jest|pytest|vitest|go test)\b/;
const READ_TOOLS = new Set(["read", "view"]);
/** A shell command that writes a file: heredoc/redirect, sed -i, or a script that opens a file for writing. */
const SHELL_WRITE = /(^|[;&|]\s*)(cat|tee) [^|]*>|sed -i|perl -pi|open\([^)]*['"]w['"]|\.write(_text)?\(|writeFileSync/;
const EXPLORE_TOOLS = new Set(["read", "view", "grep", "glob", "list", "ls"]);
const EXPLORE_CMD = /^\s*(cd [^;&]+(&&|;)\s*)?(rtk )?(grep|rg|sed -n|cat|head|tail|find|ls|wc)\b/;
const GRAPH_CMD = /\bgraphify (explain|query|path)\b/;

function commandOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  return typeof i.command === "string" ? i.command : "";
}

function fileOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const f = i.filePath ?? i.file_path ?? i.path;
  return typeof f === "string" ? f : "";
}

/** The call's identity, without fields that vary between otherwise identical calls. */
function signature(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object" || Object.keys(input).length === 0) return null;
  const { description: _d, workdir: _w, timeout: _t, ...rest } = input as Record<string, unknown>;
  return `${name} ${JSON.stringify(rest)}`;
}

export class LoopGuard {
  private steps = 0;
  private lastEditStep = 0;
  private testRuns = 0;
  private lastTestStep = 0;
  private graphUsed = false;
  private exploreBeforeGraph = 0;
  private readonly seen = new Map<string, number>();
  private readonly fileReads = new Map<string, number>();

  constructor(private readonly limits: Limits) {}

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
    if (edited) this.lastEditStep = this.steps;

    if (GRAPH_CMD.test(cmd)) this.graphUsed = true;
    if (!this.graphUsed && l.maxExploreBeforeGraph > 0 && (EXPLORE_TOOLS.has(tool) || EXPLORE_CMD.test(cmd))) {
      this.exploreBeforeGraph += 1;
      if (this.exploreBeforeGraph > l.maxExploreBeforeGraph) {
        return `${this.exploreBeforeGraph} grep/read calls before any graphify call (limit ${l.maxExploreBeforeGraph}). ` +
          `Graph first: graphify explain "file::symbol" (or graphify query "...") gives exact file:line in one step; ` +
          `then read only those lines`;
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

    const file = READ_TOOLS.has(tool) ? fileOf(input) : "";
    if (file && l.maxSameFileReads > 0) {
      const n = (this.fileReads.get(file) ?? 0) + 1;
      this.fileReads.set(file, n);
      if (n > l.maxSameFileReads) {
        return `${file} was read ${n} times (limit ${l.maxSameFileReads}). Find the lines with grep -n and read only those`;
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
