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
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Hand-off notebook (pure functions over stored events); the Office still works without a build.
const NB = await import(pathToFileURL(join(HERE, '..', 'dist', 'core', 'notebook.js')).href).catch(() => null);
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
// opencode accepts either name; use the one this machine actually has (.json first).
const OPENCODE_CONFIG_PATH = ['opencode.json', 'opencode.jsonc']
    .map((f) => join(homedir(), '.config', 'opencode', f))
    .find((f) => existsSync(f)) ?? join(homedir(), '.config', 'opencode', 'opencode.json');
const DAEMON_ENTRY_PATH = join(HERE, '..', 'dist', 'core', 'daemon-entry.js');

// O1's job scoring and program rollup (src/core/jobs|progress|programs.ts, compiled by
// `npm run build`). Imported here, never re-implemented — the office is a viewer.
let coreJobs = null, coreProgress = null, corePrograms = null;
try {
    const core = (p) => import(pathToFileURL(join(HERE, '..', 'dist', 'core', p)).href);
    [coreJobs, coreProgress, corePrograms] =
        await Promise.all([core('jobs.js'), core('progress.js'), core('programs.js')]);
} catch {
    console.error('orch core (dist/) not found — job scoring and programs disabled. Run: npm run build');
}

let openCodeProviderNames = {};
try {
    const ocConfig = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, 'utf8'));
    if (ocConfig.provider) {
        for (const [id, p] of Object.entries(ocConfig.provider)) {
            openCodeProviderNames[id] = p.name || id;
        }
    }
} catch {}

const DISCOUNT_CONFIG_PATH = join(homedir(), '.orchestrator', 'config.json');

function getDaemonPort() {
    try {
        if (existsSync(DAEMON_PID_PATH)) {
            const data = JSON.parse(readFileSync(DAEMON_PID_PATH, 'utf8'));
            if (data.port) return data.port;
        }
    } catch {}
    return 47811;
}

