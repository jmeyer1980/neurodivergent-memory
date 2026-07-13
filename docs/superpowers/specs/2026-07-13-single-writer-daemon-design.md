# Single-Writer Memory Daemon — Design

**Date:** 2026-07-13
**Status:** Shipped locally 2026-07-13 (development branch, unreleased — version stays 0.3.9; 0.4.0 is reserved for the orchestration milestone) — see docs/superpowers/plans/2026-07-13-single-writer-daemon.md
**Target:** development branch
**Implements:** Step 2 of [2026-07-11-remote-shared-memory-service-design.md](2026-07-11-remote-shared-memory-service-design.md), plus the stdio-proxy shim, in one pass ("B + C" — mode-aware entrypoint + bridge retires its MCP child)

## Problem

On 2026-07-13, memories created through the ND-Mem web app were silently overwritten. Investigation found **seven concurrent server processes** sharing `~/.neurodivergent-memory/memories.json`: the bridge's persistent child plus stale `neurodivergent-memory` instances spawned by Claude Code sessions (`node build/index.js` from `~/.claude.json`), Claude Desktop (`npx neurodivergent-memory`), and VS Code (`npx` again). Each instance:

1. loads the snapshot once at startup and never re-reads it,
2. keeps an independent in-memory copy **and an independent `nextMemoryId` counter**, and
3. on any mutation flushes its **entire** in-memory snapshot over the file (`saveToDiskAsync`, [src/index.ts:1454](../../../src/index.ts#L1454)).

Concrete losses: two user-created memories were destroyed by ID collision (the bridge child and an agent session both assigned `memory_1301`/`memory_1302`; `insertMemory`, [src/index.ts:1630](../../../src/index.ts#L1630), replaces unconditionally), and a manual Notepad++ project-id normalization was reverted by a running instance's flush (external file edits are invisible to running servers). The WAL could not protect the data because it is replayed **and truncated** only at startup, so any new session start destroys the durable record while stale writers keep running.

The Step 1 fix (bridge spawns one persistent child) worked as designed but only serializes bridge-originated writes. This design closes the residual gap for every client.

## Decisions already made (with the user)

- **Scope:** implement the HTTP daemon (spec Step 2) and the stdio shim in one pass — no interim `/rpc` stopgap to retire later.
- **Lifecycle:** on-demand auto-start. Any proxy or the bridge that finds the daemon unreachable spawns it detached. The HTTP port bind is the singleton lock; spawn-race losers just connect.
- **Shim placement:** mode-aware entrypoint (`build/index.js` itself), not a separate script, so *any* stdio spawn — including forgotten or third-party configs — is structurally incapable of becoming a second writer.
- **Bridge:** `PersistentMcpClient` is removed; the bridge becomes an HTTP client of the daemon.
- **Auth:** none in this pass. Bind `127.0.0.1` only. Bearer token is Step 3 of the parent spec, unchanged.

## Architecture

```
Claude Code ──stdio──▶ build/index.js (proxy mode) ──┐
Claude Desktop ─stdio─▶ build/index.js (proxy mode) ──┤
VS Code ───────stdio──▶ build/index.js (proxy mode) ──┼──HTTP──▶ build/index.js --daemon ──▶ memories.json
HTML app ──HTTP──▶ nd-mem-bridge-server.mjs ──────────┘          (the ONLY writer)
                   (static + /memories + SSE + /save,/update forwards)
```

### Run modes of `build/index.js`

`main()` ([src/index.ts:7046](../../../src/index.ts#L7046)) dispatches on argv/env; the existing `init-agent-kit` subcommand pattern is extended.

| Mode | Trigger | Opens store? | Behavior |
|---|---|---|---|
| **daemon** | `--daemon` flag or `NEURODIVERGENT_MEMORY_MODE=daemon` | **Yes — sole writer** | Serves MCP over Streamable HTTP on `127.0.0.1:3838` (`NEURODIVERGENT_MEMORY_DAEMON_PORT` overrides). `EADDRINUSE` → log "daemon already running" and exit 0. |
| **proxy** (default) | stdio launch with no flag | No | Ensure daemon is up, then forward stdio JSON-RPC ↔ daemon HTTP. This is what every existing MCP config gets automatically. |
| **standalone** | `NEURODIVERGENT_MEMORY_MODE=standalone` | Yes | Today's behavior (stdio + own store). For the test suite, CI, benchmarks, and `npm run inspector`. Explicit opt-in only. |

New logic lives in new modules — `src/core/daemon.ts` (HTTP transport wiring) and `src/core/stdio-proxy.ts` (ensure-daemon + forwarding) — keeping the 7,000-line `src/index.ts` limited to mode dispatch.

### Daemon details

- **Transport:** SDK `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk` 1.29.0, already a dependency) in **stateless mode** (no MCP session IDs): each POST is an independent request against the single server/store instance. The existing `writeMutex.runExclusive` ([src/index.ts:4802](../../../src/index.ts#L4802)) already serializes concurrent mutations from N clients of one process — this design extends that proven guarantee rather than adding new concurrency logic.
- **Endpoint:** `POST /mcp` for JSON-RPC; `GET /health` returns `{ok, pid, version, memoryPath, memoryCount}` for ensure-daemon checks and diagnostics.
- **Identity/attribution:** unchanged. `session_id`/`agent_id`/`project_id` remain tool arguments, so the agent clock-in/clock-out spec is unaffected by stateless transport.
- **Spawn:** proxies/bridge spawn `process.execPath <own entry> --daemon` detached (`windowsHide: true`, `stdio: 'ignore'`, `.unref()`), then poll `/health` for up to ~5s.
- **Logging:** daemon writes pino logs to a file under `~/.neurodivergent-memory/` (stdio is unavailable when detached); startup line states mode, port, pid, memory count.

### Proxy details

- On stdin JSON-RPC: `initialize`/`notifications/initialized` are answered locally (capabilities fetched from the daemon once at startup); every other request is forwarded to `POST /mcp` and the response relayed to stdout. Notifications from daemon to client are not required (the server pushes none today); if that changes, proxy mode revisits stateless-vs-session transport.
- **Fail loud, never fork:** if the daemon is unreachable *and* cannot be spawned, the proxy returns a clear JSON-RPC error for each request (and logs the reason). Under no circumstances does proxy mode fall back to opening the store locally — a silent fallback would re-create the multi-writer bug.
- If the daemon dies mid-session, the next request re-runs ensure-daemon (respawn + `/health` poll) and retries once; the respawned daemon recovers via snapshot + WAL replay, which is finally race-free with a single writer.

### Bridge refactor

`scripts/nd-mem-bridge-server.mjs`:

- **Removed:** `PersistentMcpClient` and the spawned MCP child.
- **Kept:** static HTML serving, `GET /memories` snapshot reads, SSE file-change polling/broadcast, `GET /health`.
- **Changed:** `/save` and `/update` forward to the daemon's `POST /mcp` (same ensure-daemon helper, shared or duplicated as a small module). The HTML app requires no changes.

### Config migration

| Surface | Today | After |
|---|---|---|
| Claude Code `~/.claude.json` | `node <repo>\build\index.js` | **unchanged** (becomes proxy automatically) |
| Claude Desktop `claude_desktop_config.json` | `npx neurodivergent-memory` (stale published 0.3.9) | `node <repo>\build\index.js` |
| VS Code `mcp.json` | `npx neurodivergent-memory` | `node <repo>\build\index.js` |
| `npm test`, `smoke:*`, `inspector`, benchmarks | spawn stdio server directly | set `NEURODIVERGENT_MEMORY_MODE=standalone` |

Repointing Desktop/VS Code off `npx` also ends the two-code-versions problem (npm-cache 0.3.9 vs local build) observed during the incident.

## Error handling summary

- Proxy cannot reach or spawn daemon → JSON-RPC error with remediation text; no local store fallback.
- Two proxies race to spawn → both spawn attempts are safe; the port bind picks one winner, the loser exits 0, both proxies connect.
- Daemon crash → WAL replay on respawn; single writer makes replay/truncation safe.
- External hand-edits of memories.json while the daemon runs remain unsupported (documented in the runbook); the difference is that now exactly one process needs stopping first, and `/health` exposes it.

## Testing

- **Unit:** mode dispatch (flag/env combinations); ensure-daemon (already-running, spawn-then-healthy, spawn-fails); proxy forwarding incl. error mapping.
- **Integration (regression for the 2026-07-13 incident):** start daemon; connect two clients — one through proxy mode, one through the bridge's `/save` path; interleave `store_memory`/`update_memory` from both; assert all writes survive in the final snapshot, IDs never collide, and `nextMemoryId` is consistent.
- **Spawn race:** launch two proxy processes simultaneously with no daemon running; assert exactly one daemon process exists afterward and both proxies serve tool calls.
- **Existing suite:** runs in standalone mode, no behavioral change expected.

## Rollout

1. Build; stop all running `build/index.js` / `npx neurodivergent-memory` processes (one-time cleanup, same procedure as the incident recovery).
2. Update Desktop/VS Code configs; restart Claude sessions.
3. Verify: exactly one `--daemon` process; `GET /health` OK; web app loads; a store from a Claude session and an app edit both persist.
4. Update `docs/runbooks/cross-process-coordination.md` (the multi-writer scenario is now structurally prevented for stdio spawns; `NEURODIVERGENT_COORDINATION_MODE=filesystem-lock` remains only for deliberate multi-daemon deployments) and mark Step 2 shipped in the parent spec.
5. CHANGELOG + version bump. Publishing to npm is out of scope for this pass (local configs no longer use npx).

## Non-goals

- Binding beyond `127.0.0.1`, bearer-token auth, OAuth (Steps 3–4 of the parent spec).
- Multi-tenant isolation.
- Reload-and-merge-before-flush in the store (unnecessary once a single writer is structural).
- npm publish of the new version.

## Open questions

None blocking. If a future feature needs server-initiated notifications to MCP clients, proxy/daemon transport moves from stateless to session mode; the module boundaries above keep that a contained change.
