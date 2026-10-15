import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GroupConfig {
  name: string;
  match?: string[];
  tool?: string;
  max: number;
  shift?: {
    from: string;
    to: string;
    tz: string;
    graceMin?: number;
  };
  quota?: boolean;
}

export interface Config {
  groups?: GroupConfig[];
}

let configCache: Config | null = null;
let configMtime = 0;

function configPath(): string {
  return process.env.ORCH_CONFIG_FILE || join(homedir(), ".orchestrator", "config.json");
}

function quotaPath(): string {
  return process.env.ORCH_QUOTA_FILE || join(homedir(), ".orchestrator", "quota.json");
}

export function loadConfig(): Config {
  const path = configPath();
  try {
    const stat = existsSync(path) ? statSync(path) : null;
    if (stat && stat.mtimeMs === configMtime && configCache) return configCache;
    const raw = readFileSync(path, "utf8");
    configCache = JSON.parse(raw) as Config;
    configMtime = stat?.mtimeMs ?? 0;
    return configCache;
  } catch {
    configCache = { groups: [] };
    configMtime = 0;
    return configCache;
  }
}

export function clearConfigCache(): void {
  configCache = null;
  configMtime = 0;
}

export function getGroups(): GroupConfig[] {
  return loadConfig().groups ?? [];
}

export interface SessionIdentity {
  tool: string;
  model?: string;
}

export function matchGroup(identity: SessionIdentity): GroupConfig | null {
  const groups = getGroups();
  for (const g of groups) {
    if (g.tool && g.tool !== identity.tool) continue;
    if (g.match && identity.model) {
      const hit = g.match.some((m) => identity.model!.includes(m));
      if (!hit) continue;
    } else if (g.match && !identity.model) {
      continue;
    }
    return g;
  }
  return null;
}

export interface LiveSession {
  id: string;
  group: string;
  closedAt: number | null;
}

export function countLive(groupName: string, sessions: LiveSession[]): number {
  return sessions.filter((s) => s.group === groupName && s.closedAt === null).length;
}

function parseHM(hm: string): { h: number; m: number } {
  const parts = hm.split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1] ?? 0);
  return { h, m };
}

function toMinutes(h: number, m: number): number {
  return h * 60 + m;
}

