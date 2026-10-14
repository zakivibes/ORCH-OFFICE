// ORCH OFFICE — a tiny local "IT company" view of the orchestrator's workers, plus a live
// dashboard for tracking and counting what they do.
// Read-only: opens ~/.orchestrator/orch.db (and opencode's own db, if present) with readOnly and
// never writes to either.
// Run: npm run office   then open http://localhost:4747  (ORCH_DB=<path> to read another db)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4747);
const DB_PATH = process.env.ORCH_DB ?? join(homedir(), '.orchestrator', 'orch.db');
const DEFAULT_HOURS = Number(process.env.ARCADE_WINDOW_HOURS ?? 12);
// opencode keeps every step's token count in its own database. Read it directly: it is the
// authoritative figure for opencode workers, and unlike orch.db it updates while a turn runs.
const OPENCODE_DB = process.env.OPENCODE_DB ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
// A working session with no event for this long is flagged as possibly stalled.
const STALL_MS = Number(process.env.ORCH_STALL_MINUTES ?? 10) * 60_000;

const TEAM_CONFIG_PATH = join(homedir(), '.orchestrator', 'team.json');
const DAEMON_PID_PATH = join(homedir(), '.orchestrator', 'daemon.json');
const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.jsonc');

function getDaemonPort() {
    try {
        if (existsSync(DAEMON_PID_PATH)) {
            const data = JSON.parse(readFileSync(DAEMON_PID_PATH, 'utf8'));
            if (data.port) return data.port;
        }
    } catch {}
    return 47811;
}

async function callDaemon(route, body = {}) {
    const port = getDaemonPort();
    const r = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) {
        const text = await r.text();
        throw new Error(`Daemon error (${r.status}): ${text}`);
    }
    return r.json();
}

function readBodyJson(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

const parse = (s, d = {}) => { try { return JSON.parse(s); } catch { return d; } };
const ZERO = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 });
const add = (a, b) => {
    const o = ZERO();
    for (const k of Object.keys(o)) o[k] = Number(a?.[k] ?? 0) + Number(b?.[k] ?? 0);
    return o;
};

function open(path) {
    // A fresh read-only handle per request: the writers use WAL, and a short-lived reader always
    // sees the latest committed rows.
    try { return new DatabaseSync(path, { readOnly: true }); } catch { return null; }
}

// Sum the assistant messages of one opencode session in [from, to).
function opencodeUsage(oc, nativeId, from = 0, to = Number.MAX_SAFE_INTEGER) {
    const row = oc.prepare(`
        SELECT COUNT(*) AS steps,
               COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)       AS input,
               COALESCE(SUM(json_extract(data, '$.tokens.output')), 0)      AS output,
               COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0)   AS reasoning,
               COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0)  AS cacheRead,
               COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS cacheWrite,
               COALESCE(SUM(json_extract(data, '$.cost')), 0)               AS cost
          FROM message
         WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
           AND time_created >= ? AND time_created < ?`).get(nativeId, from, to);
    return {
        steps: Number(row.steps),
        usage: {
            inputTokens: Number(row.input), outputTokens: Number(row.output), thinkingTokens: Number(row.reasoning),
            cacheReadTokens: Number(row.cacheRead), cacheWriteTokens: Number(row.cacheWrite),
        },
        costUsd: Number(row.cost),
    };
}

function summariseInput(input) {
    if (!input || typeof input !== 'object') return '';
    const p = input.tool_info?.parameters ?? {};
    const pick = input.command ?? input.filePath ?? input.AbsolutePath ?? input.pattern ?? input.path
        ?? p.CommandLine ?? p.AbsolutePath ?? p.TargetFile ?? p.SearchPath ?? p.Query ?? p.Pattern ?? '';
    return String(pick).replace(/^"|"$/g, '').replace(homedir(), '~').slice(0, 160);
}

// Paths a tool call changed (edits/writes), so the panel can list the files a worker touched.
const WRITE_TOOLS = /^(edit|write|multiedit|patch|write_to_file|replace_file_content|multi_replace_file_content|create_file)$/i;
function touchedPath(name, input) {
    if (!WRITE_TOOLS.test(String(name))) return null;
    const p = input?.tool_info?.parameters ?? {};
    const path = input?.filePath ?? input?.path ?? p.TargetFile ?? p.AbsolutePath ?? p.FilePath;
    return path ? String(path).replace(homedir(), '~') : null;
}

