// Builds a throwaway sample database so the office can be previewed without
// any real sessions: node office/demo-db.mjs [path]  (default /tmp/orch-office-demo.db)
// The data is illustrative only; the office itself always reads real sessions.
import { DatabaseSync } from 'node:sqlite';
import { rmSync, writeFileSync } from 'node:fs';

const path = process.argv[2] ?? '/tmp/orch-office-demo.db';
rmSync(path, { force: true });
const db = new DatabaseSync(path);
db.exec(`
CREATE TABLE sessions (id TEXT PRIMARY KEY, tool TEXT NOT NULL, native TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL,
  model TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  closed_at INTEGER, root_pid INTEGER, totals TEXT NOT NULL, worktree_path TEXT, worktree_branch TEXT, repo_root TEXT);
CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, prompt TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, usage TEXT NOT NULL, aborted INTEGER NOT NULL DEFAULT 0,
  result_text TEXT NOT NULL DEFAULT '');
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE jobs (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, path TEXT NOT NULL,
  text TEXT NOT NULL, items TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE grades (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, pct REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);`);

const now = Date.now();
const workers = [
    { id: 'demo-1', tool: 'opencode', model: 'opencode/space-bunny-free', label: 'api-pagination', running: true,
      prompt: 'Add cursor pagination to GET /orders and cover it with tests.',
      report: 'Cursor pagination wired into GET /orders. Tests still failing locally (2 failing).',
      job: {
        path: '.orch/jobs/demo_pagination.txt',
        text: 'JOB — cursor pagination for GET /orders.\nDO, only in these files:\n' +
          ' 1) src/routes/orders.ts (read it whole once): accept ?cursor and ?limit, return { orders, nextCursor }.\n' +
          ' 2) test/orders.test.ts: cover first page, mid-list cursor and end of list.\n' +
          'Checks: npm test -- orders (all green). Report files + real last lines.',
        items: [
          { id: 1, text: 'Add cursor pagination to GET /orders (orders.ts)', files: ['src/routes/orders.ts'], tests: [] },
          { id: 2, text: 'Cover the new endpoint with tests (orders.test.ts) and show them passing', files: ['test/orders.test.ts'], tests: ['test/orders.test.ts'] },
        ],
      },
      grade: { pct: 0.75, note: 'Pagination works; tests still needed.', minutesAgo: 4 },
      tools: [['read', { filePath: 'src/routes/orders.ts' }], ['grep', { pattern: 'limit' }],
        ['todowrite', { todos: [{ content: 'Add cursor pagination to GET /orders', status: 'completed' }, { content: 'Cover the new endpoint with tests', status: 'pending' }] }],
        ['edit', { filePath: 'src/routes/orders.ts' }], ['bash', { command: 'npm test -- orders' }]] },
    { id: 'demo-2', tool: 'agy', model: 'gemini-flash-high', label: 'ui-dark-mode', running: true,
      prompt: 'Add a light theme next to the dark one and a switch in settings.',
      tools: [['read', { filePath: 'lib/theme/colors.dart' }], ['edit', { filePath: 'lib/theme/light.dart' }], ['bash', { command: 'flutter test' }]] },
    { id: 'demo-3', tool: 'opencode', model: 'provider-a/glm-flash', label: 'auth-refactor', running: false,
      prompt: 'Split the auth middleware into token parsing and session checks.',
      reply: 'Done: auth.ts now only parses tokens; session.ts holds the checks. npm test: 212 passed, 0 failed.',
      job: {
        path: '.orch/jobs/demo_auth_split.txt',
        text: 'JOB — split the auth middleware.\nDO, only in these files:\n' +
          ' 1) src/middleware/auth.ts: keep only token parsing.\n' +
          ' 2) src/middleware/session.ts: move the session checks here.\n' +
          'Checks: npm test (all green). Report files + real last lines.',
        items: [
          { id: 1, text: 'Split auth middleware: token parsing stays in auth.ts, session checks move to session.ts', files: ['src/middleware/auth.ts', 'src/middleware/session.ts'], tests: [] },
          { id: 2, text: 'Full test suite green after the refactor', files: [], tests: ['npm test'] },
        ],
      },
      tools: [['read', { filePath: 'src/middleware/auth.ts' }], ['edit', { filePath: 'src/middleware/session.ts' }],
        ['todowrite', { todos: [{ content: 'Split auth middleware: token parsing in auth.ts, session checks in session.ts', status: 'completed' }, { content: 'Full test suite green after the refactor', status: 'completed' }] }],
        ['edit', { filePath: 'src/middleware/auth.ts' }], ['bash', { command: 'npm test' }]] },
    { id: 'demo-4', tool: 'claude', model: 'claude-sonnet', label: 'docs-writer', running: false, ratelimited: true,
      prompt: 'Write the migration guide for v2.', tools: [['read', { filePath: 'CHANGELOG.md' }]] },
];
const insS = db.prepare('INSERT INTO sessions (id,tool,cwd,model,label,created_at,updated_at,totals) VALUES (?,?,?,?,?,?,?,?)');
const insT = db.prepare('INSERT INTO turns (session_id,prompt,started_at,ended_at,usage,result_text) VALUES (?,?,?,?,?,?)');
const insE = db.prepare('INSERT INTO events (session_id,at,payload) VALUES (?,?,?)');
const insJ = db.prepare('INSERT INTO jobs (session_id,path,text,items,created_at) VALUES (?,?,?,?,?)');
const insG = db.prepare('INSERT INTO grades (session_id,pct,note,at) VALUES (?,?,?,?)');
const start = {};
workers.forEach((w, i) => {
    const t0 = now - (20 - i * 3) * 60_000;
    start[w.id] = t0;
    insS.run(w.id, w.tool, '~/projects/acme-app', w.model, w.label, t0, now, JSON.stringify({ inputTokens: 40000, outputTokens: 3000 }));
    insT.run(w.id, w.prompt, t0, w.running ? null : now - 60_000, '{}', w.report ?? w.reply ?? '');
    w.tools.forEach(([name, input], k) =>
        insE.run(w.id, t0 + (k + 1) * 60_000, JSON.stringify({ t: 'tool.call', id: `${w.id}-${k}`, name, input })));
    if (w.report) insE.run(w.id, t0 + (w.tools.length + 1) * 60_000, JSON.stringify({ t: 'text.delta', text: w.report }));
    if (w.reply) insE.run(w.id, now - 60_000, JSON.stringify({ t: 'turn.completed', usage: { outputTokens: 1840 } }));
    if (w.ratelimited) insE.run(w.id, now - 30_000, JSON.stringify({ t: 'error', kind: 'rate_limit', message: 'rate limited, retry later' }));
    if (w.job) insJ.run(w.id, w.job.path, w.job.text, JSON.stringify(w.job.items), t0 + 30_000);
    if (w.grade) insG.run(w.id, w.grade.pct, w.grade.note, now - w.grade.minutesAgo * 60_000);
});

