// ORCH OFFICE — a tiny local "IT company" view of the orchestrator's workers.
// Read-only: opens ~/.orchestrator/orch.db with readOnly and never writes to it.
// Run: npm run office   then open http://localhost:4747  (ORCH_DB=<path> to read another db)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4747);
const DB_PATH = process.env.ORCH_DB ?? join(homedir(), '.orchestrator', 'orch.db');
const WINDOW_MS = Number(process.env.ARCADE_WINDOW_HOURS ?? 12) * 3600_000;

function db() {
    // A fresh read-only handle per request: the daemon writes in WAL mode, and a
    // short-lived reader always sees the latest committed events.
    return new DatabaseSync(DB_PATH, { readOnly: true });
}

const parse = (s, d = {}) => { try { return JSON.parse(s); } catch { return d; } };

function summariseInput(input) {
    if (!input || typeof input !== 'object') return '';
    const pick = input.command ?? input.filePath ?? input.AbsolutePath ?? input.pattern ?? input.path
        ?? input.tool_info?.parameters?.CommandLine ?? input.tool_info?.parameters?.AbsolutePath ?? '';
    return String(pick).replace(/^"|"$/g, '').replace(homedir(), '~').slice(0, 140);
}

function workers() {
    const h = db();
    try {
        const since = Date.now() - WINDOW_MS;
        const sessions = h.prepare(
            `SELECT * FROM sessions WHERE closed_at IS NULL OR updated_at > ? OR created_at > ?
             ORDER BY created_at DESC LIMIT 24`).all(since, since);
        return sessions.map((s) => {
            const turns = h.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY id').all(s.id);
            const events = h.prepare(
                'SELECT seq, at, payload FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 400').all(s.id)
                .reverse().map((e) => ({ seq: e.seq, at: e.at, ev: parse(e.payload) }));

            // Collapse duplicate tool.call records (adapters emit one per state change).
            const feed = [];
            const seenTool = new Set();
            let toolCalls = 0;
            let text = '';
            for (const { at, ev } of events) {
                if (ev.t === 'tool.call') {
                    const key = ev.id;
                    const sum = summariseInput(ev.input);
                    if (seenTool.has(key) && !sum) continue;
                    if (!seenTool.has(key)) toolCalls++;
                    seenTool.add(key);
                    const last = feed[feed.length - 1];
                    if (last && last.id === key) { last.detail = sum || last.detail; continue; }
                    feed.push({ kind: 'tool', id: key, at, name: ev.name, detail: sum });
                } else if (ev.t === 'text.delta') {
                    text += ev.text;
                } else if (ev.t === 'error') {
                    feed.push({ kind: 'error', at, name: ev.kind, detail: String(ev.message ?? '').slice(0, 300) });
                } else if (ev.t === 'turn.completed') {
                    feed.push({ kind: 'done', at, name: 'turn completed', detail: `${ev.usage?.outputTokens ?? 0} tokens out` });
                } else if (ev.t === 'permission.request') {
                    feed.push({ kind: 'perm', at, name: 'permission', detail: String(ev.tool ?? '') });
                }
            }
            const lastTurn = turns[turns.length - 1];
            const lastEv = events[events.length - 1]?.ev;
            const running = !!lastTurn && lastTurn.ended_at == null && !s.closed_at;
            let state = 'idle';
            if (s.closed_at) state = 'gone';
            else if (lastEv?.t === 'error') state = /rate/i.test(lastEv.kind + lastEv.message) ? 'ratelimited' : 'error';
            else if (running) state = 'working';
            const lastAt = events[events.length - 1]?.at ?? s.updated_at;
            return {
                id: s.id,
                label: s.label || s.id.slice(0, 8),
                tool: s.tool,
                model: s.model,
                cwd: s.cwd.replace(homedir(), '~'),
                createdAt: s.created_at,
                closedAt: s.closed_at,
                totals: parse(s.totals),
                state,
                lastAt,
                toolCalls,
                turns: turns.length,
                task: (turns[0]?.prompt ?? '').slice(0, 4000),
                lastPrompt: (lastTurn?.prompt ?? '').slice(0, 1500),
                reply: (lastTurn?.result_text || text).slice(-3000),
                feed: feed.slice(-40),
                worktree: s.worktree_branch,
            };
        });
    } finally {
        h.close();
    }
}

const html = () => readFileSync(join(HERE, 'index.html'));

createServer((req, res) => {
    try {
        if (req.url === '/api/workers') {
            const body = JSON.stringify({ now: Date.now(), workers: workers() });
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            return res.end(body);
        }
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end(html());
        }
        res.writeHead(404); res.end('not found');
    } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message ?? e) }));
    }
}).listen(PORT, '127.0.0.1', () => console.log(`ORCH OFFICE on http://localhost:${PORT}`));
