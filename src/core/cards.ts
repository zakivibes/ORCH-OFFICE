import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Knowledge cards: small how-to notes the coordinator curates. Pinned cards ride along on every
 * job; the others are picked by keyword overlap with the job text (top 3). Bounded in size, and
 * never written by workers, so a wrong assumption cannot spread.
 *
 * File: <dir>/<name>.md with frontmatter `title`, `tags` (comma separated), `description`, `pinned`.
 */
export interface Card {
  title: string;
  tags: string[];
  description: string;
  pinned: boolean;
  body: string;
}

export function cardsDir(): string {
  return process.env.ORCH_CARDS_DIR ?? path.join(os.homedir(), ".orchestrator", "cards");
}

export function parseCard(text: string): Card | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]!] = kv[2]!.trim();
  }
  if (!fm.title) return null;
  return {
    title: fm.title,
    tags: (fm.tags ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
    description: fm.description ?? "",
    pinned: /^true$/i.test(fm.pinned ?? ""),
    body: m[2]!.trim(),
  };
}

export function loadCards(dir = cardsDir()): Card[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Card[] = [];
  for (const n of names.sort()) {
    try {
      const c = parseCard(fs.readFileSync(path.join(dir, n), "utf8"));
      if (c) out.push(c);
    } catch {
      /* unreadable card: skip */
    }
  }
  return out;
}

function score(card: Card, jobText: string): number {
  const hay = jobText.toLowerCase();
  let s = 0;
  for (const t of card.tags) if (hay.includes(t)) s += 2;
  for (const w of card.title.toLowerCase().split(/[^a-z0-9_]+/)) if (w.length > 3 && hay.includes(w)) s += 1;
  return s;
}

export function selectCards(jobText: string, maxChars = 1500, dir = cardsDir()): string {
  const cards = loadCards(dir);
  if (!cards.length) return "";
  const pinned = cards.filter((c) => c.pinned);
  const ranked = cards
    .filter((c) => !c.pinned)
    .map((c) => ({ c, s: score(c, jobText) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.c);
  const picked = [...pinned, ...ranked];
  if (!picked.length) return "";
  const head = "## Project notes (curated; follow them)\n";
  let out = head;
  for (const c of picked) {
    const block = `### ${c.title}${c.description ? ` — ${c.description}` : ""}\n${c.body}\n`;
    if (out.length + block.length > maxChars) {
      const room = maxChars - out.length;
      if (room > 120) out += block.slice(0, room - 2) + "…\n";
      break;
    }
    out += block;
  }
  return out;
}