// demo-2 (agy): per-step usage events so the thrift metrics have waste to chew on.
// Three steps before the edit (t0+1m..t0+3m), then four steps after it — everything
// after the last edit of a turn counts as waste.
const step = (at, input, cacheRead, output) =>
    insE.run('demo-2', at, JSON.stringify({ t: 'usage.step', usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output } }));
for (let k = 0; k < 3; k++) step(start['demo-2'] + (k + 1) * 45_000, 1000, 4000, 300);
for (let k = 0; k < 4; k++) step(start['demo-2'] + (4 + k) * 45_000, 1200, 6000, 250);

// Programs rollup (loaded via ORCH_PROGRAMS_FILE; see programsPath() in src/core/programs.ts).
const programsPath = `${path}.programs.json`;
rmSync(programsPath, { force: true });
writeFileSync(programsPath, JSON.stringify({
    programs: [{
        id: 'acme-v2', name: 'Acme v2 rollout', items: [
            { job: '.orch/jobs/demo_pagination.txt', weight: 1, sessions: ['demo-1'] },
            { job: '.orch/jobs/demo_auth_split.txt', weight: 2, sessions: ['demo-3'] },
        ],
    }],
}, null, 2));
console.log(`demo db written to ${path}`);
console.log(`now run: ORCH_DB=${path} ORCH_PROGRAMS_FILE=${programsPath} npm run office`);
