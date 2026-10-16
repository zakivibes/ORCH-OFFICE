process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "../core/client.js";
import type { Event } from "../core/types.js";

/** MCP truncates tool output around 25k tokens, so never inline a transcript. */
const MAX_INLINE_CHARS = 10_000;

function roots(): { projectDir: string; rootList: string[] } {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const extra = (process.env.ORCH_EXTRA_ROOTS ?? "")
    .split(process.platform === "win32" ? ";" : /[:;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { projectDir, rootList: [projectDir, ...extra] };
}

const TOOLS = [
  {
    name: "orch_open",
    description:
      "Start a PERSISTENT agent session with claude, agy or opencode. The process stays alive so you can hold a multi-turn conversation with it via orch_send. Permissions are inherited from Claude Code's own settings. Returns a sessionId.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", enum: ["claude", "agy", "opencode"] },
        prompt: { type: "string", description: "First turn" },
        cwd: { type: "string", description: "Defaults to the Claude Code project directory." },
        label: { type: "string" },
        job: { type: "string", description: "Path to a job file; its text and code-graph anchors are added to the prompt." },
        model: {
          type: "string",
          description:
            "Optional. For opencode use provider/model, e.g. openrouter/anthropic/claude-haiku-latest.",
        },
        worktree: {
          type: "boolean",
          description:
            "Isolate the agent in its own git worktree so parallel agents cannot overwrite each other's files. Review with orch_diff, then orch_merge or orch_discard.",
        },
        deny: {
          type: "array",
          items: { type: "string" },
          description: "Extra deny rules like 'Bash(rm *)'. Only narrows; can never widen Claude Code's permissions.",
        },
        disableTools: { type: "array", items: { type: "string" } },
      },
      required: ["tool", "prompt"],
    },
  },
  {
    name: "orch_send",
    description:
      "Send another turn to a LIVE session. The agent keeps its conversation context from previous turns. Returns the reply text and a log path.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        prompt: { type: "string" },
        job: { type: "string", description: "Path to a job file; its text and code-graph anchors are added to the prompt." },
        waitMs: { type: "number", description: "Default 600000." },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "orch_stream",
    description: "Read normalized events for a session from a given sequence number.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, sinceSeq: { type: "number" } },
      required: ["sessionId"],
    },
  },
  {
    name: "orch_list",
    description: "List sessions, newest first.",
    inputSchema: { type: "object", properties: { includeClosed: { type: "boolean" } } },
  },
  {
    name: "orch_status",
    description: "Session detail: live state, token totals, and the effective permission policy.",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
  },
  {
    name: "orch_interrupt",
    description: "Abort the current turn but keep the session alive.",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
  },
  {
    name: "orch_close",
    description: "Close a session and terminate its process.",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
  },
  {
    name: "orch_roots",
    description:
      "Show the effective permission policy: which Claude Code settings files were read, the allow/ask/deny rules, and the directory roots workers may touch.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "orch_diff",
    description:
      "Show what a session's agent actually changed, as a unified diff. Only meaningful for sessions opened with worktree=true. Review before merging.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, statOnly: { type: "boolean" } },
      required: ["sessionId"],
    },
  },
  {
    name: "orch_merge",
    description:
      "Merge a session's worktree branch back into the base branch. Squashes by default; pass mode='merge' to keep history. Uncommitted agent work is committed on the branch first.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        mode: { type: "string", enum: ["squash", "merge"] },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "orch_discard",
    description: "Delete a session's worktree and branch, throwing away its work.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, force: { type: "boolean" } },
      required: ["sessionId"],
    },
  },
  {
    name: "orch_compare",
    description:
      "Run the same prompt against several models at once and return each answer, for cross-model validation. Uses model diversity deliberately: one model answering twice converges on its own bias.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        models: {
          type: "array",
          items: { type: "string" },
          description: "e.g. ['opencode/space-bunny-free','opencode/big-pickle']. Defaults to a few Zen models.",
        },
        tool: { type: "string", enum: ["opencode", "agy", "claude"], default: "opencode" },
        cwd: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "orch_models",
    description:
      "List the models opencode can currently reach, so you can pick one before calling orch_open. Filter with a substring such as 'zen', 'muse' or 'space-bunny'.",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string", description: "Case-insensitive substring." } },
    },
  },
  {
    name: "orch_cost",
    description: "Token and cost totals per tool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "orch_grade",
    description:
      "Set the coordinator's accepted % for a session (ground truth for the job it ran). Shows auto % next to it in orch_progress.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pct: { type: "number", description: "0..100" },
        note: { type: "string", description: "Why this grade." },
      },
      required: ["sessionId", "pct"],
    },
  },
  {
    name: "orch_progress",
    description:
      "How much of its job a session has done: per-item score with the evidence (todos, writes, passing tests, report) and the automatic %, plus the grade if you set one.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "orch_program",
    description:
      "Group job sessions into a program (e.g. 'Levels engine 1-201') and see its overall % and tokens spent. Actions: add {id,name}, link {id,job,sessionId}, weight {id,job,weight}, show {id?}.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "link", "weight", "show"] },
        id: { type: "string", description: "Program id." },
        name: { type: "string", description: "Program name (add)." },
        job: { type: "string", description: "Job file path (link/weight)." },
        sessionId: { type: "string", description: "Session to link (link)." },
        weight: { type: "number", description: "Item weight (weight)." },
      },
      required: ["action"],
    },
  },
] as const;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function truncate(s: string, cap = MAX_INLINE_CHARS): string {
  const t = s.trim();
  if (!t) return "(no text)";
  if (t.length <= cap) return t;
  return `${t.slice(0, cap)}\n... [truncated ${t.length - cap} chars — see the log]`;
}

