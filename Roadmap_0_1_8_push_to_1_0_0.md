# Roadmap

This page tracks the milestones from the current research preview toward the 1.0.0 production release.

> **Design note:** The district model is rooted in [FractalSemantics(FractalStat)](https://gitlab.com/tiny-walnut-games/fractalstat) addressing, where every entity inherits ancestry from a single anchor point called **LUCA** (Last Universal Common Ancestor). These concepts are also used in [Warbler-CDA](https://gitlab.com/tiny-walnut-games/the-seed/-/tree/4884b3a22da8a487e7c7931cb7426e20def0d7ba/warbler-cda-package), and [the seed](https://gitlab.com/tiny-walnut-games/the-seed). The five canonical districts are the five direct children of LUCA in the default schema. Custom districts in later milestones must declare a valid LUCA-derived address, making ancestry explicit and traceable rather than assumed.

---

## Current Position: v0.2.0 Published, v0.3.0 in Release Readiness

The project is in active pre-1.0 development. All 0.x releases should be interpreted as:

- **Ready for** research, controlled pilots, and single-agent workflows.
- **Not ready for** production-scale, multi-tenant, or high-criticality deployments.

This position is intentional and consistent with semantic versioning conventions for 0.x software.

Release-readiness snapshot for the `development` branch as of 2026-04-03:

- Latest published package version remains `0.2.0`.
- Core planned v0.3.0 feature issues #54 through #59 are implemented and merged.
- Remaining release-readiness work is primarily tracker/documentation reconciliation plus follow-up Issue #74 for the residual epistemic-status gap.

---

## Release History

| Version | Date | Summary |
| ---- | ---- | ---- |
| v0.2.0 | 2026-04-01 | Trust & Telemetry milestone delivered (persistence hardening, concurrency safety, error taxonomy, loop telemetry, baseline benchmarks) |
| v0.1.8 | 2026-03-28 | Docker Hub README auto-refresh via CI; Node 24 upgrade |
| v0.1.7 | 2026-03-28 | Fixed GIF/link rendering on Docker Hub and GHCR using absolute URLs |
| v0.1.6 | 2026-03-28 | Disabled immutable `latest` tag to fix Docker Hub publish failures |
| v0.1.5 | 2026-03-28 | Published to official MCP Registry (`registry.modelcontextprotocol.io`) |
| v0.1.3 | 2026-03-28 | Added GHCR publishing alongside Docker Hub |
| v0.1.2 | 2026-03-28 | Release pipeline hardening; rerun-safe npm publish |
| v0.1.1 | 2026-03-28 | Initial research preview release |

For full details see [[Release Notes]].

---

## Milestones

### v0.2.0 — Trust & Telemetry

> *Theme: Make the foundation trustworthy before building on it. Observe before acting.*

- **Progress Snapshot (2026-03-31)**

- ✅ Persistence hardening delivered (WAL replay/compaction, startup telemetry, configurable storage path and eviction policy)
- ✅ Concurrency safety delivered (async write mutex, bounded write queue backpressure, WIP saturation warning)
- ✅ Structured logging and error taxonomy delivered (Pino write-path logs, NM_E001+ responses with Code/Message/Recovery)
- ✅ Loop telemetry observe-only counters delivered (repetition, similarity, ping-pong, memory_stats loop telemetry block)
- ✅ Performance baseline published (1k/5k/10k benchmark harness + baseline outputs in `benchmark-results/` and `TEST_SUMMARY.md`)

- **Persistence Hardening**

- Replace single-file atomic write with a write-ahead log (WAL) pattern — append operations to a journal, compact on startup
- Implement crash recovery: detect incomplete writes on startup and roll back or replay from journal
- Add configurable memory cap with eviction policy options (LRU, access-frequency, or district-priority)
- Make storage path configurable via environment variable (currently hardcoded to `~/.neurodivergent-memory/`)

- **Concurrency Safety**

- Implement an async write mutex to serialize all write operations — prevents data corruption when multiple tool calls arrive simultaneously
- Add write queue with backpressure signaling — callers receive a meaningful error rather than silent data loss under contention
- Document safe single-agent concurrency guarantees vs. known unsafe multi-agent scenarios
- Default WIP guardrail: limit `in_progress` memories to 1 per `agent_id` or `session_id` in `practical_execution`

- **Structured Logging & Error Taxonomy**

- Replace raw `console.log`/`console.error` with a structured logger (e.g. `pino`) outputting JSON log lines
- Define a stable error code taxonomy (`NM_E001` through `NM_E0xx`) — every failure path gets a code operators can reference programmatically
- Distinguish recoverable vs. unrecoverable errors with appropriate severity levels
- All MCP tool error responses include: error code, human message, and suggested recovery action

- **Loop Telemetry (Observe Only)**

- Add repetition counters: detect when the same memory content is being written or re-read in rapid succession
- Add similarity scoring across recent writes to flag potential analysis-rumination patterns
- Add ping-pong detector: surface when two agents or two districts are exchanging the same memory without net-new information
- Telemetry is **observability only** at this stage — no behavior changes, just measurement and reporting

- **Performance Baseline**

- Add a benchmark suite: store throughput, BM25 search latency at 1k/5k/10k memories, graph traversal depth
- Publish benchmark results in the wiki as a regression baseline
- Document memory growth rate under typical agent workloads

- **Suggested Next Execution Order**

1. Project identifier support (Issue #28)
2. Distillation and contextual retrieval prep (v0.3.0)
3. Performance follow-up hardening only if regressions surface from the published baseline

---

### v0.3.0 — Distillation & Contextual Intelligence

> *Theme: Make the server aware of who is asking, why they are asking, and how to translate signal without losing it.*

#### Status Snapshot (2026-04-03)

| Feature | Issue | Status |
|---|---|---|
| Distillation Layer | #54 | ✅ Merged (PR #61) |
| Loop Behavior Guardrails | #55 | ✅ Merged (PR #66) |
| Agent Identity | #56 | ✅ Merged (PR #70) |
| Goal-Aware & Contextual Retrieval | #57 | ✅ Merged (PR #72; verification-only PR because implementation was already present) |
| LUCA-Addressed Custom Districts | #58 | ✅ Merged (PR #69) |
| Import & Storage Diagnostics UX | #59 | ✅ Merged (PR #65) |

Additional post-roadmap progress:

- PR #73 merged multi-tier memory sync (`project` / `user` / `org`) plus `persistence:durable` / `persistence:ephemeral` guidance.
- Follow-up Issue #74 now tracks the remaining epistemic-status defaulting and retrieval-consistency gap that was previously called out as an untracked item.

- **Distillation Layer (Emotional → Logical Translation)**

- Add a first-class `distill_memory` tool that translates a `emotional_processing` memory into a structured logical artifact
- Output shape: `signals`, `triggers`, `constraints`, `next_actions`, `risk_flags`
- Logical and planning agents consume distilled artifacts by default — not raw emotional narrative — preventing analysis-rumination loops
- Add `abstracted_from` pointer on distilled memories linking back to the source emotional memory without exposing its full content
- This implements **selective abstraction, not hiding**: the emotional signal is preserved, intensity is reduced, and the logical layer receives structured input

- **Loop Behavior Guardrails (Act on Telemetry)**

- Building on v0.2.0 telemetry: add behavioral responses to detected loops
- "No net-new info" warning surfaced in tool response when repetition threshold is crossed
- Auto-suggest distillation step when `emotional_processing` content is being repeatedly accessed by `logical_analysis` agents
- Optional cooldown on repetitive cross-district writes

- **Agent Identity** ✅

- Add optional `agent_id` field to `store_memory`, `connect_memories`, and `import_memories`
- Each memory records which agent created it
- `memory_stats` extended to report per-agent contribution breakdown
- Enables future per-agent scoping, quota enforcement, and attribution

- **Goal-Aware & Contextual Retrieval** ✅

- Add optional `context` parameter to `search_memories` and `related_to` — a short string describing the agent's current goal
- Context string is BM25-scored against memory content and blended into ranking — higher relevance to declared goal boosts score
- Add `recency_weight` parameter to `search_memories` — bias retrieval toward recent vs. well-established memories
- Add `min_intensity` / `max_intensity` filter to `search_memories` (emotional intensity filtering)

- **LUCA-Addressed Custom Districts** ✅

- Allow district names beyond the five canonical districts
- Custom districts must declare a **LUCA-derived address** — a valid ancestry path back to one of the five canonical districts
- Example: `project_build_pipeline` declares parent `practical_execution`, inheriting its position in the fractal hierarchy
- `memory_stats` extended with per-district breakdown including custom districts
- Document the migration path for users adding project-specific districts

- **Import & Storage Diagnostics UX** ✅

- Add explicit storage diagnostics surface so operators can see resolved snapshot path, WAL path, and effective environment source in one response
- Extend `import_memories` with file-based mode (`file_path`) so clients can import server snapshots without expanding large payloads over MCP
- Add `dry_run` import preflight that validates records and returns deterministic counts for `would_import`, `would_skip`, and `would_fail`
- Add dedupe policies for import (`none | content_hash | content_plus_tags`) and return dedupe reason codes for skipped rows
- Define migration semantics for snapshot import (`preserve_ids` and `merge_connections` policy flags) with explicit safety constraints and rejection behavior

Delivered in Issue #59 / PR #65.

---

### v0.4.0 — Council & Multi-Agent Orchestration

> *Theme: Make the server a coordination layer. Support both council-style and Kanban CLI agent workflows without either disrupting the other.*

- **Session Scoping**

- Add `session_id` concept — a logical grouping for memories belonging to a coordinated agent workflow
- `import_memories` extended to accept `session_id` for bulk session initialization
- `memory_stats` extended with per-session breakdown
- Add `list_sessions` tool returning active session summaries

- Per-agent write queues — agents don't block each other unnecessarily under concurrent load
- Optimistic conflict detection: if two agents write to the same memory node concurrently, surface a merge conflict rather than silently overwriting
- Merge resolution policy interface: last-write-wins as default, custom resolver as option
- Publish a reference implementation: two-agent council workflow (one `logical_analysis` agent + one `creative_synthesis` agent) coordinating through shared distilled memory

- **Cross-Process Write Coordination**

- Add optional filesystem lock coordination mode for shared snapshot directories when multiple server processes are active
- Emit lock contention telemetry and deterministic retry/backoff guidance in tool errors
- Provide explicit single-writer and multi-writer runbook profiles with recommended deployment defaults

- **Kanban-Style CLI Agent Support**

- Add optional `status` field to `practical_execution` memories: `backlog | in_progress | blocked | done`
- Add `current_slice` field: one bite-sized next step (prevents TODO-bloat by keeping focus on the immediate action)
- Add optional `why_now` field: brief motivational or constraint anchor for context under cognitive load
- WIP guardrail from v0.2.0 enforced here: cannot have more than 1 `in_progress` per `agent_id`/`session_id` by default
- Done-quality gate: cannot mark `done` without a completion note or acceptance criteria link
- New tool: `kanban_view` — returns `practical_execution` memories by status, filterable by `agent_id` or `session_id`
- New tool: `update_status` — lightweight status transition tool (avoids full `update_memory` overhead for task state changes)

- **Visibility & Knowledge Sharing**

- Add `visibility` field to memories: `private` (agent-scoped) | `shared` (session-scoped) | `global` (all agents)
- `search_memories` and `retrieve_memory` respect visibility scope
- Add `share_memory` tool: transitions a memory from `private` → `shared` or `shared` → `global` with provenance recorded
- `abstracted_from` pointer from v0.3.0 used as the bridge: shared/global distilled memories link back to private emotional sources

---

### v1.0.0 — Production Sovereignty

> *Theme: Everything a real operator needs to trust this in production at scale.*

- **Durability Guarantees**

- Full ACID semantics for individual memory writes — write not acknowledged until journal entry is fsynced
- WAL journal compaction to clean snapshot on configurable interval or size threshold
- Point-in-time recovery: restore from any valid journal checkpoint
- Documented backup and restore procedures

- **Performance at Scale**

- Validated sub-second BM25 search at 100k+ memories (v0.2.0 benchmarks used as regression baseline)
- BM25 index persisted and incrementally updated rather than rebuilt on every startup
- Graph traversal depth limits enforced and configurable to prevent runaway queries

- **Multi-Tenant Isolation**

- Namespace isolation: multiple tenants share a server process with fully isolated memory stores
- Per-tenant configurable memory caps and district schemas
- Tenant authentication via configurable auth provider interface (token-based minimum)

- **Stable API Contract**

- All tools reach API stability — no breaking changes in 1.x without a major version bump
- Full JSON Schema documentation for every tool input/output
- MCP capability declaration updated to reflect stable feature set

- **Operational Runbooks**

- Health check endpoint or MCP resource exposing server liveness and storage health
- Runbook: startup, shutdown, backup, restore, memory cap enforcement
- Runbook: upgrading from 0.x to 1.0 including data migration steps
- Documented compatibility matrix: supported MCP client versions

- **Client Interoperability & Capability Clarity**

- Add a stable capability/introspection tool or resource so prompts and clients can distinguish tools, prompts, and enabled optional features at runtime
- Publish canonical client configuration profiles (`npx`, Docker, hosted) with equivalent persistence behavior and verification checks

---

## Pain-Point Release Mapping Addendum (2026-04-01)

The following unresolved pain points are now mapped to execution targets in the approved plan:

- **v0.3.0**
  - Storage diagnostics visibility (`resolve_storage_paths` + env precedence)
  - File-based import (`file_path`) with backward-compatible `entries` mode
  - Import `dry_run` preflight with deterministic summary counts
  - Import dedupe policy support and stable skip reason codes
  - Snapshot migration flags (`preserve_ids`, `merge_connections`) with safety guards
  - Primary tracking: **Issue #49** (`import_memories` file-path support)

- **v0.4.0**
  - Cross-process write coordination mode and contention guidance (shared directory safety)

- **v1.0.0**
  - Runtime capability/introspection contract + canonical client profile parity docs

> See also: [[Architecture]] · [[Release Notes]] · [[Getting Started]] · [[White Paper]]
