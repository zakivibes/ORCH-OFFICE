// Builds a throwaway sample database so the office can be previewed without
// any real sessions: node office/demo-db.mjs [path]  (default /tmp/orch-office-demo.db)
// The data is illustrative only; the office itself always reads real sessions.
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

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
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);`);

const now = Date.now();
const workers = [
    { id: 'demo-1', tool: 'opencode', model: 'opencode/space-bunny-free', label: 'api-pagination', running: true,
      prompt: 'Add cursor pagination to GET /orders and cover it with tests.',
      tools: [['read', { filePath: 'src/routes/orders.ts' }], ['grep', { pattern: 'limit' }], ['edit', { filePath: 'src/routes/orders.ts' }], ['bash', { command: 'npm test -- orders' }]] },
    { id: 'demo-2', tool: 'agy', model: 'gemini-flash-high', label: 'ui-dark-mode', running: true,
      prompt: 'Add a light theme next to the dark one and a switch in settings.',
      tools: [['read', { filePath: 'lib/theme/colors.dart' }], ['edit', { filePath: 'lib/theme/light.dart' }], ['bash', { command: 'flutter test' }]] },
    { id: 'demo-3', tool: 'opencode', model: 'provider-a/glm-flash', label: 'auth-refactor', running: false,
      prompt: 'Split the auth middleware into token parsing and session checks.',
      tools: [['read', { filePath: 'src/middleware/auth.ts' }], ['edit', { filePath: 'src/middleware/session.ts' }], ['bash', { command: 'npm test' }]],
      reply: 'Done: auth.ts now only parses tokens; session.ts holds the checks. 212/212 tests pass.' },
    { id: 'demo-4', tool: 'claude', model: 'claude-sonnet', label: 'docs-writer', running: false, ratelimited: true,
      prompt: 'Write the migration guide for v2.', tools: [['read', { filePath: 'CHANGELOG.md' }]] },
];
const insS = db.prepare('INSERT INTO sessions (id,tool,cwd,model,label,created_at,updated_at,totals) VALUES (?,?,?,?,?,?,?,?)');
const insT = db.prepare('INSERT INTO turns (session_id,prompt,started_at,ended_at,usage,result_text) VALUES (?,?,?,?,?,?)');
const insE = db.prepare('INSERT INTO events (session_id,at,payload) VALUES (?,?,?)');
workers.forEach((w, i) => {
    const t0 = now - (20 - i * 3) * 60_000;
    insS.run(w.id, w.tool, '~/projects/acme-app', w.model, w.label, t0, now, JSON.stringify({ inputTokens: 40000, outputTokens: 3000 }));
    insT.run(w.id, w.prompt, t0, w.running ? null : now - 60_000, '{}', w.reply ?? '');
    w.tools.forEach(([name, input], k) =>
        insE.run(w.id, t0 + (k + 1) * 60_000, JSON.stringify({ t: 'tool.call', id: `${w.id}-${k}`, name, input })));
    if (w.reply) insE.run(w.id, now - 60_000, JSON.stringify({ t: 'turn.completed', usage: { outputTokens: 1840 } }));
    if (w.ratelimited) insE.run(w.id, now - 30_000, JSON.stringify({ t: 'error', kind: 'rate_limit', message: 'rate limited, retry later' }));
});
console.log(`demo db written to ${path}\nnow run: ORCH_DB=${path} npm run office`);