function renderEvents(events: Event[]): string {
  let out = "";
  for (const e of events) if (e.t === "text.delta") out += e.text;
  return out;
}

export async function startMcpServer(): Promise<void> {
  const client = new DaemonClient();
  const { projectDir, rootList } = roots();

  const server = new Server(
    { name: "orchestrator", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as never }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;

    // MCP progress tokens let the client follow a long turn. Claude Code also
    // aborts a stdio tool call that goes silent for 30 minutes, so a long
    // orch_send should say something while it works.
    const meta = (req.params._meta ?? {}) as { progressToken?: string | number };
    const token = meta.progressToken;
    let lastSent = 0;
    const started = Date.now();
    const report = (message: string) => {
      if (token === undefined) return;
      const now = Date.now();
      if (now - lastSent < 1500) return; // rate-limit per spec guidance
      lastSent = now;
      void server
        .notification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: Math.round((now - started) / 1000),
            message,
          },
        })
        .catch(() => {
          /* the client may not listen; progress is advisory */
        });
    };

    try {
      switch (name) {
        case "orch_open": {
          report("spawning agent session");
          // Spawning plus the first turn can run for minutes; say something
          // periodically so the client does not think the call has hung.
          const spawnBeat = setInterval(() => report("agent working..."), 10_000);
          let r: Awaited<ReturnType<typeof client.open>>;
          try {
            r = await client.open({
              tool: String(a.tool),
              cwd: a.cwd ? String(a.cwd) : projectDir,
              roots: rootList,
              prompt: String(a.prompt ?? ""),
              label: a.label,
              job: a.job,
              model: a.model,
              narrow: { deny: a.deny, disableTools: a.disableTools },
              worktree: a.worktree === true,
            });
          } finally {
            clearInterval(spawnBeat);
          }
          return text(
            `session ${r.session.id}  tool=${r.session.tool}  native=${r.session.native}\n` +
              (r.session.worktreePath
                ? `worktree ${r.session.worktreePath} (branch ${r.session.worktreeBranch})\n`
                : "") +
              `${truncate(renderEvents(r.events ?? []))}\n` +
              `log: ${r.log}\n` +
              `This session stays live. Continue with orch_send using sessionId ${r.session.id}.`,
          );
        }

        case "orch_send": {
          report("turn started");
          const heartbeat = setInterval(() => report("agent working..."), 10_000);
          let r: { events: Event[]; log: string };
          try {
            r = await client.send({
              sessionId: String(a.sessionId),
              prompt: String(a.prompt ?? ""),
              job: a.job,
              waitMs: Number(a.waitMs ?? 600_000),
            });
          } finally {
            clearInterval(heartbeat);
          }
          const err = (r.events ?? []).find((e) => e.t === "error");
          if (err && err.t === "error") {
            return text(
              `error (${err.kind}): ${err.message}\n` +
                `retryAfterMs: ${err.retryAfterMs ?? "n/a"}\nlog: ${r.log}`,
            );
          }
          return text(`${truncate(renderEvents(r.events ?? []))}\nlog: ${r.log}`);
        }

        case "orch_stream": {
          const r = await client.stream({ sessionId: String(a.sessionId), sinceSeq: Number(a.sinceSeq ?? 0) });
          const body = r.events.map((e) => `${e.seq} ${JSON.stringify(e.event)}`).join("\n");
          return text(truncate(body || "(no events)"));
        }

        case "orch_list": {
          const r = await client.list({ includeClosed: a.includeClosed !== false });
          return text(
            truncate(
              r.sessions
                .map(
                  (s) =>
                    `${s.id.slice(0, 8)}  ${s.tool.padEnd(9)} ${s.closedAt ? "closed" : "live  "} ` +
                    `in=${s.totals.inputTokens} out=${s.totals.outputTokens} $${s.costUsd.toFixed(4)} ${s.cwd}` +
                    (s.label ? `  "${s.label}"` : ""),
                )
                .join("\n") || "(no sessions)",
            ),
          );
        }

        case "orch_status": {
          const r = await client.status({ sessionId: String(a.sessionId) });
          const caps = r.caps as { permissionFidelity?: string; subagents?: boolean } | undefined;
          return text(
            [
              `id:     ${r.session.id}`,
              `tool:   ${r.session.tool}`,
              `native: ${r.session.native}`,
              `model:  ${r.session.model}`,
              `cwd:    ${r.session.cwd}`,
              `state:  ${r.session.closedAt ? "closed" : "live"}`,
              `usage:  in=${r.session.totals.inputTokens} out=${r.session.totals.outputTokens}`,
              `cost:   $${r.session.costUsd.toFixed(4)}`,
              caps ? `perms:  ${caps.permissionFidelity}` : "perms:  unknown (process not live)",
              "",
              r.policy ?? "(no policy)",
            ].join("\n"),
          );
        }

        case "orch_interrupt":
          await client.interrupt({ sessionId: String(a.sessionId) });
          return text("interrupted");

        case "orch_close":
          await client.close({ sessionId: String(a.sessionId) });
          return text("closed");

        case "orch_roots": {
          const r = await client.roots({ cwd: projectDir, roots: rootList });
          return text(r.policy);
        }

        case "orch_diff": {
          const r = await client.diff({ sessionId: String(a.sessionId), statOnly: a.statOnly === true });
          if (r.note) return text(r.note);
          if (!r.files.length) return text("No changes.");
          const body = a.statOnly
            ? r.files.map((f) => `  ${f}`).join("\n")
            : (r.patch || "(no diff available)");
          return text(truncate(`${r.files.length} file(s) changed:\n${body}`));
        }

        case "orch_merge": {
          const r = await client.merge({
            sessionId: String(a.sessionId),
            mode: a.mode === "merge" ? "merge" : "squash",
          });
          return text(r.result);
        }

        case "orch_discard": {
          const r = await client.discard({ sessionId: String(a.sessionId), force: a.force === true });
          return text(r.removed ? "Discarded." : `Not discarded: ${r.reason}`);
        }

        case "orch_compare": {
          const models = Array.isArray(a.models) && a.models.length
            ? (a.models as string[])
            : [
                "opencode/space-bunny-free",
                "opencode/big-pickle",
                "opencode/muse-spark-1.3-contributor-free",
              ];
          const r = await client.call<{ results: Array<{ model: string; ok: boolean; text: string; sessionId: string }> }>(
            "/compare",
            { prompt: String(a.prompt), models, tool: a.tool ?? "opencode", cwd: a.cwd ?? projectDir, roots: rootList },
          );
          const body = r.results
            .map((x, i) => `--- ${i + 1}. ${x.model} ---\n${x.ok ? truncate(x.text, 2000) : `ERROR: ${x.text}`}\nsession ${x.sessionId}`)
            .join("\n\n");
          return text(truncate(body));
        }

        case "orch_models": {
          const r = await client.models(a.filter ? { filter: String(a.filter) } : {});
          const head =
            `${r.total} models available. Default for orch_open: ${r.default}\n` +
            `Pass model as "provider/model", e.g. "opencode/space-bunny-free".\n\n`;
          return text(truncate(head + r.models.join("\n")));
        }

        case "orch_cost": {
          const r = await client.cost();
          return text(
            truncate(
              (r.rows as Array<Record<string, any>>)
                .map(
                  (x) =>
                    `${String(x.tool).padEnd(9)} sessions=${x.sessions} turns=${x.turns} ` +
                    `in=${x.usage.inputTokens} out=${x.usage.outputTokens} $${Number(x.costUsd).toFixed(4)}`,
                )
                .join("\n") || "(no usage yet)",
            ),
          );
        }

        case "orch_grade": {
          const r = await client.grade({
            sessionId: String(a.sessionId),
            pct: Number(a.pct),
            note: a.note ? String(a.note) : "",
          });
          return text(`graded session ${r.sessionId}: ${r.pct}%`);
        }

        case "orch_progress": {
          const r = await client.progress({ sessionId: String(a.sessionId) });
          if (!r.job) return text(`session ${r.sessionId} has no stored job.`);
          const pct = (n: number) => `${Math.round(n * 100)}%`;
          const body = r.items
            .map((i) => {
              const ev = i.evidence.length ? ` — ${i.evidence.join("; ")}` : "";
              return `${i.id}) ${pct(i.score)} ${i.text.split("\n")[0]?.slice(0, 90)}${ev}`;
            })
            .join("\n");
          const grade = r.grade ? `  grade: ${pct(r.grade.pct)} (${r.grade.note || "no note"})` : "  grade: none";
          return text(
            truncate(
              `job ${r.job.path}\nauto: ${pct(r.autoPct)}\n${grade}\n\n${body || "(no items parsed)"}`,
            ),
          );
        }

        case "orch_program": {
          const action = String(a.action ?? "show");
          if (action === "add") {
            const r = await client.program({ action, id: String(a.id), name: a.name ? String(a.name) : String(a.id) });
            return text(`program ${r.id} added`);
          }
          if (action === "link") {
            const r = await client.program({
              action,
              id: String(a.id),
              job: String(a.job),
              sessionId: String(a.sessionId),
            });
            return text(`linked session ${r.sessionId} to ${r.id} (job ${r.job})`);
          }
          if (action === "weight") {
            const r = await client.program({
              action,
              id: String(a.id),
              job: String(a.job),
              weight: Number(a.weight),
            });
            return text(`${r.id} ${r.job} weight = ${r.weight}`);
          }
          const r = await client.program(a.id ? { action: "show", id: String(a.id) } : { action: "show" });
          const render = (p: Record<string, any>, pct?: number, tokensSpent?: number) => {
            const items = (p.items as Array<Record<string, any>>)
              .map((i) => `  ${i.job} w=${i.weight} sessions=[${(i.sessions as string[]).join(", ")}]`)
              .join("\n");
            const head = pct === undefined ? p.name : `${p.name}  done=${pct}  tokens=${tokensSpent}`;
            return `${p.id} ${head}\n${items || "  (no linked sessions)"}`;
          };
          if (r.program) {
            const p = r.program as Record<string, any>;
            return text(truncate(render(p, r.pct as number | undefined, r.tokensSpent as number | undefined)));
          }
          const programs = (r.programs as Array<Record<string, any>>) ?? [];
          return text(truncate(programs.map((p) => render(p)).join("\n\n") || "(no programs)"));
        }

        default:
          return text(`unknown tool: ${name}`);
      }
    } catch (err) {
      return text(`orchestrator error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await server.connect(new StdioServerTransport());
}