function worker(h, oc, s, now) {
    const turns = h.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY id').all(s.id);
    const lastTurn = turns[turns.length - 1];
    const running = !!lastTurn && lastTurn.ended_at == null && !s.closed_at;

    // Exact tool-call counts over the whole session (adapters emit one record per state change,
    // so count distinct ids per tool name).
    const breakdown = {};
    let toolCalls = 0;
    for (const r of h.prepare(`
            SELECT json_extract(payload, '$.name') AS name, COUNT(DISTINCT json_extract(payload, '$.id')) AS n
              FROM events WHERE session_id = ? AND json_extract(payload, '$.t') = 'tool.call'
             GROUP BY name ORDER BY n DESC`).all(s.id)) {
        breakdown[String(r.name)] = Number(r.n);
        toolCalls += Number(r.n);
    }

    const events = h.prepare('SELECT seq, at, payload FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 600')
        .all(s.id).reverse().map((e) => ({ seq: e.seq, at: e.at, ev: parse(e.payload) }));

    // Activity feed: tool calls (collapsed per id), what the worker said, errors, turn ends.
    const feed = [];
    const seenTool = new Set();
    const files = new Map();
    let say = null;
    const flushSay = () => {
        if (say && say.text.trim()) {
            const lines = say.text.trim().split('\n').filter(Boolean);
            feed.push({ kind: 'say', at: say.at, name: 'said', detail: lines[lines.length - 1].slice(0, 220) });
        }
        say = null;
    };
    for (const { at, ev } of events) {
        if (ev.t === 'text.delta') {
            if (!say) say = { at, text: '' };
            say.text += ev.text; say.at = at;
            continue;
        }
        if (ev.t === 'usage.step' || ev.t === 'tool.result' || ev.t === 'thinking.delta') continue;
        flushSay();
        if (ev.t === 'tool.call') {
            const sum = summariseInput(ev.input);
            const f = touchedPath(ev.name, ev.input);
            if (f) files.set(f, at);
            if (seenTool.has(ev.id) && !sum) continue;
            seenTool.add(ev.id);
            const last = feed[feed.length - 1];
            if (last && last.id === ev.id) { last.detail = sum || last.detail; continue; }
            feed.push({ kind: 'tool', id: ev.id, at, name: ev.name, detail: sum });
        } else if (ev.t === 'error') {
            feed.push({ kind: 'error', at, name: ev.kind, detail: String(ev.message ?? '').slice(0, 300) });
        } else if (ev.t === 'turn.completed') {
            feed.push({ kind: 'done', at, name: 'turn completed', detail: '' });
        } else if (ev.t === 'permission.request') {
            feed.push({ kind: 'perm', at, name: 'permission', detail: String(ev.tool ?? '') });
        }
    }
    flushSay();

    // Usage: opencode's own ledger when readable (live, every step), else orch's records, plus
    // agy's per-step usage events for a turn still running.
    let usageSource = 'orch';
    let totals = { ...ZERO(), ...parse(s.totals) };
    let costUsd = Number(s.cost_usd ?? 0);
    const useOc = s.tool === 'opencode' && s.native && oc;
    const turnRows = turns.map((t, i) => {
        let usage = { ...ZERO(), ...parse(t.usage) };
        let steps = null;
        if (useOc) {
            try {
                const u = opencodeUsage(oc, s.native, t.started_at, t.ended_at ?? Number.MAX_SAFE_INTEGER);
                if (u.steps > 0) { usage = u.usage; steps = u.steps; }
            } catch { /* fall back to orch's figure */ }
        }
        return {
            n: i + 1, startedAt: t.started_at, endedAt: t.ended_at, aborted: !!t.aborted,
            durationMs: (t.ended_at ?? now) - t.started_at, usage, steps,
            prompt: String(t.prompt).slice(0, 300),
        };
    });
    if (useOc) {
        try {
            const all = opencodeUsage(oc, s.native);
            if (all.steps > 0) { totals = all.usage; costUsd = all.costUsd; usageSource = 'opencode'; }
        } catch { /* schema drift or locked db */ }
    }

    // The running turn: elapsed, steps, tool calls and tokens so far.
    let current = null;
    if (running) {
        const since = lastTurn.started_at;
        const turnEvents = events.filter((e) => e.at >= since);
        const callIds = new Set(turnEvents.filter((e) => e.ev.t === 'tool.call').map((e) => e.ev.id));
        let usage = ZERO(), steps = 0, source = 'none';
        if (usageSource === 'opencode') {
            const u = turnRows[turnRows.length - 1];
            usage = u.usage; steps = u.steps ?? 0; source = 'opencode';
        } else {
            for (const e of turnEvents) if (e.ev.t === 'usage.step') { usage = add(usage, e.ev.usage); steps++; }
            if (steps) {
                source = 'steps';
                // fold the running turn into the session totals so the header counts it too
                totals = add(totals, usage);
            }
        }
        const elapsed = now - since;
        const tokens = Object.values(usage).reduce((a, b) => a + b, 0);
        current = {
            startedAt: since, elapsedMs: elapsed, steps, toolCalls: callIds.size, usage, source,
            tokensPerMin: elapsed > 0 ? Math.round(tokens / (elapsed / 60_000)) : 0,
        };
    }

    const lastEv = events[events.length - 1]?.ev;
    const lastAt = events[events.length - 1]?.at ?? s.updated_at;
    let state = 'idle';
    if (s.closed_at) state = 'gone';
    else if (lastEv?.t === 'error') state = /rate/i.test(lastEv.kind + lastEv.message) ? 'ratelimited' : 'error';
    else if (running) state = 'working';
    const stalled = state === 'working' && now - lastAt > STALL_MS;
    const lastText = [...feed].reverse().find((f) => f.kind === 'say')?.detail ?? '';
    const text = events.filter((e) => e.ev.t === 'text.delta').map((e) => e.ev.text).join('');

    return {
        id: s.id,
        label: s.label || s.id.slice(0, 8),
        tool: s.tool,
        model: s.model,
        cwd: s.cwd.replace(homedir(), '~'),
        createdAt: s.created_at,
        closedAt: s.closed_at,
        totals, costUsd, usageSource,
        state, stalled, lastAt, lastText,
        toolCalls, breakdown,
        turns: turns.length,
        turnRows: turnRows.slice(-30),
        current,
        files: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([path, at]) => ({ path, at })),
        task: (turns[0]?.prompt ?? '').slice(0, 4000),
        lastPrompt: (lastTurn?.prompt ?? '').slice(0, 1500),
        reply: (lastTurn?.result_text || text).slice(-3000),
        feed: feed.slice(-60),
        worktree: s.worktree_branch,
    };
}

