/**
 * Programs (plan B3): the coordinator's main job, e.g. "Levels engine 1-201"
 * grouping several worker sessions by the job file they ran.
 *
 * Stored in ~/.orchestrator/programs.json (override with ORCH_PROGRAMS_FILE, which
 * tests use to point at a temp dir):
 *   { "programs": [ { "id", "name", "items": [ { "job", "weight", "sessions": [ids] } ] } ] }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ProgramItem {
  job: string;
  weight: number;
  sessions: string[];
}

export interface Program {
  id: string;
  name: string;
  items: ProgramItem[];
}

export interface ProgramsFile {
  programs: Program[];
}

export function programsPath(): string {
  return process.env.ORCH_PROGRAMS_FILE || join(homedir(), ".orchestrator", "programs.json");
}

export function loadPrograms(path: string = programsPath()): ProgramsFile {
  if (!existsSync(path)) return { programs: [] };
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as ProgramsFile;
    return { programs: Array.isArray(p.programs) ? p.programs : [] };
  } catch {
    return { programs: [] };
  }
}

export function savePrograms(p: ProgramsFile, path: string = programsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(p, null, 2) + "\n");
}

export function findProgram(p: ProgramsFile, id: string): Program | undefined {
  return p.programs.find((pr) => pr.id === id);
}

export function addProgram(p: ProgramsFile, id: string, name: string): Program {
  const existing = findProgram(p, id);
  if (existing) throw new Error(`program "${id}" already exists`);
  const program: Program = { id, name, items: [] };
  p.programs.push(program);
  return program;
}

/** Append a session to the program item with this job file (item created with weight 1 if missing). */
export function link(p: ProgramsFile, id: string, job: string, sessionId: string): ProgramItem {
  const program = findProgram(p, id);
  if (!program) throw new Error(`no program "${id}"`);
  let item = program.items.find((i) => i.job === job);
  if (!item) {
    item = { job, weight: 1, sessions: [] };
    program.items.push(item);
  }
  if (!item.sessions.includes(sessionId)) item.sessions.push(sessionId);
  return item;
}

export function setWeight(p: ProgramsFile, id: string, job: string, weight: number): ProgramItem {
  const program = findProgram(p, id);
  if (!program) throw new Error(`no program "${id}"`);
  const item = program.items.find((i) => i.job === job);
  if (!item) throw new Error(`program "${id}" has no item for job "${job}"`);
  item.weight = weight;
  return item;
}

/**
 * Program % = sum(weight * pct) / sum(weight), where pct per session is the
 * coordinator grade if set, else the session's auto % (pctOf returns null when
 * the session is unknown -> 0). Tokens spent sums the linked sessions' totals
 * (tokensOf), failed sessions included.
 */
export function programPct(
  program: Program,
  pctOf: (sessionId: string) => number | null,
  tokensOf: (sessionId: string) => number,
): { pct: number; tokensSpent: number } {
  let weightSum = 0;
  let weighted = 0;
  const seen = new Set<string>();
  let tokensSpent = 0;
  for (const item of program.items) {
    weightSum += item.weight;
    for (const sessionId of item.sessions) {
      const pct = pctOf(sessionId);
      weighted += item.weight * (pct ?? 0);
      if (!seen.has(sessionId)) {
        seen.add(sessionId);
        tokensSpent += tokensOf(sessionId);
      }
    }
  }
  return { pct: weightSum > 0 ? weighted / weightSum : 0, tokensSpent };
}
