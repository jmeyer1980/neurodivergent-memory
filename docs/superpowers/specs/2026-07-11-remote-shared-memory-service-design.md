# Remote Shared Memory Service — Design & Migration Path

**Date:** 2026-07-11
**Status:** Approved as target architecture; only Step 1 below is implemented
**Target:** development branch — future work, not part of a release cut

## Problem

The user wants to run `neurodivergent-memory` as a long-lived service on a Linux machine and reach the same store from multiple devices — pull up a project on another computer and immediately have access to the same memories, no export/import step. The intended auth path is a PAT/API key first, OAuth later. This is single-user, multi-device, not multi-tenant, so no per-user data partitioning is needed beyond what `project_id`/`session_id`/`visibility`/`agent_id` already provide.

## What this session discovered (the constraint these decisions build on)

While building memory-editing UI for `scripts/nd-mem-mcp-app-bridge.html`, a normalization pass merging duplicate `project_id` spellings surfaced a live data-loss bug in `scripts/nd-mem-bridge-server.mjs`: its `/save` and `/update` handlers spawned a **new** `node build/index.js` process per request (`spawn(MCP_COMMAND, MCP_ARGS, ...)`). That process loaded `memories.json`, applied one change, wrote the file, and exited — while Claude Code's own live server session held a separate, increasingly stale in-memory copy of the same store. `saveToDiskAsync` ([src/index.ts:1454](../../../src/index.ts#L1454)) always serializes the **entire** in-memory snapshot and atomically replaces the file; it never reloads or merges another process's writes. Whichever instance flushed last silently discarded the other's changes.

This is not a new failure mode — it is already documented in [docs/runbooks/cross-process-coordination.md](../../runbooks/cross-process-coordination.md): *"Not for active-active concurrent writers ... For active-active workloads, use a single process with multiple agents connecting to it over MCP."* Today's incident is a concrete instance of exactly that documented constraint, reached via the bridge rather than a deliberate multi-process deployment.

Importantly, the user had already solved the *other* half of this problem: `writeMutex.runExclusive` ([src/index.ts:4802](../../../src/index.ts#L4802), backed by `AsyncMutex`) makes concurrent writes from multiple MCP clients **of one server process** fully safe — no lost updates. That guarantee simply doesn't extend across separate processes, because stdio MCP is inherently 1 client ↔ 1 process, and nothing reloads state from disk before writing.

## Target architecture

One long-lived `neurodivergent-memory` server process on the user's Linux machine, exposing a **network transport**. Every client — other machines, the HTML app, the bridge — connects to that one process instead of spawning its own. Because the write path already serializes safely for any number of concurrent MCP clients of a single process, this is a direct extension of a guarantee that already exists, not new concurrency logic.

- **Transport:** MCP's Streamable HTTP transport — the current standard remote-MCP transport, and the transport the MCP spec's OAuth 2.1 authorization flow is defined against. Not a bespoke choice.
- **Auth:** HTTP middleware in front of the transport, staged:
  1. API key / PAT via `Authorization: Bearer <token>`, config-driven (env var or config file on the Linux host).
  2. OAuth 2.1 later, per the MCP spec's authorization flow, once the PAT path is proven in daily use.
  Auth must stay a separable layer — it never leaks into store/tool logic, matching this project's existing separation between the transport entrypoint and store logic in `src/index.ts`.
- **Bridge/app:** `scripts/nd-mem-bridge-server.mjs` either becomes a thin proxy in front of the remote HTTP endpoint, or is retired once `scripts/nd-mem-mcp-app-bridge.html` speaks MCP-over-HTTP directly. Either way, the app's `http://localhost:3737` and the server's bind host/port/token must be config, not hardcoded — localhost → LAN → remote-over-internet should be a settings change, not a rewrite.

## Non-goals

- Multi-tenant isolation — this is single-user/multi-device.
- Building the HTTP transport or auth in this pass. This document records the agreed target and path; only Step 1 has shipped.

## Migration path

Each step ships independently and stays compatible with the next — none of them is a detour from the target.

### Step 1 — Bridge → persistent MCP child (SHIPPED 2026-07-11)

`scripts/nd-mem-bridge-server.mjs` now spawns **one** long-lived `build/index.js` child at bridge startup (`PersistentMcpClient`) instead of one per `/save`/`/update` request. All bridge-originated writes now serialize through that single process's `writeMutex`. The client auto-respawns on unexpected child exit (1s backoff) and `SIGINT`/`SIGTERM` on the bridge cleanly kills its child — verified via manual smoke test (single child spawned, survived two requests, no orphaned process after shutdown).

This is a strict subset of the target: "one persistent instance the bridge talks to" is step one of "one shared service everyone talks to."

**Residual gap this step does not close:** Claude Code's own live `neurodivergent-memory` session and the bridge's persistent child are still two separate processes. Running both against the same `memories.json` at once is still unsafe by the same last-writer-wins mechanism — just with a far smaller/rarer overwrite window (bridge restarts vs. per-request spawns). This is a known, accepted limitation of Step 1, closed by Step 2, not by hardening Step 1 further.

### Step 2 — Streamable HTTP transport on the server (SHIPPED 2026-07-13, localhost)

Add an HTTP transport alongside the existing stdio transport in `src/index.ts`. Bridge and HTML app connect over HTTP to `localhost` first — functionally a no-op in behavior, but the "one process" becomes reachable over a network socket instead of only via spawn+stdio pipe. This is also what finally closes Step 1's residual gap, once Claude Code's own session can be pointed at the same HTTP endpoint instead of spawning its own stdio child. See [`2026-07-13-single-writer-daemon-design.md`](2026-07-13-single-writer-daemon-design.md) for the shipped implementation shape (localhost HTTP daemon with stdio proxy; LAN bind and auth remain Step 3).

### Step 3 — Bind beyond localhost + API-key middleware

Bind the HTTP transport to the LAN interface or a reverse-proxied endpoint on the Linux host. Add bearer-token middleware in front of the transport, checked before any MCP method dispatch. This is the step that actually enables "pull up projects on other computers."

### Step 4 — OAuth 2.1

Replace/augment the static bearer token with the MCP spec's OAuth 2.1 flow once the PAT path is proven.

## Open questions for Step 2+

- Does Claude Code's MCP client config support connecting to a remote Streamable HTTP server directly, or does it need a local stdio-to-HTTP shim? Needs verification against current Claude Code MCP config docs before Step 2 starts.
- Where does the bearer token live client-side for the HTML app — env-injected at bridge-serve time, or entered in the UI and held in browser storage?
- Does `NEURODIVERGENT_COORDINATION_MODE=filesystem-lock` (see the cross-process-coordination runbook) become unnecessary once there's exactly one process again — structurally yes, but worth confirming no independent multi-process deployment (e.g. blue-green restarts) is still wanted, in which case that runbook's Profile B still applies regardless of this migration.

## Out of scope for this document

- Implementing Step 2 (HTTP transport), Step 3 (network bind + API key), or Step 4 (OAuth). Each becomes its own dated plan under `docs/superpowers/plans/` when the user is ready to build it, per this project's spec → plan convention.
- Resolving Step 1's residual gap independently — it is subsumed by Step 2, not fixed in isolation.