function getLocalParts(date: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function localNowInTz(now: Date, tz: string): { hour: number; minute: number; nowMin: number; localDate: Date; offsetMs: number } {
  const parts = getLocalParts(now, tz);
  const localDate = new Date();
  localDate.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  localDate.setUTCHours(parts.hour, parts.minute, 0, 0);
  // Zone offsets are whole minutes; rounding drops the seconds of "now" from the offset.
  const offsetMs = Math.round((localDate.getTime() - now.getTime()) / 60_000) * 60_000;
  return { hour: parts.hour, minute: parts.minute, nowMin: toMinutes(parts.hour, parts.minute), localDate, offsetMs };
}

function localToUtc(localDate: Date, targetHour: number, targetMinute: number, offsetMs: number): Date {
  const target = new Date(localDate);
  target.setUTCHours(targetHour, targetMinute, 0, 0);
  return new Date(target.getTime() - offsetMs);
}

export function isInShiftWindow(group: GroupConfig, now: Date = nowFn()): boolean {
  if (!group.shift) return true;
  const { from, to, tz } = group.shift;
  const { h: fromH, m: fromM } = parseHM(from);
  const { h: toH, m: toM } = parseHM(to);
  const fromMin = toMinutes(fromH, fromM);
  const toMin = toMinutes(toH, toM);

  const { nowMin } = localNowInTz(now, tz);

  if (fromMin < toMin) {
    return nowMin >= fromMin && nowMin < toMin;
  } else {
    return nowMin >= fromMin || nowMin < toMin;
  }
}

function computeWindowEnd(now: Date, toH: number, toM: number, tz: string): Date {
  const { localDate, offsetMs } = localNowInTz(now, tz);
  const end = new Date(localDate);
  end.setUTCHours(toH, toM, 0, 0);
  if (end > localDate) {
    end.setUTCDate(end.getUTCDate() - 1);
  }
  return localToUtc(end, toH, toM, offsetMs);
}

function computeCurrentWindowEnd(now: Date, fromH: number, fromM: number, toH: number, toM: number, tz: string): Date {
  const { localDate, offsetMs } = localNowInTz(now, tz);
  const fromMin = toMinutes(fromH, fromM);
  const toMin = toMinutes(toH, toM);
  const { nowMin } = localNowInTz(now, tz);
  
  const end = new Date(localDate);
  if (fromMin < toMin) {
    end.setUTCHours(toH, toM, 0, 0);
    if (end <= localDate) {
      end.setUTCDate(end.getUTCDate() + 1);
    }
  } else {
    if (nowMin >= fromMin) {
      end.setUTCDate(end.getUTCDate() + 1);
    }
    end.setUTCHours(toH, toM, 0, 0);
  }
  return localToUtc(end, toH, toM, offsetMs);
}

function computeWindowStart(now: Date, fromH: number, fromM: number, tz: string): Date {
  const { localDate, offsetMs } = localNowInTz(now, tz);
  const start = new Date(localDate);
  start.setUTCHours(fromH, fromM, 0, 0);
  if (start > localDate) {
    start.setUTCDate(start.getUTCDate() - 1);
  }
  return localToUtc(start, fromH, fromM, offsetMs);
}

function computeNextWindowStart(now: Date, fromH: number, fromM: number, tz: string): Date {
  const { localDate, offsetMs } = localNowInTz(now, tz);
  const start = new Date(localDate);
  start.setUTCHours(fromH, fromM, 0, 0);
  if (start <= localDate) {
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return localToUtc(start, fromH, fromM, offsetMs);
}

function computeNextWindowEnd(now: Date, toH: number, toM: number, tz: string): Date {
  const { localDate, offsetMs } = localNowInTz(now, tz);
  const end = new Date(localDate);
  end.setUTCHours(toH, toM, 0, 0);
  if (end <= localDate) {
    end.setUTCDate(end.getUTCDate() + 1);
  }
  return localToUtc(end, toH, toM, offsetMs);
}

export function nextShiftBoundary(group: GroupConfig, now: Date = nowFn()): { active: boolean; startsAt: Date | null; endsAt: Date | null } {
  if (!group.shift) return { active: true, startsAt: null, endsAt: null };
  const { from, to, tz } = group.shift;
  const { h: fromH, m: fromM } = parseHM(from);
  const { h: toH, m: toM } = parseHM(to);
  const fromMin = toMinutes(fromH, fromM);
  const toMin = toMinutes(toH, toM);

  const { nowMin } = localNowInTz(now, tz);
  const active = fromMin < toMin ? nowMin >= fromMin && nowMin < toMin : nowMin >= fromMin || nowMin < toMin;

  let startsAt: Date | null = null;
  let endsAt: Date | null = null;

  if (active) {
    endsAt = computeCurrentWindowEnd(now, fromH, fromM, toH, toM, tz);
  } else {
    startsAt = computeNextWindowStart(now, fromH, fromM, tz);
    endsAt = computeNextWindowEnd(now, toH, toM, tz);
  }

  return { active, startsAt, endsAt };
}

function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { hour12: false });
}

export function shiftRefusalMessage(group: GroupConfig): string {
  const b = nextShiftBoundary(group, nowFn());
  if (!b.startsAt) return "";
  return `${group.name} works night shift only: ${group.shift!.from}–${group.shift!.to} ${group.shift!.tz}, next start ${formatLocal(b.startsAt.toISOString())}`;
}

let shiftTimer: NodeJS.Timeout | null = null;
let shiftCallback: ((group: string, sessionId: string) => void) | null = null;
let nowFn: () => Date = () => new Date();

export function __testSetNow(fn: () => Date) {
  nowFn = fn;
}

