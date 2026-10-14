#!/usr/bin/env node
// node:sqlite is still flagged experimental; keep its warning out of our output.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { startDaemon } from "../core/daemon.js";
import { DaemonClient } from "../core/client.js";
import type { Event } from "../core/types.js";

const help = `orch — persistent multi-agent orchestrator for claude, agy and opencode

  orch up [--cwd DIR] [--terminal] [--force]
                                  start all workers defined in team.json
  orch down                       terminate all live sessions
  orch daemon [--foreground]     run the session daemon
  orch open <tool> <prompt>      start a session and send the first turn
  orch diff <sessionId> [--stat]  show what the agent changed (needs --worktree)
  orch compare <prompt> [--models a,b,c]
                                  same prompt, several models, side by side
  orch merge <sessionId> [--ff]   merge the agent's branch back into the base
  orch discard <sessionId>        delete the worktree and its branch
  orch sweep [dir]                remove worktrees orphaned by dead agents
  orch send <sessionId> <prompt> continue a live session (keeps its context)
  orch ls [--live]               list sessions
  orch status <sessionId>        session detail + effective permissions
  orch logs <sessionId>          print the event log
  orch interrupt <sessionId>     abort the current turn, keep the session
  orch close <sessionId>         terminate a session
  orch models [filter]           list models opencode can reach
  orch roots                     show resolved permissions and directory roots
  orch cost                      token and cost totals per tool
  orch doctor                    check the three CLIs and print the policy

Options:
  --cwd DIR        working directory (default: current)
  --root DIR       extra readable root (repeatable)
  --label NAME     label the session
  --model M        model to pass through
  --wait MS        stop waiting after MS and leave the turn running
  --worktree       isolate the agent in its own git worktree
`;

function flag(name: string): boolean {
  return process.argv.includes(name);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1]!;
}
function argAll(name: string): string[] {
  const out: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
  }
  return out;
}
function positionals(): string[] {
  // skip argv[0]=node and argv[1]=script; the command name is handled separately
  const argv = process.argv.slice(3);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]!;
    if (cur.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    out.push(cur);
  }
  return out;
}

const client = new DaemonClient();

async function call(route: string, body: Record<string, unknown>): Promise<any> {
  return client.call(route, body);
}

function render(events: Event[]): void {
  for (const ev of events) {
    switch (ev.t) {
      case "text.delta":
        process.stdout.write(ev.text);
        break;
      case "tool.call":
        process.stderr.write(`\n· ${ev.name}\n`);
        break;
      case "turn.completed":
        process.stderr.write(
          `\n[done ${ev.durationMs}ms in=${ev.usage.inputTokens} out=${ev.usage.outputTokens}` +
            `${ev.costUsd ? ` $${ev.costUsd.toFixed(4)}` : ""}]\n`,
        );
        break;
      case "error":
        process.stderr.write(`\n[error ${ev.kind}] ${ev.message}\n`);
        if (ev.retryAfterMs) {
          process.stderr.write(`[retry after ${Math.round(ev.retryAfterMs / 1000)}s]\n`);
        }
        break;
    }
  }
  process.stdout.write("\n");
}

