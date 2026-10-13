# orch — persistent multi-agent orchestrator

Drives **claude**, **agy** and **opencode** as long-lived sessions with one
normalized interface, and exposes them to Claude Code over MCP.

The defining property is **persistence**: a session is a live process you can
hold a multi-turn conversation with, not a one-shot task that exits. Turn 2
sees turn 1's context.

## Install

```bash
npm run build
ln -sf ~/orchestrator/dist/cli/main.js ~/.local/bin/orch
claude mcp add --scope user orchestrator -- node ~/orchestrator/dist/mcp/run.js
```

## Parallel agents: worktree isolation

Two agents editing the same checkout overwrite each other. Give each session
its own git worktree:

```bash
orch open agy "refactor auth" --worktree --label auth &
orch open agy "add pagination" --worktree --label page &
orch diff <id> --stat        # what did it change?
orch diff <id>               # full patch, for review
orch merge <id>              # squash into the base branch
orch discard <id>            # throw the work away
orch sweep                   # reclaim trees orphaned by dead agents
```

`--worktree` creates `.orch/<label>` on branch `orch/<label>` and runs the
agent inside it. `orch diff` compares against the base **working tree**, not
`HEAD`, because agents usually edit without committing — diffing `base...HEAD`
reports "no changes" for an agent that did exactly what you asked.

`orch merge` commits the agent's uncommitted work on the branch first, then
squashes, because `git merge --squash` only sees commits.

Safety properties:
- A discarded run costs one `git worktree remove`; the main branch is untouched.
- A lock file (`.orch-lock`) records the owning pid. `discard` refuses while a
  live agent holds the tree; `sweep` removes trees whose owner is gone and runs
  automatically at daemon start, so a crash cannot leak worktrees forever.
- `.orch/` and `.orch-lock` are written to `.git/info/exclude`, so bookkeeping
  never lands in an agent's commit.

A worktree isolates **files**, not ports, databases or background processes.
Two agents both binding :3000 will still collide.

## Cross-model comparison

```bash
orch compare "what makes a good commit message?" --models opencode/space-bunny-free,opencode/big-pickle
```

Or `orch_compare` over MCP. Asking one model twice converges on its own bias,
so a second opinion has to come from a different model.

## Models

`orch_models` (MCP) and `orch models [filter]` list what opencode can actually
reach, so the driving agent can pick one before dispatching.

```bash
orch models "opencode/"     # the Zen gateway
orch models muse
```

`orch_open` defaults opencode to `opencode/space-bunny-free`. Override per
call with `model`, or globally with `ORCH_OPENCODE_MODEL`. This deliberately
does **not** follow opencode's own configured default, which may point at a
provider with no working credentials.

Verified working on the Zen gateway: `space-bunny-free`,
`muse-spark-1.3-contributor-free`, `big-pickle`. `exo-free` is deprecated
upstream and correctly surfaces that error.

## Why this exists

`aid` (github.com/agent-tools-org/ai-dispatch) already orchestrates all three
CLIs, but its agent contract is explicitly one-shot. From its own error output:

> Task t-9c00f43f uses 'agy' in one-shot print mode and cannot consume
> interactive input... retry starts a fresh session for agents without resume

So it cannot provide persistent sessions. It remains a good reference for
worktree isolation and DAG scheduling.

## CLI

```bash
orch open agy "Remember the code word X. Reply ACK"   # start session + first turn
orch send <id> "What was the code word?"              # continue, context preserved
orch ls  [--live]      orch status <id>   orch logs <id>
orch interrupt <id>    orch close <id>    orch roots   orch cost   orch doctor
```

Short session ids work everywhere (`orch send 40d4f87a "..."`).

Sessions live in a background daemon, so `open` and `send` are separate
processes against the same live agent. The daemon is started on demand and
reaped automatically when its build changes.

## MCP (Claude Code drives this)

Registered at user scope, so it loads in every project. Tools:

`orch_open` `orch_send` `orch_stream` `orch_list` `orch_status`
`orch_interrupt` `orch_close` `orch_roots` `orch_cost`

## Permissions

**Claude Code's settings are the ceiling.** Workers cannot exceed what Claude
Code itself is allowed to do.

Resolution order (highest first): managed → `--settings` →
`.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`.
Lists **merge** across levels; `deny` > `ask` > `allow`.

- Worker paths are confined to the directories Claude Code granted
  (`CLAUDE_PROJECT_DIR`, plus anything in `ORCH_EXTRA_ROOTS`).
- Tool-call arguments may only **narrow** permissions. `deny` and
  `disableTools` subtract; nothing the caller passes can widen a grant.
- With no matching rule: read-only tools default to `allow`, mutating tools
  (`Bash`, `Edit`, `Write`, `NotebookEdit`, `MultiEdit`) default to `ask`.

Per-backend fidelity:

| Backend | Fidelity | Mechanism |
|---|---|---|
| claude | `native` | `--allowedTools` / `--disallowedTools` / `--permission-mode`; rules are 1:1 |
| opencode | `native` | generated `permission` block via `OPENCODE_CONFIG_CONTENT` |
| agy | `mediated` | no per-rule list exists; uses `--mode` derived from the resolved `defaultMode` |

agy's mode matters more than it looks. Treating a Claude Code session whose
`defaultMode` is `auto` as "edits not permitted" forces `--mode plan`; agy then
tries to run a command, the command is refused, and it returns an **empty
reply with no error**. The mode is therefore derived from `defaultMode`, with
an explicit `Edit` allow/deny rule taking precedence.

agy is genuinely weaker here — `orch status` reports `mediated` rather than
pretending parity.

## Architecture

```
Claude Code ──MCP stdio──┐
                         ├──► daemon ──► core ──► adapters ──► CLI processes
terminal ──orch──────────┘    (owns     (store,   claude  (NDJSON)
                                sessions  queue)   agy     (NDJSON)
                                                   opencode (HTTP/SSE)
```

- `src/core/` — daemon, client, registry, SQLite store (`~/.orchestrator/orch.db`, WAL), async queue
- `src/adapters/` — one per CLI, all emitting the same event union
- `src/permissions/` — settings resolution, policy, per-backend translation
- `src/mcp/`, `src/cli/` — the two surfaces

Normalized events: `session.started`, `text.delta`, `tool.call`, `tool.result`,
`permission.request`, `turn.completed`, `error`, `turn.started`.

Usage is normalized to tokens. `costUsd` is authoritative only for claude;
agy reports tokens only, so its cost reads `$0.0000`.

## Tests

```bash
npm test
```

35 tests: permission precedence and narrowing, rule-glob anchoring, root
confinement, the async-queue and coalescer regressions, NDJSON parsing, store
round-trips, fixture replays of real captured claude/agy streams, and worktree
behaviour (isolation, uncommitted diffs, squash-merge, lock refusal, stale
sweep, branch-name sanitising against `git check-ref-format`).

## Known limits

- Rate limits surface as `error` with `kind: "rate_limit"` and
  `retryAfterMs`; they are not retried automatically.
- Tool results are never inlined into MCP responses (Claude Code caps output
  around 25k tokens). Full transcripts go to `~/.orchestrator/logs/<id>.ndjson`.
- opencode token counts are read from the latest `message.updated`, so a turn's
  reported input tokens can be lower than the true context size. Cost is only
  authoritative for claude.
- Free Zen models can be rate-limited upstream; that surfaces as
  `error { kind: "api" }` with the provider's message.
- The three CLIs ship fast. Event schemas are pinned by fixture tests, which
  fail loudly on drift rather than failing silently at runtime.