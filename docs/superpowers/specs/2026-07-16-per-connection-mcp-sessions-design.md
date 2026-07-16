# Per-Connection MCP Sessions for Agent Identity Binding

**Date:** 2026-07-16
**Status:** Approved for planning
**Target:** development branch, build-and-serve-locally (not part of a 0.4.0 release cut)
**Supersedes:** [`2026-07-08-agent-clock-in-clock-out-design.md`](2026-07-08-agent-clock-in-clock-out-design.md) — that design's core safety argument ("each MCP client spawns its own server process, no shared daemon") was invalidated five days after it was written, when the single-writer daemon shipped ([`2026-07-13-single-writer-daemon-design.md`](2026-07-13-single-writer-daemon-design.md)). This document replaces it with a design compatible with the daemon architecture as it actually exists today.

## Problem

`agent_id` attribution is still honor-system: every write call must pass it explicitly, or the memory lands `unassigned`. A 2026-07-08 design ("clock in once, inherit agent_id for the rest of the session") was spec'd and planned but never implemented (every checkbox in its implementation plan is still unchecked). Investigating why (memory_1144, an onboarding-feedback report from 2026-07-09) surfaced that the design as written is no longer safe to build: it assumed a per-process server, one per MCP client, with no shared state risk. That assumption was true on 2026-07-08. It stopped being true on 2026-07-13, when the single-writer daemon shipped: one shared daemon process now serves every client (Claude Code, VS Code, the web bridge, any other MCP client) through a fresh, stateless `Server` instance per request, with MCP session IDs deliberately disabled (`sessionIdGenerator: undefined`) as part of that redesign.

Implementing the 2026-07-08 plan on top of today's architecture would put "the active agent" on the daemon singleton as one global value — clobbered by whichever client called in most recently, across every concurrently-connected client. That is the same class of bug the daemon was built to eliminate for `memories.json` writes, just relocated to `agent_id`.

## Target architecture

Give the daemon a real, per-connection MCP session instead of treating every request as independent. Bind agent identity to that session automatically, using data the MCP protocol already carries.

### Daemon session registry (`src/core/daemon.ts`)

Replace the current "fresh `Server` + transport per request, both discarded after" pattern with:

```
Map<sessionId, { transport: StreamableHTTPServerTransport; server: Server; agentSession?: ActiveAgentSession; lastActivityAt: number }>
```

- A request carrying an `Mcp-Session-Id` header is routed to that session's existing transport (`transport.handleRequest(req, res)`), reusing the same `Server` connection.
- A request with no session header (an `initialize`) creates a new `StreamableHTTPServerTransport` with a real `sessionIdGenerator` (e.g. `() => randomUUID()`) instead of `undefined`, connects a fresh `Server` to it, and registers the pair in the map via the transport's `onsessioninitialized(sessionId)` callback.
- Transports are no longer closed on every response (`res.on("close", ...)` today closes both transport and server per request) — closing now happens only when the session itself ends (see "Session end" below), via `onsessionclosed` or the idle-timeout sweep.
- This does **not** touch the single-writer guarantee. That guarantee comes from the `NeurodivergentMemory` singleton's `writeMutex`, not from the discard-per-request pattern — the per-request pattern existed only so concurrent clients' JSON-RPC ids could never cross wires on a shared transport. Long-lived per-session transports give each client the same id-space isolation, just persisted across calls instead of thrown away after one.

### Identity binding

`onsessioninitialized` reads `clientInfo.name` from the `initialize` request's params and stores it as the new session's default `agent_id` — automatic, no explicit clock-in call required for the common case.