async function isDaemonAlive(port) {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/ping`, {
            method: 'POST',
            signal: AbortSignal.timeout(1000)
        });
        return r.ok;
    } catch {
        return false;
    }
}

async function ensureDaemon() {
    const port = getDaemonPort();
    if (await isDaemonAlive(port)) return port;

    if (existsSync(DAEMON_ENTRY_PATH)) {
        console.log('Orchestrator daemon baslatiliyor...');
        const child = spawn(process.execPath, [DAEMON_ENTRY_PATH], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();

        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 150));
            const p = getDaemonPort();
            if (await isDaemonAlive(p)) return p;
        }
    }
    return port;
}

async function callDaemon(route, body = {}) {
    const port = await ensureDaemon();
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

function launchCoordinatorWindow(cwd, coordinator) {
    if (process.platform !== 'win32') return;
    const tool = (coordinator?.tool || 'opencode').toLowerCase();
    const coordModel = (coordinator?.model || '').trim();

    let title = 'ORCH Coordinator';
    let execCmd = 'call opencode';

    if (tool === 'claude') {
        title = 'ORCH Coordinator - Claude Code';
        if (coordModel && coordModel !== 'default' && coordModel !== 'sonnet') {
            execCmd = `call claude --model ${coordModel}`;
        } else {
            execCmd = 'call claude';
        }
    } else if (tool === 'agy') {
        title = 'ORCH Coordinator - AGY';
        if (coordModel && coordModel !== 'default') {
            execCmd = `call agy --model ${coordModel}`;
        } else {
            execCmd = 'call agy';
        }
    } else {
        title = 'ORCH Coordinator - OpenCode';
        if (coordModel && existsSync(OPENCODE_CONFIG_PATH)) {
            try {
                const raw = readFileSync(OPENCODE_CONFIG_PATH, 'utf8');
                const updated = raw.replace(/"model":\s*"[^"]*"/, `"model": "${coordModel}"`);
                writeFileSync(OPENCODE_CONFIG_PATH, updated, 'utf8');
            } catch (err) {
                console.error('Failed to update coordinator model in opencode.jsonc:', err);
            }
        }
        execCmd = 'call opencode';
    }

    const batPath = join(homedir(), '.orchestrator', 'run-coordinator.bat');
    const content = [
        '@echo off',
        `cd /d "${cwd}"`,
        `title ${title}`,
        'echo ====================================================',
        `echo        ORCH OFFICE - Lead Coordinator CLI (${tool.toUpperCase()})`,
        'echo ====================================================',
        'echo.',
        execCmd,
        'cmd /k'
    ].join('\r\n');
    writeFileSync(batPath, content, 'utf8');

    const term = spawn('cmd.exe', ['/c', 'start', '""', batPath], {
        detached: true,
        stdio: 'ignore'
    });
    term.unref();
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

// The five token kinds a usage record carries (Usage in src/core/types.ts).
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens', 'cacheWriteTokens'];
function tokensSum(u) {
    if (!u) return 0;
    let t = 0;
    for (const k of TOKEN_KEYS) t += Number(u[k] ?? 0);
    return t;
}

// Read-only reconnaissance tools (limits.ts counts the same set), plus code-graph lookups.
const EXPLORE_TOOLS = /^(read|view_file|glob|list|list_dir|grep|grep_search|find_by_name)$/i;
const GRAPHIFY_RE = /graphify/i;

// --- Jobs, grades, thrift ------------------------------------------------

// Scored checklist for a session: O1's progress.ts (imported, never copied) run over the raw
// event log. Cached until the session's events/turns/job/grade state changes, so the 3s poll
// of /api/workers does not rescore every time. Returns null when the session has neither.
const jobCache = new Map();
function jobProgressFor(h, sessionId) {
    const job = h.prepare('SELECT * FROM jobs WHERE session_id = ?').get(sessionId);
    const grade = h.prepare('SELECT * FROM grades WHERE session_id = ?').get(sessionId);
    if (!job && !grade) return null;
    const nEvents = h.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c;
    const nTurns = h.prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id = ?').get(sessionId).c;
    const key = `${nEvents}|${nTurns}|${job?.created_at ?? ''}|${grade?.at ?? ''}`;
    const hit = jobCache.get(sessionId);
    if (hit && hit.key === key) return hit.value;

    // items JSON first (what setJob stored); fall back to re-parsing the raw job text.
    let items = [];
    if (job) {
        try {
            const parsed = JSON.parse(String(job.items ?? '[]'));
            if (Array.isArray(parsed) && parsed.length) items = parsed;
        } catch { /* older rows keep only the text */ }
        if (!items.length && coreJobs && job.text) {
            try { items = coreJobs.parseJob(String(job.text)).items; } catch { /* keep [] */ }
        }
    }
    let scored = [], autoPct = null;
    if (job && items.length) {
        if (coreProgress) {
            const events = h.prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY seq LIMIT 200000')
                .all(sessionId).map((e) => parse(e.payload));
            const turns = h.prepare('SELECT result_text FROM turns WHERE session_id = ? ORDER BY id').all(sessionId)
                .map((t) => ({ resultText: String(t.result_text ?? '') }));
            const r = coreProgress.scoreItems(items, events, turns);
            scored = r.items;
            autoPct = r.autoPct;
        } else {
            autoPct = 0; // dist not built — say so instead of pretending the job is untouched
        }
    }
    const value = {
        job: job ? { path: job.path, text: job.text, createdAt: Number(job.created_at) } : null,
        items: scored,
        autoPct,
        accepted: grade ? { pct: Number(grade.pct), note: String(grade.note ?? ''), at: Number(grade.at) } : null,
    };
    if (jobCache.size > 500) jobCache.clear();
    jobCache.set(sessionId, { key, value });
    return value;
}

// Thrift metrics (plan A3/A5): what the session spent per unit of work, how much of the spend
// was re-sent context, and how many tokens went to turns/steps that produced no further edit.
// Counts distinct call ids like worker() does, and reads only tool.call/usage.step events.
function thriftMetrics(h, oc, s, turns, totals, now) {
    const perTurn = turns.map((t, i) => ({
        n: i + 1, startedAt: t.started_at, endedAt: t.ended_at,
        calls: 0, edits: 0, explores: 0, graphify: 0, firstWriteStep: null,
        editLastAt: null, stepTokens: 0, stepTokensAfterEdit: 0, hasStepData: false,
    }));
    // An event belongs to the turn that was running when it arrived.
    const segs = perTurn.map((pt, i) => ({
        pt, start: turns[i].started_at,
        end: i + 1 < turns.length ? turns[i + 1].started_at : Number.MAX_SAFE_INTEGER,
    }));
    const segOf = (at) => segs.find((g) => at >= g.start && at < g.end);

    const seen = new Set();
    for (const r of h.prepare(`
            SELECT at, json_extract(payload, '$.t') AS t, json_extract(payload, '$.name') AS name,
                   json_extract(payload, '$.id') AS id, json_extract(payload, '$.usage') AS us
              FROM events WHERE session_id = ? AND json_extract(payload, '$.t') IN ('tool.call', 'usage.step')
             ORDER BY seq`).all(s.id)) {
        const g = segOf(Number(r.at));
        if (!g) continue;
        const pt = g.pt;
        if (r.t === 'usage.step') {
            const n = tokensSum(parse(r.us));
            pt.stepTokens += n;
            if (pt.editLastAt != null && Number(r.at) >= pt.editLastAt) pt.stepTokensAfterEdit += n;
            pt.hasStepData = true;
            continue;
        }
        const id = String(r.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        pt.calls++;
        const name = String(r.name ?? '');
        if (WRITE_TOOLS.test(name)) {
            pt.edits++;
            pt.editLastAt = Number(r.at);
            if (pt.firstWriteStep == null) pt.firstWriteStep = pt.calls - 1;
        } else if (EXPLORE_TOOLS.test(name)) pt.explores++;
        else if (GRAPHIFY_RE.test(name)) pt.graphify++;
    }

    // Per-turn tokens: opencode's ledger when readable, else agy-style usage.step sums.
    const useOc = s.tool === 'opencode' && s.native && oc;
    let waste = 0, wasteKnown = false;
    for (let i = 0; i < turns.length; i++) {
        const t = turns[i], pt = perTurn[i];
        const turnEnd = t.ended_at ?? now;
        let turnTokens = null;
        if (useOc) {
            try { turnTokens = tokensSum(opencodeUsage(oc, s.native, t.started_at, turnEnd).usage); } catch { /* fall back */ }
        }
        if (turnTokens == null && pt.hasStepData) turnTokens = pt.stepTokens;
        if (turnTokens == null) { pt.processed = null; pt.waste = null; continue; }
        let w = 0;
        if (pt.edits === 0) w = turnTokens;                 // wrote nothing: the whole turn was waste
        else if (pt.editLastAt != null) {
            if (useOc) {
                try { w = tokensSum(opencodeUsage(oc, s.native, pt.editLastAt, turnEnd).usage); } catch { w = 0; }
            } else {
                w = pt.stepTokensAfterEdit;
            }
        }
        pt.processed = turnTokens;
        pt.waste = w;
        waste += w;
        wasteKnown = true;
    }

    const edits = perTurn.reduce((a, p) => a + p.edits, 0);
    const explores = perTurn.reduce((a, p) => a + p.explores, 0);
    const graphify = perTurn.reduce((a, p) => a + p.graphify, 0);
    const processed = tokensSum(totals);
    const readTokens = Number(totals?.inputTokens ?? 0) + Number(totals?.cacheReadTokens ?? 0);
    return {
        calls: seen.size, edits, explores, graphify,
        tokensPerEdit: edits > 0 ? processed / edits : null,
        exploreRatio: edits > 0 ? explores / edits : null,
        stepsBeforeFirstWrite: perTurn.reduce((a, p) => Math.max(a, p.firstWriteStep ?? 0), 0),
        cachedShare: readTokens > 0 ? Number(totals?.cacheReadTokens ?? 0) / readTokens : 0,
        waste: wasteKnown ? waste : null,
        wasteShare: wasteKnown && processed > 0 ? waste / processed : null,
        processed,
        perTurn: perTurn.map(({ editLastAt, stepTokens, stepTokensAfterEdit, hasStepData, ...rest }) => rest),
    };
}

// Whole-session tokens for program rollups: opencode's ledger when readable, else orch's totals.
function sessionTokensFor(oc, s) {
    if (s.tool === 'opencode' && s.native && oc) {
        try {
            const u = opencodeUsage(oc, s.native);
            if (u.steps > 0) return tokensSum(u.usage);
        } catch { /* fall back */ }
    }
    return tokensSum(parse(s.totals));
}

function worker(h, oc, s, now, detail = false) {
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

    // conversation: last 30 turns as chat bubbles (prompt / reply)
    let conversation = null;
    if (detail) {
        const last30 = turns.slice(-30);
        let runningText = '';
        let runningThinking = '';
        if (running) {
            runningText = events.filter((e) => e.ev.t === 'text.delta' && e.at >= lastTurn.started_at)
                .map((e) => e.ev.text).join('');
            runningThinking = events.filter((e) => e.ev.t === 'thinking.delta' && e.at >= lastTurn.started_at)
                .map((e) => e.ev.text).join('');
        }
        conversation = last30.map((t, i) => {
            const isRunning = running && t.id === lastTurn.id;
            let prompt = String(t.prompt || '');
            if (prompt.length > 50000) prompt = prompt.slice(0, 50000) + '…(cut)';
            let reply = isRunning ? runningText : String(t.result_text || '');
            if (reply.length > 50000) reply = reply.slice(-50000);
            let usage = { ...ZERO(), ...parse(t.usage) };
            if (useOc) {
                try {
                    const u = opencodeUsage(oc, s.native, t.started_at, t.ended_at ?? Number.MAX_SAFE_INTEGER);
                    if (u.steps > 0) usage = u.usage;
                } catch { /* fall back */ }
            }
            const entry = {
                n: turns.length - last30.length + i + 1,
                startedAt: t.started_at,
                endedAt: t.ended_at,
                prompt,
                reply,
                aborted: !!t.aborted,
                usage,
            };
            let thinking = '';
            const turnThinking = events
                .filter((e) => e.ev.t === 'thinking.delta' && e.at >= t.started_at && (!t.ended_at || e.at <= t.ended_at))
                .map((e) => e.ev.text).join('');
            if (turnThinking) {
                thinking = turnThinking;
            } else if (isRunning && runningThinking) {
                thinking = runningThinking;
            }
            if (thinking) entry.thinking = thinking;

            const turnTools = events
                .filter((e) => e.ev.t === 'tool.call' && e.at >= t.started_at && (!t.ended_at || e.at <= t.ended_at))
                .map((e) => ({ id: e.ev.id, name: e.ev.name, summary: summariseInput(e.ev.input) }));
            if (turnTools.length) entry.tools = turnTools;

            return entry;
        });
    }

    // Job progress (O1): auto-scored checklist % plus the accepted grade, when one exists.
    const jp = jobProgressFor(h, s.id);

    return {
        id: s.id,
        label: s.label || s.id.slice(0, 8),
        tool: s.tool,
        model: s.model,
        provider: providerInfo(s.tool, s.model).provider,
        providerName: providerInfo(s.tool, s.model).providerName,
        cwd: s.cwd.replace(homedir(), '~'),
        createdAt: s.created_at,
        closedAt: s.closed_at,
        totals, costUsd, usageSource,
        state, stalled, lastAt, lastText,
        toolCalls, breakdown,
        jobPct: jp ? {
            auto: jp.autoPct,
            accepted: jp.accepted ? jp.accepted.pct : null,
            gradeNote: jp.accepted ? jp.accepted.note : null,
            gradeAt: jp.accepted ? jp.accepted.at : null,
            itemsCount: jp.items.length,
            items: jp.items,
            jobPath: jp.job ? jp.job.path : null,
            jobText: jp.job ? jp.job.text : null,
            hasJob: !!jp.job,
        } : null,
        turns: turns.length,
        turnRows: turnRows.slice(-30),
        current,
        files: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([path, at]) => ({ path, at })),
        task: turns[0]?.prompt ?? '',
        lastPrompt: lastTurn?.prompt ?? '',
        reply: (lastTurn?.result_text || text).slice(-3000),
        feed: feed.slice(-60),
        conversation,
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
        const discounts = getDiscounts();
        const ws = sessions.map((s) => worker(h, oc, s, now));
        for (const w of ws) {
            for (const d of discounts) {
                if (String(w.model).includes(d.match)) {
                    w.discount = discountStatus(d, now);
                    break;
                }
            }
            if (!w.discount) w.discount = null;
        }
        return ws;
    } finally {
        h.close();
        oc?.close();
    }
}

const html = () => readFileSync(join(HERE, 'index.html'));


// Session budget, from the same file the daemon reads (src/core/limits.ts), so the dashboard can
// show how close each worker is to being stopped.
function sessionLimits() {
    const file = process.env.ORCH_LIMITS_FILE || join(homedir(), '.orchestrator', 'limits.json');
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { /* defaults */ }
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    return {
        maxSessionReadTokens: num(cfg.maxSessionReadTokens ?? process.env.ORCH_MAX_SESSION_READ_TOKENS, 60_000_000),
        maxTurnSteps: num(cfg.maxTurnSteps ?? process.env.ORCH_MAX_TURN_STEPS, 250),
        // The exploration guards (loopGuard/graphify reminders) — the thrift strip colors against these.
        maxStepsBeforeFirstEdit: num(cfg.maxStepsBeforeFirstEdit ?? process.env.ORCH_MAX_STEPS_BEFORE_FIRST_EDIT, 40),
        maxExploreSinceLastEdit: num(cfg.maxExploreSinceLastEdit ?? process.env.ORCH_MAX_EXPLORE_SINCE_LAST_EDIT, 60),
        maxExploreBeforeGraph: num(cfg.maxExploreBeforeGraph ?? process.env.ORCH_MAX_EXPLORE_BEFORE_GRAPH, 8),
        overrides: Array.isArray(cfg.overrides) ? cfg.overrides : [],
    };
}

function providerInfo(tool, model) {
    const toolkit = ['agy', 'claude'].includes(tool) ? tool : null;
    const provider = toolkit || (String(model).includes('/') ? String(model).split('/')[0] : tool);
    const providerName = openCodeProviderNames[provider] || provider;
    return { provider, providerName };
}

function getDiscounts() {
    try {
        const cfg = JSON.parse(readFileSync(DISCOUNT_CONFIG_PATH, 'utf8'));
        return cfg.discounts || [];
    } catch { return []; }
}

function discountStatus(discount, now) {
    const [fromH, fromM] = discount.from.split(':').map(Number);
    const [toH, toM] = discount.to.split(':').map(Number);
    const tz = discount.tz;
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const dp = {};
    fmt.formatToParts(new Date(now)).forEach(p => { if (p.type !== 'literal') dp[p.type] = Number(p.value); });
    const nowMinutes = dp.hour * 60 + dp.minute;
    const fromMinutes = fromH * 60 + fromM;
    const toMinutes = toH * 60 + toM;
    const makeIso = (h, m, addDays = 0) => {
        const dateStr = `${dp.year}-${String(dp.month).padStart(2, '0')}-${String(dp.day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
        const probe = new Date(dateStr);
        const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
        const tzName = offsetFmt.formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || 'GMT';
        const match = tzName.match(/GMT([+-])(\d+):(\d+)/);
        const offsetMin = match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
        const ms = Date.UTC(dp.year, dp.month - 1, dp.day + addDays, h, m, 0) - offsetMin * 60000;
        return new Date(ms).toISOString();
    };
    let startsAt = null, endsAt = null, active = false;
    if (fromMinutes <= toMinutes) {
        active = nowMinutes >= fromMinutes && nowMinutes < toMinutes;
        if (active) {
            endsAt = makeIso(toH, toM);
        } else {
            startsAt = nowMinutes >= toMinutes ? makeIso(fromH, fromM, 1) : makeIso(fromH, fromM);
        }
    } else {
        active = nowMinutes >= fromMinutes || nowMinutes < toMinutes;
        if (active) {
            endsAt = makeIso(toH, toM, nowMinutes >= fromMinutes ? 1 : 0);
        } else {
            startsAt = makeIso(fromH, fromM);
        }
    }
    return { label: discount.label, active, startsAt, endsAt, from: discount.from, to: discount.to };
}

// The orchestra endpoints start and stop agents and can write the opencode config, so only this
// page may call them. Binding to 127.0.0.1 is not enough on its own: any website open in the
// browser can send a "simple" cross-site POST to localhost. Requiring a JSON content type forces a
// CORS preflight (which this server never approves), and a foreign Origin is refused outright.
function sameOriginJson(req) {
    const origin = req.headers.origin;
    if (origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return false;
    return String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
}

// What earlier sessions of this session's job did, plus this session's own shape (Job tab).
function notebookFor(h, s) {
    if (!NB) return null;
    try {
        const job = h.prepare('SELECT path, text FROM jobs WHERE session_id = ?').get(s.id);
        if (!job) return null;
        const base = String(job.path).split('/').pop();
        const rows = h.prepare('SELECT s.id, s.label, s.model, s.created_at AS createdAt FROM sessions s JOIN jobs j ON j.session_id = s.id WHERE s.cwd = ? ORDER BY s.created_at').all(s.cwd)
            .filter((r) => r.id !== s.id && r.createdAt < s.created_at && String(h.prepare('SELECT path FROM jobs WHERE session_id = ?').get(r.id)?.path ?? '').split('/').pop() === base);
        const digestOf = (r) => NB.digestSession(r, h.prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY seq').all(r.id).map((e) => JSON.parse(e.payload)));
        const earlier = rows.map(digestOf);
        const self = digestOf({ id: s.id, label: s.label, model: s.model });
        const slim = (d) => ({ id: d.id, label: d.label, model: d.model, calls: d.calls, callsBeforeFirstEdit: d.callsBeforeFirstEdit, edits: d.edits.length, reads: d.reads.length, stops: d.stops.slice(-2), done: d.done });
        return {
            earlier: earlier.map(slim),
            self: { ...slim(self), reReads: NB.reReads(self, earlier) },
            handoff: NB.formatHandoff(earlier, { cwd: s.cwd, jobPath: job.path, jobText: job.text, sessionId: s.id }),
        };
    } catch { return null; }
}

createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (req.method !== 'GET' && url.pathname.startsWith('/api/') && !sameOriginJson(req)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'cross-origin or non-JSON request refused' }));
        }
        if (url.pathname === '/api/workers') {
            const hours = Math.min(24 * 30, Math.max(0.25, Number(url.searchParams.get('hours')) || DEFAULT_HOURS));
            const body = JSON.stringify({ now: Date.now(), hours, stallMs: STALL_MS, limits: sessionLimits(), workers: workers(hours) });
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            return res.end(body);
        }
        if (url.pathname === '/api/worker') {
            const id = url.searchParams.get('id');
            if (!id) {
                res.writeHead(400, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'missing id' }));
            }
            const h = open(DB_PATH);
            if (!h) {
                res.writeHead(500, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'db unavailable' }));
            }
            const oc = open(OPENCODE_DB);
            try {
                const now = Date.now();
                const row = h.prepare('SELECT * FROM sessions WHERE id LIKE ? LIMIT 1').get(id + '%');
                if (!row) {
                    res.writeHead(404, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'not found' }));
                }
                const w = worker(h, oc, row, now, true);
                const discounts = getDiscounts();
                for (const d of discounts) {
                    if (String(w.model).includes(d.match)) {
                        w.discount = discountStatus(d, now);
                        break;
                    }
                }
                if (!w.discount) w.discount = null;
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(JSON.stringify(w));
            } finally {
                h.close();
                if (oc) oc.close();
            }
            return;
        }
        // Full thrift + job detail for one session (the Job tab, Overview metrics, Turns table).
        if (url.pathname === '/api/job') {
            const id = url.searchParams.get('id');
            if (!id) {
                res.writeHead(400, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'missing id' }));
            }
            const h = open(DB_PATH);
            if (!h) {
                res.writeHead(500, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'db unavailable' }));
            }
            const oc = open(OPENCODE_DB);
            try {
                const now = Date.now();
                const s = h.prepare('SELECT * FROM sessions WHERE id LIKE ? LIMIT 1').get(id + '%');
                if (!s) {
                    res.writeHead(404, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'not found' }));
                }
                const turns = h.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY id').all(s.id);
                let totals = { ...ZERO(), ...parse(s.totals) };
                let costUsd = Number(s.cost_usd ?? 0);
                if (s.tool === 'opencode' && s.native && oc) {
                    try {
                        const all = opencodeUsage(oc, s.native);
                        if (all.steps > 0) { totals = all.usage; costUsd = all.costUsd; }
                    } catch { /* schema drift or locked db */ }
                }
                const jp = jobProgressFor(h, s.id) ?? { job: null, items: [], autoPct: null, accepted: null };
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                return res.end(JSON.stringify({
                    id: s.id,
                    label: s.label || s.id.slice(0, 8),
                    tool: s.tool,
                    model: s.model,
                    closedAt: s.closed_at,
                    job: jp.job,
                    items: jp.items,
                    autoPct: jp.autoPct,
                    accepted: jp.accepted,
                    metrics: thriftMetrics(h, oc, s, turns, totals, now),
                    limits: sessionLimits(),
                    costUsd,
                    notebook: notebookFor(h, s),
                }));
            } finally {
                h.close();
                oc?.close();
            }
        }
        // Accept/override a job's completion. Same table and 0..1 scale the daemon and MCP use,
        // so a grade saved here is visible to `orch_grade` and the daemon's /progress (and vice versa).
        if (url.pathname === '/api/grade' && req.method === 'POST') {
            const body = await readBodyJson(req);
            const id = String(body.id ?? '');
            const pct = Number(body.pct);
            const note = String(body.note ?? '').slice(0, 500);
            if (!id) {
                res.writeHead(400, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'missing id' }));
            }
            if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
                res.writeHead(400, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'pct must be a number between 0 and 100' }));
            }
            const h = new DatabaseSync(DB_PATH); // the office's single write: the grades table
            try {
                const s = h.prepare('SELECT id FROM sessions WHERE id LIKE ? LIMIT 1').get(id + '%');
                if (!s) {
                    res.writeHead(404, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'not found' }));
                }
                h.prepare(`INSERT INTO grades (session_id, pct, note, at) VALUES (?, ?, ?, ?)
                           ON CONFLICT(session_id) DO UPDATE SET pct = excluded.pct, note = excluded.note, at = excluded.at`)
                    .run(s.id, pct / 100, note, Date.now());
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, id: s.id, pct }));
            } finally {
                h.close();
            }
        }
        // Program rollups (O1's programs.ts): anchored completion per program and its sessions.
        if (url.pathname === '/api/programs') {
            if (!corePrograms) {
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                return res.end(JSON.stringify({ programs: [] }));
            }
            const h = open(DB_PATH);
            if (!h) {
                res.writeHead(500, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'db unavailable' }));
            }
            const oc = open(OPENCODE_DB);
            try {
                const sessionRow = (id) => h.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
                const pctOf = (id) => {
                    const jp = jobProgressFor(h, id);
                    if (!jp) return null;
                    if (jp.accepted) return jp.accepted.pct;
                    return jp.autoPct ?? 0;
                };
                const tokensOf = (id) => {
                    const s = sessionRow(id);
                    return s ? sessionTokensFor(oc, s) : 0;
                };
                const { programs } = corePrograms.loadPrograms();
                const body = programs.map((p) => {
                    const { pct, tokensSpent } = corePrograms.programPct(p, pctOf, tokensOf);
                    const weightSum = (p.items ?? []).reduce((a, i) => a + Number(i.weight || 0), 0);
                    const seenS = new Set();
                    const sessions = [];
                    for (const item of p.items ?? []) {
                        for (const sid of item.sessions ?? []) {
                            if (seenS.has(sid)) continue;
                            seenS.add(sid);
                            const pc = pctOf(sid);
                            let share = 0;
                            for (const it of p.items ?? []) {
                                if ((it.sessions ?? []).includes(sid)) share += Number(it.weight || 0) * (pc ?? 0);
                            }
                            const s = sessionRow(sid);
                            sessions.push({
                                id: sid,
                                label: s ? s.label || sid.slice(0, 8) : sid.slice(0, 8),
                                pct: pc,
                                share: weightSum > 0 ? share / weightSum : 0,
                                tokens: tokensOf(sid),
                            });
                        }
                    }
                    return {
                        id: p.id, name: p.name,
                        pct, tokensSpent,
                        tokensPerPct: pct > 0.0001 ? tokensSpent / (pct * 100) : null,
                        sessions,
                    };
                });
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                return res.end(JSON.stringify({ programs: body }));
            } finally {
                h.close();
                oc?.close();
            }
        }
        if (url.pathname === '/api/orchestra/config') {
            let config = {
                cwd: homedir(),
                coordinator: { tool: "opencode", model: "opencode/space-bunny-free", autoOpenTerminal: true },
                workers: [
                    { id: "1", tool: "opencode", model: "nim-1/z-ai/glm-5.3-flash", label: "NIM-Worker-1", prompt: "Get ready and wait for a task." },
                    { id: "2", tool: "opencode", model: "nim-2/z-ai/glm-5.3-flash", label: "NIM-Worker-2", prompt: "Get ready and wait for a task." },
                    { id: "3", tool: "opencode", model: "nim-3/z-ai/glm-5.3-flash", label: "NIM-Worker-3", prompt: "Get ready and wait for a task." },
                    { id: "4", tool: "agy", model: "", label: "AGY Worker", prompt: "Get ready and wait for a task." },
                    { id: "5", tool: "opencode", model: "openrouter/openrouter/free", label: "OpenRouter-Free", prompt: "Get ready and wait for a task." }
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
                    console.error(`Failed to update ${OPENCODE_CONFIG_PATH}:`, err);
                }
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        if (url.pathname === '/api/orchestra/launch-worker' && req.method === 'POST') {
            const body = await readBodyJson(req);
            const w = body.worker || {};
            const cwd = body.cwd || homedir();
            try {
                const resOpen = await callDaemon('/open', {
                    tool: w.tool,
                    cwd,
                    roots: [cwd],
                    label: w.label,
                    model: w.model || undefined,
                });
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, session: resOpen.session }));
            } catch (e) {
                res.writeHead(500, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        }
        if (url.pathname === '/api/orchestra/open-terminal' && req.method === 'POST') {
            const body = await readBodyJson(req);
            const cwd = body.cwd || homedir();
            const coordinator = body.coordinator || {};
            launchCoordinatorWindow(cwd, coordinator);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        if (url.pathname === '/api/orchestra/launch' && req.method === 'POST') {
            const body = await readBodyJson(req);
            const cwd = body.cwd || homedir();
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
                    });
                    started.push({ id: resOpen.session.id, label: w.label, ok: true });
                } catch (e) {
                    started.push({ label: w.label, ok: false, error: e.message });
                }
            }

            const openTerm = body.coordinator?.autoOpenTerminal !== false;
            if (openTerm && process.platform === 'win32') {
                launchCoordinatorWindow(cwd, body.coordinator);
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
        if (url.pathname === '/api/discounts') {
            const now = Date.now();
            const list = getDiscounts().map(d => discountStatus(d, now));
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            return res.end(JSON.stringify(list));
        }
        // Code graph (graphify) for the team's project: the tree view graphify writes with
        // `graphify tree`. Read-only; the project folder comes from team.json.
        if (url.pathname === '/graph') {
            let cwd = homedir();
            try { cwd = JSON.parse(readFileSync(TEAM_CONFIG_PATH, 'utf8')).cwd || cwd; } catch { /* default */ }
            const file = join(cwd, 'graphify-out', 'GRAPH_TREE.html');
            if (!existsSync(file)) {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                return res.end(`No code graph for ${cwd}.\nBuild one there with:\n  graphify update . --no-cluster && graphify tree --root .`);
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(readFileSync(file));
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