export function __testSetShiftCallback(cb: ((group: string, sessionId: string) => void) | null) {
  shiftCallback = cb;
}

export async function __testTick<T extends {
  adapters: Map<string, unknown>;
  handles: Map<string, unknown>;
  store: { getSession: (id: string) => { id: string; tool: string; model: string; closedAt: number | null } | null; appendEvent: (id: string, event: any) => number; listSessions: (includeClosed: boolean) => any[] };
  close: (id: string) => Promise<void>;
  interrupt: (id: string) => Promise<void>;
}>(registry: T): Promise<void> {
  await tick(registry);
}

export function startShiftTimer<T extends {
  adapters: Map<string, unknown>;
  handles: Map<string, unknown>;
  store: { getSession: (id: string) => { id: string; tool: string; model: string; closedAt: number | null } | null; appendEvent: (id: string, event: any) => number; listSessions: (includeClosed: boolean) => any[] };
  close: (id: string) => Promise<void>;
  interrupt: (id: string) => Promise<void>;
}>(registry: T): void {
  if (shiftTimer) return;
  shiftTimer = setInterval(async () => {
    try {
      await tick(registry);
    } catch {
      // ignore tick errors
    }
  }, 60_000);
  shiftTimer.unref?.();
}

async function tick(registry: {
  adapters: Map<string, any>;
  handles: Map<string, any>;
  store: { getSession: (id: string) => any; appendEvent: (id: string, event: any) => number; listSessions: (includeClosed: boolean) => any[] };
  close: (id: string) => Promise<void>;
  interrupt: (id: string) => Promise<void>;
  emit?: (event: string, sessionId: string, eventData: any) => void;
}): Promise<void> {
  const now = nowFn();
  const groups = getGroups();
  for (const g of groups) {
    if (!g.shift) continue;
    const { from, to, tz, graceMin = 5 } = g.shift;
    const { h: fromH, m: fromM } = parseHM(from);
    const { h: toH, m: toM } = parseHM(to);
    const fromMin = toMinutes(fromH, fromM);
    const toMin = toMinutes(toH, toM);

    const { nowMin } = localNowInTz(now, tz);
    const active = fromMin < toMin ? nowMin >= fromMin && nowMin < toMin : nowMin >= fromMin || nowMin < toMin;

    if (!active) {
      const lastEnd = computeWindowEnd(now, toH, toM, tz);
      const graceEnd = new Date(lastEnd.getTime() + graceMin * 60_000);
      if (now >= graceEnd) {
        const liveSessions = registry.store.listSessions(false);
        for (const session of liveSessions) {
          const groupMatch = matchGroup({ tool: session.tool, model: session.model });
          if (groupMatch?.name === g.name) {
            shiftCallback?.(g.name, session.id);
            const msg = "\n[orch shift] night shift ended — work so far is kept; this worker went home\n";
            try {
              registry.store.appendEvent(session.id, { t: "text.delta", text: msg });
              registry.emit?.("event", session.id, { t: "text.delta", text: msg });
            } catch {
              // ignore append errors
            }
            try {
              await registry.interrupt(session.id);
            } catch {
              // ignore interrupt errors
            }
            try {
              await registry.close(session.id);
            } catch {
              // ignore close errors
            }
          }
        }
      }
    }
  }
}

export function stopShiftTimer(): void {
  if (shiftTimer) {
    clearInterval(shiftTimer);
    shiftTimer = null;
  }
}

export interface QuotaEntry {
  until: string;
  reason: string;
}

function loadQuota(): Record<string, QuotaEntry> {
  const path = quotaPath();
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Record<string, QuotaEntry>;
  } catch {
    return {};
  }
}

function saveQuota(q: Record<string, QuotaEntry>): void {
  const path = quotaPath();
  mkdirSync(join(homedir(), ".orchestrator"), { recursive: true });
  writeFileSync(path, JSON.stringify(q, null, 2));
}