async function main() {
  const cmd = process.argv[2];
  const pos = positionals();

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(help);
      return;

    case "daemon": {
      startDaemon();
      return; // stays alive
    }

    case "doctor": {
      const { execFileSync } = await import("node:child_process");
      const { resolveBinary } = await import("../core/bin.js");
      for (const bin of ["claude", "agy", "opencode"]) {
        try {
          const resolved = resolveBinary(bin);
          const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
          console.log(
            `✓ ${bin.padEnd(9)} ${execFileSync(resolved, ["--version"], {
              encoding: "utf8",
              shell: isBatch,
            }).trim()}`,
          );
        } catch {
          console.log(`✗ ${bin.padEnd(9)} not found on PATH`);
        }
      }
      console.log("\n" + (await call("/roots", { cwd: process.cwd(), roots: [process.cwd()] })).policy);
      return;
    }

    case "models": {
      const r = await call("/models", { filter: pos[0] ?? "" });
      if (!r.models.length) return console.log("(no models matched)");
      console.log(`${r.total} available; default for orch_open: ${r.default}\n`);
      for (const m of r.models) console.log(`  ${m}`);
      return;
    }

    case "roots": {
      const cwd = arg("--cwd") ?? process.cwd();
      console.log((await call("/roots", { cwd, roots: [cwd, ...argAll("--root")] })).policy);
      return;
    }

    case "cost": {
      const { rows } = await call("/cost", {});
      if (!rows.length) return console.log("(no usage yet)");
      for (const r of rows as any[]) {
        console.log(
          `${r.tool.padEnd(9)} sessions=${String(r.sessions).padEnd(3)} turns=${String(r.turns).padEnd(4)} ` +
            `in=${r.usage.inputTokens} out=${r.usage.outputTokens} cacheRead=${r.usage.cacheReadTokens} $${r.costUsd.toFixed(4)}`,
        );
      }
      return;
    }

    case "ls": {
      const { sessions } = await call("/list", { includeClosed: !flag("--live") });
      if (!sessions.length) return console.log("(no sessions)");
      for (const s of sessions as any[]) {
        console.log(
          `${s.id.slice(0, 8)}  ${s.tool.padEnd(9)} ${s.closedAt ? "closed" : "live  "} ` +
            `in=${s.totals.inputTokens} out=${s.totals.outputTokens} $${s.costUsd.toFixed(4)} ${s.cwd}` +
            (s.label ? `  "${s.label}"` : ""),
        );
      }
      return;
    }

    case "open": {
      const tool = pos[0];
      const prompt = pos.slice(1).join(" ");
      if (!tool || !prompt) {
        console.error("usage: orch open <claude|agy|opencode> <prompt>");
        process.exit(1);
      }
      const cwd = arg("--cwd") ?? process.cwd();
      const r = await call("/open", {
        tool,
        cwd,
        roots: [cwd, ...argAll("--root")],
        prompt,
        label: arg("--label"),
        model: arg("--model"),
        worktree: flag("--worktree"),
      });
      console.error(`[session ${r.session.id}] native=${r.session.native}`);
      if (r.session.worktreePath) {
        console.error(`worktree: ${r.session.worktreePath} (branch ${r.session.worktreeBranch})`);
      }
      render(r.events ?? []);
      console.error(`log: ${r.log}`);
      console.error(`continue with: orch send ${r.session.id} "<follow-up>"`);
      return;
    }

    case "send": {
      const [sessionId, ...rest] = pos;
      const prompt = rest.join(" ");
      if (!sessionId || !prompt) {
        console.error("usage: orch send <sessionId> <prompt>");
        process.exit(1);
      }
      const r = await call("/send", { sessionId, prompt, waitMs: Number(arg("--wait") ?? 0) });
      render(r.events ?? []);
      console.error(`log: ${r.log}`);
      return;
    }

    case "status": {
      const sessionId = pos[0];
      const r = await call("/status", { sessionId });
      console.log(
        [
          `id:      ${r.session.id}`,
          `tool:    ${r.session.tool}`,
          `native:  ${r.session.native}`,
          `model:   ${r.session.model}`,
          `cwd:     ${r.session.cwd}`,
          `state:   ${r.session.closedAt ? "closed" : "live"}`,
          `usage:   in=${r.session.totals.inputTokens} out=${r.session.totals.outputTokens} cacheRead=${r.session.totals.cacheReadTokens}`,
          `cost:    $${r.session.costUsd.toFixed(4)}`,
          r.caps ? `perms:   ${r.caps.permissionFidelity}` : "perms:   unknown (process not live)",
          "",
          r.policy ?? "(no policy)",
        ].join("\n"),
      );
      return;
    }

    case "logs": {
      const sessionId = pos[0];
      const { events } = await call("/stream", { sessionId, sinceSeq: Number(arg("--since") ?? 0) });
      for (const e of events as any[]) console.log(`${e.seq} ${JSON.stringify(e.event)}`);
      if (!(events as any[]).length) console.log("(no events)");
      return;
    }

    case "compare": {
      const prompt = pos.join(" ");
      if (!prompt) {
        console.error("usage: orch compare <prompt> [--models a,b,c] [--tool opencode]");
        process.exit(1);
      }
      const models = (arg("--models") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
      const r = await call("/compare", {
        prompt,
        models,
        tool: arg("--tool") ?? "opencode",
        cwd: arg("--cwd") ?? process.cwd(),
        roots: [arg("--cwd") ?? process.cwd()],
      });
      for (const [i, x] of r.results.entries()) {
        console.log(`--- ${i + 1}. ${x.model} ${x.ok ? "" : "(failed)"}`);
        console.log(x.text || "(empty)");
        console.log(`session ${x.sessionId}
`);
      }
      return;
    }

    case "diff": {
      const r = await call("/diff", { sessionId: pos[0], statOnly: flag("--stat") });
      if (r.note) {
        console.log(r.note);
        return;
      }
      if (!r.files?.length) return console.log("(no changes)");
      if (flag("--stat")) {
        for (const f of r.files) console.log(`  ${f}`);
        console.log(`${r.files.length} file(s) changed`);
        return;
      }
      console.log(r.patch || "(no diff available; the agent may not have committed)");
      return;
    }

    case "merge": {
      const r = await call("/merge", { sessionId: pos[0], mode: flag("--ff") ? "merge" : "squash" });
      console.log(r.result);
      return;
    }

    case "discard": {
      const r = await call("/discard", { sessionId: pos[0], force: flag("--force") });
      console.log(r.removed ? "discarded" : `not discarded: ${r.reason}`);
      return;
    }

    case "sweep": {
      const r = await call("/sweep", { cwd: pos[0] ?? process.cwd() });
      if (r.note) return console.log(r.note);
      console.log(`removed ${r.removed.length}, kept ${r.skipped.length} (still held by live agents)`);
      for (const p2 of r.removed) console.log(`  - ${p2}`);
      return;
    }

    case "interrupt":
      await call("/interrupt", { sessionId: pos[0] });
      console.log("interrupted");
      return;

    case "close":
      await call("/close", { sessionId: pos[0] });
      console.log("closed");
      return;

    case "down": {
      const { sessions } = await call("/list", { includeClosed: false });
      const live = (sessions as any[]).filter((s) => !s.closedAt);
      if (!live.length) {
        console.log("No live sessions.");
        return;
      }
      console.log(`Shutting down ${live.length} live session(s)...`);
      for (const s of live) {
        await call("/close", { sessionId: s.id });
        console.log(`  ✗ ${(s.label || s.id.slice(0, 8)).padEnd(18)} closed`);
      }
      console.log("All sessions terminated.");
      return;
    }

    case "up": {
      const teamPath = join(homedir(), ".orchestrator", "team.json");
      if (!existsSync(teamPath)) {
        console.error(`team config not found at ${teamPath}`);
        process.exit(1);
      }
      let teamConfig: any;
      try {
        teamConfig = JSON.parse(readFileSync(teamPath, "utf8"));
      } catch (e) {
        console.error(`failed to parse ${teamPath}: ${e}`);
        process.exit(1);
      }

      const cwd = arg("--cwd") ?? teamConfig.cwd ?? process.cwd();
      const { sessions } = await call("/list", { includeClosed: false });
      const live = (sessions as any[]).filter((s) => !s.closedAt);

      if (live.length > 0) {
        if (!flag("--force")) {
          console.error(`There are already ${live.length} live session(s). Use --force to close them and relaunch.`);
          process.exit(1);
        }
        console.log(`Closing ${live.length} existing live session(s)...`);
        for (const s of live) {
          await call("/close", { sessionId: s.id });
        }
      }

      const workers = teamConfig.workers || [];
      console.log(`\n🏢 Launching orchestra (${workers.length} workers, cwd: ${cwd})...\n`);

      for (const w of workers) {
        process.stdout.write(`  ⏳ Starting ${w.label || w.tool}... `);
        try {
          const r = await call("/open", {
            tool: w.tool,
            cwd,
            roots: [cwd],
            label: w.label,
            model: w.model || undefined,
            prompt: w.prompt || "Get ready and wait for a task.",
          });
          console.log(`✓ [${r.session.id.slice(0, 8)}] ${(w.model || w.tool)}`);
        } catch (err: any) {
          console.log(`✗ failed: ${err.message || err}`);
        }
      }

      console.log(`\n🟢 Orchestra is ON SHIFT! Office: http://localhost:4747\n`);

      const openTerm = flag("--terminal") || teamConfig.coordinator?.autoOpenTerminal;
      if (openTerm && process.platform === "win32") {
        const coordModel = teamConfig.coordinator?.model;
        const ocConfigPath =
          ["opencode.json", "opencode.jsonc"]
            .map((f) => join(homedir(), ".config", "opencode", f))
            .find((f) => existsSync(f)) ?? join(homedir(), ".config", "opencode", "opencode.json");
        if (coordModel && existsSync(ocConfigPath)) {
          try {
            const raw = readFileSync(ocConfigPath, "utf8");
            const updated = raw.replace(/"model":\s*"[^"]*"/, `"model": "${coordModel}"`);
            writeFileSync(ocConfigPath, updated, "utf8");
          } catch {}
        }
        console.log(`🚀 Launching Coordinator terminal in ${cwd}...`);
        const batPath = join(homedir(), ".orchestrator", "run-coordinator.bat");
        const content = [
          "@echo off",
          `cd /d "${cwd}"`,
          "title ORCH Coordinator - OpenCode",
          "echo ====================================================",
          "echo        ORCH OFFICE - Lead Coordinator CLI",
          "echo ====================================================",
          "echo.",
          "opencode",
          "cmd /k",
        ].join("\r\n");
        writeFileSync(batPath, content, "utf8");
        const term = spawn("cmd.exe", ["/c", "start", '""', batPath], {
          detached: true,
          stdio: "ignore",
        });
        term.unref();
      }
      return;
    }

    default:
      console.error(`unknown command: ${cmd}\n\n${help}`);
      process.exit(1);
  }
}

main().catch((e) => {
  if (process.env.ORCH_DEBUG) console.error(e instanceof Error ? e.stack : String(e));
  else console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});