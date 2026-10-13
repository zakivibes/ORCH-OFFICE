import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { addUsage, zeroUsage, type Event, type StoredEvent, type StoredSession, type StoredTurn, type ToolId, type Usage } from "./types.js";

export const DEFAULT_DB = `${process.env.HOME}/.orchestrator/orch.db`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string = DEFAULT_DB) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        native TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        root_pid INTEGER,
        totals TEXT NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        usage TEXT NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        aborted INTEGER NOT NULL DEFAULT 0,
        result_text TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
    `);
  }

  insertSession(s: StoredSession) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, tool, native, cwd, model, label, created_at, updated_at, closed_at, root_pid, totals, cost_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id,
        s.tool,
        s.native,
        s.cwd,
        s.model,
        s.label,
        s.createdAt,
        s.updatedAt,
        s.closedAt,
        s.rootPid,
        JSON.stringify(s.totals),
        s.costUsd,
      );
  }

  updateNative(id: string, native: string, model: string) {
    this.db
      .prepare("UPDATE sessions SET native=?, model=?, updated_at=? WHERE id=?")
      .run(native, model, Date.now(), id);
  }

  closeSession(id: string) {
    this.db.prepare("UPDATE sessions SET closed_at=?, updated_at=? WHERE id=?").run(Date.now(), Date.now(), id);
  }

  getSession(id: string): StoredSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : null;
  }

  listSessions(includeClosed = true): StoredSession[] {
    const sql = includeClosed
      ? "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 200"
      : "SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY updated_at DESC LIMIT 200";
    return (this.db.prepare(sql).all() as Record<string, unknown>[]).map(mapSession);
  }

  startTurn(sessionId: string, prompt: string): number {
    const r = this.db
      .prepare("INSERT INTO turns (session_id, prompt, started_at, usage) VALUES (?,?,?,?)")
      .run(sessionId, prompt, Date.now(), JSON.stringify(zeroUsage()));
    return Number(r.lastInsertRowid);
  }

  endTurn(id: number, patch: { usage: Usage; costUsd: number; aborted: boolean; resultText: string }) {
    this.db
      .prepare("UPDATE turns SET ended_at=?, usage=?, cost_usd=?, aborted=?, result_text=? WHERE id=?")
      .run(Date.now(), JSON.stringify(patch.usage), patch.costUsd, patch.aborted ? 1 : 0, patch.resultText, id);
  }

  getTurns(sessionId: string): StoredTurn[] {
    const rows = this.db.prepare("SELECT * FROM turns WHERE session_id=? ORDER BY id").all(sessionId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: Number(r.id),
      sessionId: String(r.session_id),
      prompt: String(r.prompt),
      startedAt: Number(r.started_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
      usage: JSON.parse(String(r.usage)) as Usage,
      costUsd: Number(r.cost_usd),
      aborted: Number(r.aborted) === 1,
      resultText: String(r.result_text ?? ""),
    }));
  }

  appendEvent(sessionId: string, event: Event): number {
    const r = this.db
      .prepare("INSERT INTO events (session_id, at, payload) VALUES (?,?,?)")
      .run(sessionId, Date.now(), JSON.stringify(event));
    return Number(r.lastInsertRowid);
  }

  eventsSince(sessionId: string, seq: number, limit = 500): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?")
      .all(sessionId, seq, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      sessionId: String(r.session_id),
      at: Number(r.at),
      event: JSON.parse(String(r.payload)) as Event,
    }));
  }

  accumulate(sessionId: string, delta: Usage, costUsd: number) {
    const s = this.getSession(sessionId);
    if (!s) return;
    const totals = addUsage(s.totals, delta);
    this.db
      .prepare("UPDATE sessions SET totals=?, cost_usd=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(totals), s.costUsd + costUsd, Date.now(), sessionId);
  }

  totalsByTool(): Array<{ tool: ToolId; sessions: number; turns: number; usage: Usage; costUsd: number }> {
    const sessions = this.db.prepare("SELECT tool, totals, cost_usd FROM sessions").all() as Record<string, unknown>[];
    const turns = this.db
      .prepare("SELECT session_id, usage, cost_usd FROM turns WHERE ended_at IS NOT NULL")
      .all() as Record<string, unknown>[];
    const toolOf = new Map(this.listSessions().map((s) => [s.id, s.tool]));
    const map = new Map<ToolId, { sessions: number; turns: number; usage: Usage; costUsd: number }>();
    const blank = () => ({ sessions: 0, turns: 0, usage: zeroUsage(), costUsd: 0 });

    for (const s of sessions) {
      const tool = String(s.tool) as ToolId;
      const e = map.get(tool) ?? blank();
      e.sessions += 1;
      e.usage = addUsage(e.usage, JSON.parse(String(s.totals)) as Usage);
      e.costUsd += Number(s.cost_usd);
      map.set(tool, e);
    }
    for (const t of turns) {
      const tool = toolOf.get(String(t.session_id));
      if (!tool) continue;
      const e = map.get(tool) ?? blank();
      e.turns += 1;
      map.set(tool, e);
    }
    return [...map.entries()].map(([tool, v]) => ({ tool, ...v }));
  }

  close() {
    this.db.close();
  }
}

function mapSession(r: Record<string, unknown>): StoredSession {
  return {
    id: String(r.id),
    tool: String(r.tool) as ToolId,
    native: String(r.native ?? ""),
    cwd: String(r.cwd),
    model: String(r.model),
    label: String(r.label ?? ""),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    closedAt: r.closed_at === null ? null : Number(r.closed_at),
    rootPid: r.root_pid === null ? null : Number(r.root_pid),
    totals: JSON.parse(String(r.totals)) as Usage,
    costUsd: Number(r.cost_usd),
  };
}