export function checkQuota(groupName: string): { blocked: boolean; message?: string; until?: Date } {
  const q = loadQuota();
  const entry = q[groupName];
  if (!entry) return { blocked: false };
  const until = new Date(entry.until);
  const now = nowFn();
  if (until <= now) {
    delete q[groupName];
    saveQuota(q);
    return { blocked: false };
  }
  return { blocked: true, message: `${groupName} quota not renewed until ${formatLocal(entry.until)}`, until };
}

function parseResetTime(message: string, defaultHours: number): Date {
  const now = Date.now();
  const resetInMatch = /reset(?:s| in)?\s+(?:at\s+([\d:]+(?:\s*(?:am|pm))?)|(\d+)\s*(h|m|s))/i.exec(message);
  if (resetInMatch) {
    if (resetInMatch[1]) {
      const timeStr = resetInMatch[1];
      const parts = timeStr.split(":");
      const h = Number(parts[0]);
      const m = Number(parts[1] ?? 0);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d;
    }
    const val = Number(resetInMatch[2] ?? 0);
    const unit = (resetInMatch[3] ?? "m").toLowerCase();
    let ms = val * (unit === "h" ? 3600_000 : unit === "m" ? 60_000 : 1000);
    return new Date(now + ms);
  }
  const retryAfter = /retry.after\s+(\d+)\s*(s|m|h)/i.exec(message);
  if (retryAfter) {
    const val = Number(retryAfter[1] ?? 0);
    const unit = (retryAfter[2] ?? "m").toLowerCase();
    let ms = val * (unit === "h" ? 3600_000 : unit === "m" ? 60_000 : 1000);
    return new Date(now + ms);
  }
  const resetsIn = /resets?\s+in\s+(\d+)h\s*(\d+)?m?/i.exec(message);
  if (resetsIn) {
    const h = Number(resetsIn[1] ?? 0);
    const m = Number(resetsIn[2] ?? 0);
    return new Date(now + (h * 60 + m) * 60_000);
  }
  return new Date(now + defaultHours * 3600_000);
}

function isQuotaError(message: string): boolean {
  return /quota|exhausted|resource_exhausted|usage limit|limit reached|insufficient.*credit|rate limit|429/i.test(message);
}

export { isQuotaError };

export function recordQuotaError(groupName: string, errorMessage: string): void {
  const groups = getGroups();
  const group = groups.find((g) => g.name === groupName);
  const isAgy = group?.tool === "agy";
  const isGemini = groupName.toLowerCase().includes("gemini");
  const defaultHours = (isAgy || isGemini) ? 5 : 1;
  const until = parseResetTime(errorMessage, defaultHours);
  const q = loadQuota();
  q[groupName] = { until: until.toISOString(), reason: errorMessage.slice(0, 200) };
  saveQuota(q);
}

export function getQuotaStatus(): Record<string, { until: string; reason: string }> {
  return loadQuota();
}

export function clearQuota(groupName: string): void {
  const q = loadQuota();
  delete q[groupName];
  saveQuota(q);
}

export interface ShiftStatusEntry {
  group: string;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  live: number;
  max: number;
  quotaBlocked: boolean;
  quotaUntil: string | null;
  quotaReason: string | null;
}

export function shiftStatus(liveSessions: LiveSession[]): ShiftStatusEntry[] {
  const groups = getGroups();
  const now = nowFn();
  const quota = loadQuota();
  return groups.map((g) => {
    const boundary = nextShiftBoundary(g, now);
    const live = countLive(g.name, liveSessions);
    const q = quota[g.name];
    const quotaBlocked = q ? new Date(q.until) > now : false;
    return {
      group: g.name,
      active: boundary.active,
      startsAt: boundary.startsAt?.toISOString() ?? null,
      endsAt: boundary.endsAt?.toISOString() ?? null,
      live,
      max: g.max,
      quotaBlocked,
      quotaUntil: quotaBlocked && q ? q.until : null,
      quotaReason: quotaBlocked && q ? q.reason : null,
    };
  });
}