function workers(hours) {
    const h = open(DB_PATH);
    if (!h) return [];
    const oc = open(OPENCODE_DB);
    try {
        const now = Date.now();
        const since = now - hours * 3600_000;
        const sessions = h.prepare(
            `SELECT * FROM sessions WHERE closed_at IS NULL OR updated_at > ? OR created_at > ?
             ORDER BY created_at DESC LIMIT 60`).all(since, since);
        return sessions.map((s) => worker(h, oc, s, now));
    } finally {
        h.close();
        oc?.close();
    }
}

const html = () => readFileSync(join(HERE, 'index.html'));

createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/api/workers') {
            const hours = Math.min(24 * 30, Math.max(0.25, Number(url.searchParams.get('hours')) || DEFAULT_HOURS));
            const body = JSON.stringify({ now: Date.now(), hours, stallMs: STALL_MS, workers: workers(hours) });
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            return res.end(body);
        }
        if (url.pathname === '/api/orchestra/config') {
            let config = {
                cwd: "D:\\OffHours",
                coordinator: { tool: "opencode", model: "opencode/space-bunny-free", autoOpenTerminal: true },
                workers: [
                    { id: "1", tool: "opencode", model: "nim-1/z-ai/glm-5.3-flash", label: "NIM-Worker-1", prompt: "Hazır ol ve bekle." },
                    { id: "2", tool: "opencode", model: "nim-2/z-ai/glm-5.3-flash", label: "NIM-Worker-2", prompt: "Hazır ol ve bekle." },
                    { id: "3", tool: "opencode", model: "nim-3/z-ai/glm-5.3-flash", label: "NIM-Worker-3", prompt: "Hazır ol ve bekle." },
                    { id: "4", tool: "agy", model: "", label: "AGY Worker", prompt: "Hazır ol ve bekle." },
                    { id: "5", tool: "opencode", model: "openrouter/openrouter/free", label: "OpenRouter-Free", prompt: "Hazır ol ve bekle." }
                ]
            };
            if (existsSync(TEAM_CONFIG_PATH)) {
                try {
                    config = JSON.parse(readFileSync(TEAM_CONFIG_PATH, 'utf8'));
                } catch {}
            }
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            return res.end(JSON.stringify(config));
        }
        if (url.pathname === '/api/orchestra/save' && req.method === 'POST') {
            const body = await readBodyJson(req);
            writeFileSync(TEAM_CONFIG_PATH, JSON.stringify(body, null, 2), 'utf8');

            if (Array.isArray(body.newProviders) && body.newProviders.length > 0 && existsSync(OPENCODE_CONFIG_PATH)) {
                try {
                    const ocConfig = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, 'utf8'));
                    if (!ocConfig.provider) ocConfig.provider = {};
                    for (const p of body.newProviders) {
                        if (p.id && p.apiKey) {
                            ocConfig.provider[p.id] = {
                                npm: "@ai-sdk/openai-compatible",
                                name: p.name || p.id,
                                api: p.baseUrl || "https://integrate.api.nvidia.com/v1",
                                options: { apiKey: p.apiKey },
                                models: {
                                    [p.model || "default"]: { name: p.modelName || p.model || "Default Model" }
                                }
                            };
                        }
                    }
                    writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(ocConfig, null, 4), 'utf8');
                } catch (err) {
                    console.error("Failed to update opencode.jsonc:", err);
                }
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        if (url.pathname === '/api/orchestra/launch' && req.method === 'POST') {
            const body = await readBodyJson(req);
            const cwd = body.cwd || "D:\\OffHours";
            const workersList = body.workers || [];

            writeFileSync(TEAM_CONFIG_PATH, JSON.stringify({
                cwd,
                coordinator: body.coordinator || { tool: "opencode", model: "opencode/space-bunny-free", autoOpenTerminal: true },
                workers: workersList
            }, null, 2), 'utf8');

            const started = [];
            for (const w of workersList) {
                try {
                    const resOpen = await callDaemon('/open', {
                        tool: w.tool,
                        cwd,
                        roots: [cwd],
                        label: w.label,
                        model: w.model || undefined,
                        prompt: w.prompt || "Hazır ol ve bekle."
                    });
                    started.push({ id: resOpen.session.id, label: w.label, ok: true });
                } catch (e) {
                    started.push({ label: w.label, ok: false, error: e.message });
                }
            }

            const openTerm = body.coordinator?.autoOpenTerminal !== false;
            if (openTerm && process.platform === 'win32') {
                try {
                    const term = spawn('cmd.exe', ['/c', 'start', 'wt.exe', '-d', cwd, 'opencode'], {
                        detached: true,
                        stdio: 'ignore'
                    });
                    term.unref();
                } catch {
                    const term = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `cd /d "${cwd}" && opencode`], {
                        detached: true,
                        stdio: 'ignore'
                    });
                    term.unref();
                }
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, started, cwd }));
        }
        if (url.pathname === '/api/orchestra/stop' && req.method === 'POST') {
            const { sessions } = await callDaemon('/list', { includeClosed: false });
            const live = (sessions || []).filter((s) => !s.closedAt);
            for (const s of live) {
                await callDaemon('/close', { sessionId: s.id });
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, closedCount: live.length }));
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end(html());
        }
        res.writeHead(404); res.end('not found');
    } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message ?? e) }));
    }
}).listen(PORT, '127.0.0.1', () => console.log(`ORCH OFFICE on http://localhost:${PORT}`));