`server_handshake`'s `inputSchema` gains an optional `agent_id` string param. When provided, it overrides the session's auto-bound `agent_id` for the remainder of that session — covers cases where a host application's `clientInfo.name` isn't specific enough (e.g. distinguishing a model persona the host doesn't expose in its client metadata). No separate `agent_clock_in`/`agent_clock_out` tool pair is introduced; `server_handshake` already exists, is already the tool every session is expected to call first, and already returns quick-start text — this is an extension of it, not a new verb.

### `stdio-proxy.ts` changes

Today, `handleLine` intercepts `initialize` and answers it locally, entirely without contacting the daemon (see the `if (msg.method === "initialize" && msg.id !== undefined)` branch) — the daemon currently has no way to know a proxied session exists at all. This changes to:

- Forward `initialize` to the daemon like any other message, and wait for its response before answering the client (per the "forward synchronously" decision — a slightly slower first call in exchange for the guarantee that no other request can arrive before the session is registered).
- Capture the `Mcp-Session-Id` response header from that call and hold it in a module-level variable for the life of the proxy process (stdio-proxy is still genuinely one process per client — that half of the original 2026-07-08 assumption still holds; only the daemon side needed to change).
- Attach `Mcp-Session-Id: <id>` on every subsequent forwarded request.

### Scope of inheritance (unchanged from the 2026-07-08 spec)

Tools whose `agent_id`-like parameter consults the active session, via `resolveStoredAgentId`/`resolveStoredSessionId`, now keyed by the request's real session instead of one process-global variable:

- `store_memory` (authorship) — also gains `session_id` via `resolveStoredSessionId`.
- `connect_memories` (performer of the connection)
- `distill_memory` (distilled memory's authorship)
- `share_memory` (performer of the share action)
- `update_memory`'s telemetry `agent_id` (loop-telemetry attribution only — **not** `memory_agent_id`)
- `close_task`'s actor `agent_id`
- `retrieve_memory`'s telemetry `agent_id`

**Explicit exclusion, unchanged:** `update_memory`'s `memory_agent_id` repair-only field must never consult session state — it stays explicit-argument-only, for the same reason as the original design (its entire purpose is deliberate backfill of *another* memory's attribution).

### Session end

Three independent triggers, any of which clears that session's `agentSession` binding (the underlying MCP session/transport doesn't necessarily have to close just because identity was cleared — clearing the binding and closing the session are separate actions, and `close_task`/handoff should only do the former):

1. **Idle timeout.** A session with no requests for a configurable window (proposed default: 30 minutes, env-var configurable following this project's existing pattern, e.g. `NEURODIVERGENT_MEMORY_SESSION_IDLE_MS`) has its transport/server closed and its map entry removed.
2. **`kind:handoff` tag hook.** Same as the original design: after a successful `store_memory`/`update_memory` call whose resulting memory's `tags` contains the exact tag `kind:handoff`, clear that session's binding. Exact tag-array membership, not content matching.
3. **`close_task`-based hook.** After a successful `close_task` transition to `closed` for that session's bound agent, clear the binding.

All three append a visible note to their tool's normal response when they fire (matching the original design's "never silent" principle) — e.g. `🕐 Session identity cleared (idle timeout)` / `(handoff tag detected)` / `(close_task)`.

## Non-goals for this pass

- The web bridge's own daemon calls (`scripts/nd-mem-bridge-server.mjs`'s `runMcpTool`) stay stateless/per-call, no session. It's an infrastructure proxy relaying writes on behalf of whoever is at the browser, not itself an agent needing identity attribution. Can be revisited later if that changes.
- Persisting session state across a daemon restart — matches the original design's simplicity; a restart means every client re-initializes and gets a fresh session, same as today's reconnect behavior.
- The paused Step 3 (LAN bind + API-key auth, `2026-07-11-remote-shared-memory-service-design.md`) stays a separate design thread, though it could reuse this session registry later (e.g. attaching a bearer token at the same `onsessioninitialized` point identity is captured).
- The "post-handoff orphan write" telemetry bonus from the original design (tracking memories that land unassigned shortly after a session's binding clears) — still deferred, not built in this pass.

## Testing

- A session persists across multiple sequential requests carrying the same `Mcp-Session-Id`: `agent_id` is inherited on the second/third call without being re-specified.
- Two concurrent sessions do not clobber each other's `agent_id` — the actual regression this design exists to prevent, and the one the 2026-07-08 design would have reintroduced if implemented as-is.
- `clientInfo.name` auto-binds on `initialize`; an explicit `agent_id` passed to `server_handshake` overrides it for the rest of that session.
- Idle-timeout expiry clears the binding and frees the session's resources; a request after expiry starts a fresh, unbound session rather than erroring.
- The `kind:handoff` tag hook and `close_task` hook each independently clear the binding, and neither double-fires when both conditions are eventually met in the same session.
- Regression guard: `update_memory`'s `memory_agent_id` is unaffected by session state under all conditions.
- `stdio-proxy.ts` forwards `initialize` synchronously, receives and stores the real session id, and attaches it on every subsequent forwarded call.
