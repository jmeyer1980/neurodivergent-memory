# Agent Clock-In / Clock-Out Design

**Date:** 2026-07-08
**Status:** Approved for planning
**Target:** development branch, build-and-serve-locally (not part of a 0.4.0 release cut)

## Problem

`agent_id` attribution is inconsistently set across this project's own memory graph — `memory_stats(project_id=twg-progressiongraph)` showed 125/191 (65.4%) memories `unassigned`, and the share grew rather than shrank after an earlier round of skill-level guidance. Root cause (from memory_1118, a 2026-07-08 reflection): passing `agent_id` on every `store_memory`/`update_memory` call is per-write ceremony that gets skipped under real task pressure, and `update_memory`'s `agent_id` param is a separate footgun — it's repurposed for loop-telemetry attribution only, not authorship; the actual authorship-repair field is the non-obviously-named `memory_agent_id`.

memory_1139 (same day) proposed the fix explored here: let an agent "clock in" once at the start of a task, and have every subsequent write in that session inherit the agent_id (and a session_id) as a default, still overridable per-call.

## State model & architecture

A module-level, in-memory "active session" object, scoped to a single server process:

```ts
{ agent_id: string; session_id: string; clocked_in_at: Date } | undefined
```

**Why in-memory and process-global is safe:** confirmed in `src/index.ts` — the server uses a single `StdioServerTransport` ([src/index.ts:7055](../../../src/index.ts#L7055)), meaning each MCP client (Claude Code, Cline, Copilot, etc.) spawns its own server process. There is no shared daemon serving multiple concurrent clients, so there is no cross-talk risk between sessions. State is never persisted to the snapshot/WAL; a server restart always starts clocked-out. No new persistence format, no migration.

**Choke points.** Two resolver functions become the only places active-session state is consulted:

- `resolveStoredAgentId` (existing, `src/index.ts:4619`) — currently `normalizeOptionalAgentId(agentId) ?? DEFAULT_AGENT_ID`. New fallback chain: **explicit arg → active session's `agent_id` → `DEFAULT_AGENT_ID` ("unassigned")**.
- `resolveStoredSessionId` (new, mirrors the above) — **explicit arg → active session's `session_id` → unset**.

**Explicit exclusion:** `update_memory`'s `memory_agent_id` repair-only field must never consult active-session state. Its entire purpose is deliberate backfill of *another* memory's attribution; auto-defaulting it would silently overwrite other agents' work — exactly the failure mode clock-in exists to prevent. It stays explicit-argument-only.

## New tools

### `agent_clock_in`

- Input: `agent_id` (required), `session_id` (optional).
- If `session_id` is omitted, one is minted automatically (e.g. `session_<timestamp>_<short-random>`).
- Effect: sets the active session to `{ agent_id, session_id, clocked_in_at: now }`.
- Re-clock-in while a session is already active: **overwrite, and return a warning** naming the replaced agent_id/session_id (last-write-wins, but visible in the transcript, not silent).
- Response confirms the new active agent_id/session_id and states that subsequent writes on the inheriting tools (below) will default to these values unless overridden per-call.

### `agent_clock_out`

- No required input — process-per-client architecture means there's nothing to disambiguate.
- Effect: clears the active session to `undefined`.
- Idempotent: calling with nothing active returns a stable "already clocked out" no-op response, matching the existing `close_task` "already closed" pattern.
- When something was active, the response reports what was cleared: agent_id, session_id, and session duration.

Both tools follow this file's existing pattern for lifecycle tools (`close_task`, `resume_task`): a schema entry in the tool list, a `case` handler, and a one-line entry in the tool-usage-hint switch (see `case "close_task"` around `src/index.ts:5806`).

## Automatic clock-out triggers

Per design decision, **both** of the following trigger clock-out — whichever happens first in a given session:

1. **Tag-based hook.** After a successful `store_memory` or `update_memory` call, if the resulting memory's `tags` array contains the exact tag `kind:handoff` **and** a session is currently active, clock out as a side effect of that call. This checks exact array membership against the project's existing `topic:`/`scope:`/`kind:`/`layer:` tag convention — not content/prose matching — so it cannot misfire on a memory that merely mentions "handoff" in its text.
2. **`close_task`-based hook.** After a successful `close_task` transition to `closed`, if a session is currently active, clock out.

Both checks are independent and idempotent with respect to each other: whichever fires first clears the active state; if the other condition is also met later, it's a no-op (nothing left to clear). Both auto-clock-out paths append a line to their tool's normal response (e.g. `🕐 Auto-clocked-out agent 'X' (handoff tag detected)`) so the side effect is visible in-transcript, never silent.

The tag hook relies on the calling agent/skill continuing to attach `kind:handoff` when writing a session-end memory, matching the tagging convention already observed throughout this project's own memory graph. The server does not infer "this looks like a handoff" any other way (no content/prose heuristics).

## Scope of inheritance

Tools whose `agent_id`-like parameter picks up the active-session default (via `resolveStoredAgentId`, either already routed through it or aligned to do so as part of this work):

- `store_memory` (authorship) — also gains `session_id` via `resolveStoredSessionId`.
- `connect_memories` (performer of the connection)
- `distill_memory` (distilled memory's authorship)
- `share_memory` (performer of the share action)
- `update_memory`'s telemetry `agent_id` (loop-telemetry attribution only — NOT `memory_agent_id`)
- `close_task`'s actor `agent_id`
- `retrieve_memory`'s telemetry `agent_id`

Untouched: `update_memory`'s `memory_agent_id` (see exclusion above).

## Observability

`server_handshake` gains one additional line reflecting current state (matching this project's own durable principle that state machines should always expose current state, not just transitions):

- Active: `Active session: agent_id=X, session_id=Y, clocked in <duration> ago`
- Inactive: `Active session: none (clocked out)`

## Testing

- `resolveStoredAgentId` / `resolveStoredSessionId` fallback chain: explicit arg wins over active session, which wins over the `DEFAULT_AGENT_ID`/unset default.
- `agent_clock_in` → `agent_clock_out` round-trip, including idempotent double-clock-out and overwrite-with-warning on double-clock-in.
- Both auto-clock-out triggers firing independently, and not double-firing when both conditions are eventually met in the same session.
- Regression guard: `update_memory`'s `memory_agent_id` is unaffected by active-session state under all conditions.

## Out of scope for this pass

- Persisting active-session state across a server restart.
- Cross-process / shared-daemon safety (confirmed unnecessary given the per-process architecture).
- The "post-handoff orphan write" telemetry bonus from memory_1139 (tracking memories that land unassigned shortly after a clock-out, surfaced similarly to `repeat_write_candidates`) — deferred as a possible follow-up, not built in this pass.
- Publishing/releasing as part of 0.4.0. This work is build-and-serve-locally only for now.
