import fs from "node:fs";
import path from "node:path";
import { extractPaths } from "./jobs.js";

/**
 * File map: for each source file a job names, its main declarations with line numbers, so a worker
 * reads `sed -n 'A,Bp'` ranges instead of whole files (the biggest cost of a fresh session).
 * Computed fresh from the file on each call: it is a few KB of regex work, never stale, no cache.
 */
const MAX_FILES = 8;
/** Text sources only: images, archives and prototypes without a declaration style say nothing useful. */
const MAP_EXT = new Set([".dart", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".md"]);
const MAX_BYTES = 400_000;
const PER_FILE = 12;

interface Decl {
  line: number;
  text: string;
  rank: number; // 0 = types, 1 = key methods, 2 = the rest
}

const KEY_METHOD = /build|place|send|bet|confirm|load|fetch|init|dispose|handle|submit|settle|route|register/i;

function declsOf(file: string, src: string): Decl[] {
  const ext = path.extname(file).toLowerCase();
  const lines = src.split(/\r?\n/);
  const out: Decl[] = [];
  const add = (i: number, text: string, rank: number) => out.push({ line: i + 1, text: text.trim().slice(0, 110), rank });
  lines.forEach((l, i) => {
    if (ext === ".dart") {
      if (/^(?:abstract\s+|final\s+|base\s+|sealed\s+)*(?:class|mixin|enum|extension)\s+\w+/.test(l)) add(i, l.replace(/\s*\{.*$/, ""), 0);
      else {
        const m = l.match(/^ {2}(?:static\s+)?(?:Future<[^>]*>|Stream<[^>]*>|Widget|void|bool|int|double|String|[A-Z][\w<>?,\s]*)\s+(_?[a-z]\w*)\s*\(/);
        if (m) add(i, l.replace(/\s*(\{|=>).*$/, ""), KEY_METHOD.test(m[1]!) ? 1 : 2);
      }
    } else if ([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"].includes(ext)) {
      if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+\w+/.test(l)) add(i, l.replace(/\s*\{.*$/, ""), 0);
      else if (/^(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:\(|function|\w+\s*=>)/.test(l)) add(i, l.replace(/\s*(=>|\{).*$/, ""), 1);
      else {
        const m = l.match(/^ {2}(?:async\s+|static\s+|private\s+|public\s+|protected\s+)*(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/);
        if (m && !/^(if|for|while|switch|catch|function)$/.test(m[1]!)) add(i, l.replace(/\s*\{\s*$/, ""), KEY_METHOD.test(m[1]!) ? 1 : 2);
      }
    } else if (ext === ".py") {
      if (/^(?:async\s+)?def\s+\w+|^class\s+\w+/.test(l)) add(i, l.replace(/:\s*$/, ""), l.startsWith("class") ? 0 : 1);
    } else if (ext === ".md") {
      if (/^#{1,3}\s+\S/.test(l)) add(i, l, 0);
    }
  });
  return out;
}

/** Top declarations: types first, then key methods, then the rest, shown in file order. */
export function pickDecls(decls: Decl[], n = PER_FILE): Decl[] {
  const chosen = [...decls].sort((a, b) => a.rank - b.rank || a.line - b.line).slice(0, n);
  return chosen.sort((a, b) => a.line - b.line);
}

export function buildFileMap(cwd: string, jobText: string, maxChars = 2500): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const p of extractPaths(jobText)) {
    if (blocks.length >= MAX_FILES) break;
    if (/^https?:|^\.\.?\//.test(p)) continue;
    if (!MAP_EXT.has(path.extname(p).toLowerCase())) continue;
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const src = fs.readFileSync(abs, "utf8");
    const total = src.split("\n").length;
    const decls = pickDecls(declsOf(abs, src));
    if (!decls.length) continue;
    blocks.push(`${p} (${total} lines)\n${decls.map((d) => `  ${d.line}: ${d.text}`).join("\n")}`);
  }
  if (!blocks.length) return "";
  let body = blocks.join("\n");
  const head = "## File map (declarations with line numbers: read ranges with sed -n 'A,Bp', not whole files)\n";
  if (head.length + body.length > maxChars) body = body.slice(0, Math.max(0, maxChars - head.length - 4)) + "\n…";
  return head + body + "\n";
}
