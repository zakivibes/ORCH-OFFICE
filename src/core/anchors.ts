import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

const GRAPH_TIMEOUT_MS = 8_000;
const PARALLEL = 4;
const MAX_ANCHORS = 12;
const MAX_LINES_PER_ANCHOR = 12;
const AGENTS_MD_LIMIT = 8 * 1024;

/** `path.ext::symbol` tokens, e.g. `src/core/registry.ts::.send()`. */
const ANCHOR_SYMBOL = /([A-Za-z0-9_][\w./-]*\.(?:ts|js|dart|py))::([A-Za-z0-9_$.]+(?:\(\))?)/g;
/** Bare source paths, e.g. `backend/src/services/levelService.js`. */
const ANCHOR_PATH = /[A-Za-z0-9_][\w-]*\/[\w./-]*\.(?:ts|js|dart|py)\b/g;

/**
 * Find graphify anchors in a job text: `file::symbol` tokens first, then bare
 * source paths that no symbol token already covers. De-duplicated, max 12.
 */
export function extractAnchors(jobText: string): string[] {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const add = (a: string) => {
    if (!seen.has(a)) {
      seen.add(a);
      anchors.push(a);
    }
  };
  for (const m of jobText.matchAll(ANCHOR_SYMBOL)) {
    add(`${m[1]}::${m[2]}`);
  }
  for (const m of jobText.matchAll(ANCHOR_PATH)) {
    const path = m[0];
    if (![...seen].some((a) => a === path || a.startsWith(`${path}::`))) add(path);
  }
  return anchors.slice(0, MAX_ANCHORS);
}

/** Reduce one graphify explain answer to its Source line + `:L<n>` connection lines. */
function trimExplain(out: string): string[] {
  const kept: string[] = [];
  let inConnections = false;
  for (const raw of out.split("\n")) {
    const line = raw.trimEnd();
    const t = line.trimStart();
    if (t.startsWith("Source:")) {
      kept.push(line);
      continue;
    }
    if (t.startsWith("Connections")) {
      inConnections = true;
      continue;
    }
    if (inConnections && /:L\d+/.test(line) && kept.length < MAX_LINES_PER_ANCHOR) {
      kept.push(line);
    }
  }
  return kept;
}

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}

export interface AnchorPackOpts {
  /** Test seam; defaults to `execFile("graphify", args, { cwd, timeout: 8s })`. */
  run?: (args: string[]) => Promise<string>;
  maxTokens?: number;
}

/**
 * Run `graphify explain "<anchor>"` for every anchor found in the job text and
 * assemble a compact pack of file:line anchors, stopping near maxTokens
 * (approximated as chars/4). Returns "" when the cwd has no graphify-out/
 * directory or graphify is missing — never throws.
 */
export async function buildAnchorPack(cwd: string, jobText: string, opts: AnchorPackOpts = {}): Promise<string> {
  if (!existsSync(join(cwd, "graphify-out"))) return "";
  const anchors = extractAnchors(jobText);
  if (anchors.length === 0) return "";
  const maxTokens = opts.maxTokens ?? 800;
  const run =
    opts.run ??
    ((args: string[]) =>
      pExecFile("graphify", args, { cwd, timeout: GRAPH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }).then(
        (r) => String(r.stdout),
      ));

  const trimmed: string[] = new Array(anchors.length).fill("");
  let enoent = false;
  let next = 0;
  const worker = async () => {
    while (next < anchors.length && !enoent) {
      const i = next++;
      try {
        trimmed[i] = trimExplain(await run(["explain", anchors[i]!])).join("\n");
      } catch (e) {
        if (isEnoent(e)) {
          enoent = true;
          return;
        }
        trimmed[i] = ""; // a single failed anchor is skipped, never fatal
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, anchors.length) }, worker));
  if (enoent) return "";

  const blocks: string[] = [];
  let chars = 0;
  for (let i = 0; i < anchors.length; i++) {
    if (!trimmed[i]) continue;
    const block = `${anchors[i]}\n${trimmed[i]}`;
    if (blocks.length > 0 && (chars + block.length) / 4 > maxTokens) break;
    blocks.push(block);
    chars += block.length;
  }
  return blocks.join("\n\n");
}

/** A warning string when <cwd>/AGENTS.md is > 8 KB, else "". Never throws. */
export function agentsMdWarning(cwd: string): string {
  try {
    const size = statSync(join(cwd, "AGENTS.md")).size;
    if (size > AGENTS_MD_LIMIT) {
      return (
        `AGENTS.md in this repo is ${Math.round(size / 1024)} KB (> 8 KB) — trim it; ` +
        `workers re-read it on every step and it dominates the fixed context cost.`
      );
    }
  } catch {
    /* no AGENTS.md — nothing to warn about */
  }
  return "";
}

/** Read a job file (relative to cwd or absolute); "" when unreadable. */
export function readJobText(cwd: string, job: string): string {
  try {
    return readFileSync(isAbsolute(job) ? job : join(cwd, job), "utf8");
  } catch {
    return "";
  }
}

/** Basename for the "## Job (<basename>)" heading, tolerating odd paths. */
export function jobBasename(job: string): string {
  return basename(job);
}
