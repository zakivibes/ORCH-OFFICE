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
    .split(":")
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
        model: {
          type: "string",
          description:
            "Optional. For opencode use provider/model, e.g. openrouter/anthropic/claude-haiku-latest.",
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
] as const;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function truncate(s: string): string {
  const t = s.trim();
  if (!t) return "(no text)";
  if (t.length <= MAX_INLINE_CHARS) return t;
  return `${t.slice(0, MAX_INLINE_CHARS)}\n... [truncated ${t.length - MAX_INLINE_CHARS} chars — see the log]`;
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
    try {
      switch (name) {
        case "orch_open": {
          const r = await client.open({
            tool: String(a.tool),
            cwd: a.cwd ? String(a.cwd) : projectDir,
            roots: rootList,
            prompt: String(a.prompt ?? ""),
            label: a.label,
            model: a.model,
            narrow: { deny: a.deny, disableTools: a.disableTools },
          });
          return text(
            `session ${r.session.id}  tool=${r.session.tool}  native=${r.session.native}\n` +
              `${truncate(renderEvents(r.events ?? []))}\n` +
              `log: ${r.log}\n` +
              `This session stays live. Continue with orch_send using sessionId ${r.session.id}.`,
          );
        }

        case "orch_send": {
          const r = await client.send({
            sessionId: String(a.sessionId),
            prompt: String(a.prompt ?? ""),
            waitMs: Number(a.waitMs ?? 600_000),
          });
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

        default:
          return text(`unknown tool: ${name}`);
      }
    } catch (err) {
      return text(`orchestrator error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await server.connect(new StdioServerTransport());
}