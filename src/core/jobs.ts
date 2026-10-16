/**
 * Parse a job file (the text handed to a worker session) into structured items.
 *
 * Items are the numbered/bulleted tasks under a "DO" heading (" 1)", "a)", "1.", "- ");
 * if the text has no DO heading, every numbered line counts. For each item we also
 * collect the source files it names and the test paths among them — this is the
 * backbone of progress scoring (progress.ts) and the first-write guard.
 */
export interface JobItem {
  id: string;
  text: string;
  files: string[];
  tests: string[];
}

export interface ParsedJob {
  items: JobItem[];
  checks: string[];
}

/** Source paths: either slashed paths or bare filenames with a source extension. */
const PATH_RE =
  /(?:[A-Za-z0-9_.\-]+\/)+[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,6}|(?:[A-Za-z0-9_\-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md|dart|py|rb|go|java|sh|html|css|yaml|yml|sql|toml|vue|svelte))/g;

const ITEM_RE = /^\s{0,6}(?:(\d+)[).]|([a-z])\)|-\s)\s?(\s*)/;

/** A line that starts a new section, ending item collection. */
const HEADING_RE =
  /^(?:[A-Z][A-Z0-9 _&/.,'-]{1,18}:?(?:\s|$)|Checks?:|Note[s]?:|Rules?:|Constraints?:|Do not\b|DO NOT\b|Do NOT\b|FIRST\b|ANCHORS?:)/;

function isItemLine(line: string): boolean {
  if (!ITEM_RE.test(line)) return false;
  return true;
}

export function extractPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0].replace(/[.,;:)]+$/, "");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function itemFrom(id: string, lines: string[]): JobItem {
  const text = lines.join("\n").trim();
  const files = extractPaths(text);
  return {
    id,
    text,
    files,
    tests: files.filter((f) => /test/i.test(f)),
  };
}

/**
 * Parse a job text into items and check commands.
 * Bullets get ids "b1", "b2", ... so they never collide with numbered items.
 */
export function parseJob(text: string): ParsedJob {
  const lines = text.split(/\r?\n/);

  // Find the DO heading, if any; items are collected from there. Fallback: the whole text.
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^DO\b/.test(lines[i]!.trim())) {
      start = i + 1;
      break;
    }
  }

  const items: JobItem[] = [];
  const checks: string[] = [];
  let current: { id: string; lines: string[] } | null = null;
  let inChecks = false;
  let bulletNo = 0;

  const flush = () => {
    if (current) {
      const item = itemFrom(current.id, current.lines);
      if (item.text) items.push(item);
      current = null;
    }
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (/^Checks?:/.test(trimmed)) {
      flush();
      inChecks = true;
      const rest = trimmed.replace(/^Checks?:\s*/, "");
      if (rest) checks.push(rest);
      continue;
    }
    if (inChecks) {
      if (!trimmed || HEADING_RE.test(trimmed)) {
        inChecks = false;
      } else {
        checks.push(trimmed);
        continue;
      }
    }

    if (!trimmed) {
      // A blank line can separate an item from its continuation; keep the item open
      // only if the next non-blank line is a continuation. Simplest honest rule: close it.
      flush();
      continue;
    }
    if (HEADING_RE.test(trimmed) && !isItemLine(trimmed)) {
      flush();
      continue;
    }
    if (isItemLine(trimmed)) {
      flush();
      const m = trimmed.match(ITEM_RE)!;
      const id = m[1] ? m[1] : m[2] ? m[2] : `b${++bulletNo}`;
      const rest = trimmed.slice(m[0].length);
      current = { id, lines: rest ? [rest] : [] };
      continue;
    }
    if (current) current.lines.push(trimmed);
  }
  flush();

  if (!items.length) {
    // Fallback: every numbered line anywhere in the text.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = line.match(/^\s{0,6}(\d+)[).]\s*(.*)$/);
      if (m) items.push(itemFrom(m[1]!, [m[2] ?? ""]));
    }
  }

  return { items, checks };
}
