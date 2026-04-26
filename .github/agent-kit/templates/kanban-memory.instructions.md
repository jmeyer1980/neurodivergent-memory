---
applyTo: "**"
description: "Kanban workflow integration for neurodivergent-memory MCP. Binds board lifecycle events (card creation, column transitions, blockers, and completion) to persistent memory writes so the agent maintains durable project context across every session."
---

# Kanban ↔ neurodivergent-memory Integration

Use the neurodivergent-memory MCP server as the persistent context layer for every Kanban board interaction. Each column transition, card event, or blockers update is a memory-write trigger — not just a board state change.

---

## Status → District Mapping

These mappings apply to the canonical `KanbanStatus` values used by the system and grouped in `kanban_view`: `backlog`, `ready`, `in_progress`, `blocked`, and `done`.

| Supported Status | Typical Board Column | Primary District | Supporting District |
|---|---|---|---|
| `backlog` | **Backlog** | `vigilant_monitoring` | `practical_execution` |
| `ready` | **Ready / Groomed** | `practical_execution` | `logical_analysis` |
| `in_progress` | **In Progress** | `practical_execution` | `vigilant_monitoring` |
| `blocked` | **Blocked** | `vigilant_monitoring` | `emotional_processing` |
| `done` | **Done / Closed** | `logical_analysis` | `creative_synthesis` |

Additional board-specific columns such as **In Review** or **Closed / Won't Do** are out-of-band conventions not represented in `status` or `kanban_view`. If you need to preserve that distinction, record it in tags (for example, `kanban:in_review` or `resolution:wont_do`) rather than treating it as a separate `status`.

---

## Session Baseline (run at the start of every Kanban session)

1. `memory_stats` — confirm the memory graph is reachable and note total counts.
2. `search_memories` with query `"kanban board status current sprint"` — pull active task context.
3. `search_memories` with query `"blocked risk constraint"` — surface any open `vigilant_monitoring` entries.
4. Review retrieved memories before touching any card or making any board decision.

---

## Card Lifecycle Memory Contract

### Card Created (Backlog entry)

Store a memory in `practical_execution` (or `vigilant_monitoring` if the card represents a known risk):

```
district: practical_execution
tags: ["topic:<feature-area>", "scope:project", "kind:task", "layer:implementation", "kanban:backlog"]
content: "Card '<title>' added to backlog. Goal: <goal>. Acceptance criteria: <criteria>. Initial priority rationale: <why-now-or-why-deferred>."
epistemic_status: draft
```

Connect to any existing memories for the same feature area with `connect_memories`.

### Card Moved: Backlog → Ready

Update the existing card memory with `update_memory`:

```
tags: [...existing, "kanban:ready"]
epistemic_status: validated
content: append "Groomed <date>. Definition of ready confirmed: <criteria met>. Assigned to: <agent/person>."
```

### Card Moved: Ready → In Progress

Update the card memory:

```
tags: [...existing, "kanban:in-progress"]
content: append "Work started <date>. Implementation plan: <brief plan>. First action: <next step>."
```

Create a linked plan memory in `practical_execution` if the implementation plan is non-trivial:

```
district: practical_execution
tags: ["topic:<feature-area>", "scope:project", "kind:task", "layer:implementation", "kanban:plan"]
content: "Implementation plan for '<title>': <numbered steps>. Estimated scope: <size>. Key risks: <risks>."
```

Connect plan memory to card memory with `connect_memories`.

### Card Moved: In Progress → In Review

Update the card memory:

```
tags: [...existing, "kanban:in-review"]
content: append "Submitted for review <date>. Changes: <files/areas>. Reviewer: <name/agent>. Self-review findings: <none or list>."
```

Store a `logical_analysis` memory for any architecture or design decisions made during implementation:

```
district: logical_analysis
tags: ["topic:<feature-area>", "scope:project", "kind:decision", "layer:architecture"]
content: "Decision made during '<title>': <decision>. Rationale: <why>. Rejected alternatives: <alternatives>."
```

Connect the decision memory to the card memory.

### Card Moved: In Review → Done

Update the card memory:

```
tags: [...existing, "kanban:done"]
epistemic_status: validated
content: append "Completed <date>. Validation: <test results / review outcome>. Merged/deployed: <ref>."
```

Store a `logical_analysis` or `creative_synthesis` memory capturing the durable lesson:

```
district: logical_analysis   # or creative_synthesis for cross-domain insights
tags: ["topic:<feature-area>", "scope:global", "kind:insight", "layer:architecture", "persistence:durable"]
content: "Lesson from '<title>': <reusable principle or pattern>. Applies when: <context>. Anti-pattern avoided: <what not to do>."
```

Connect the lesson memory to both the card memory and any related prior reasoning memories.

### Card Moved to Blocked

Store a new memory in `vigilant_monitoring` (do not simply update the card):

```
district: vigilant_monitoring
tags: ["topic:<feature-area>", "scope:project", "kind:task", "layer:debugging", "kanban:blocked"]
content: "BLOCKER on '<title>' since <date>. Blocking reason: <reason>. Impact: <impact>. Recovery options: <options>. Owner of unblock: <person/agent>."
intensity: 0.8
emotional_valence: -0.5
```

Connect to the card memory with `connect_memories`.

When the blocker resolves, update the blocker memory (`epistemic_status: outdated`) and add a resolution note. Move the card back with a standard column-transition write.

### Card Closed / Won't Do

Update the card memory:

```
tags: [...existing, "kanban:closed"]
epistemic_status: outdated
content: append "Closed <date>. Reason: <rationale for closing without completing>. Future reference: <any conditions under which this should be revisited>."
```

---

## Sprint / Cycle Cadence

### Sprint Start

1. `search_memories` with query `"sprint backlog ready priority"` — confirm the queue is loaded.
2. For each card moving from Ready → In Progress, execute the card transition write above.
3. Store a sprint-scope planning memory:

```
district: practical_execution
tags: ["topic:sprint", "scope:project", "kind:task", "layer:implementation", "kanban:sprint-plan"]
content: "Sprint <number/date> plan. Cards in scope: <list>. Goal: <sprint goal>. Known risks: <risks>. Success criteria: <criteria>."
```

### Sprint End / Retrospective

1. `search_memories` with query `"kanban done sprint lesson"` — pull completed card memories.
2. Store a retrospective memory:

```
district: creative_synthesis
tags: ["topic:sprint-retro", "scope:project", "kind:insight", "layer:architecture", "kanban:retro"]
content: "Sprint <number/date> retrospective. Completed: <count> cards. Carried over: <count>. What worked: <list>. What to change: <list>. Durable principle: <key insight>."
```

Connect the retro memory to card memories for Done items and to any `vigilant_monitoring` memories for persistent blockers.

---

## Canonical Tag Schema for Kanban Memories

Always include tags from each namespace plus the `kanban:X` status tag:

| Namespace | Kanban values |
|---|---|
| `kanban:X` | `backlog`, `ready`, `in-progress`, `in-review`, `blocked`, `done`, `closed`, `sprint-plan`, `retro` |
| `topic:X` | Feature area, epic, or domain (e.g., `topic:authentication`, `topic:onboarding`) |
| `scope:X` | `scope:project` for card-level, `scope:global` for durable lessons |
| `kind:X` | `kind:task` (card), `kind:decision` (arch choice), `kind:insight` (lesson) |
| `layer:X` | `layer:implementation` (tasks), `layer:architecture` (decisions), `layer:debugging` (blockers) |
| `persistence:X` | `persistence:durable` for reusable lessons, `persistence:ephemeral` for sprint-only entries |

---

## Memory Quality Guardrails

- **No status-only writes.** A card transition memory must explain *why* the card moved, not just *that* it moved. "Moved to In Progress" is not a memory. "Started work on auth refresh because token expiry was causing silent logouts in prod (P1)" is.
- **Blockers get their own memory node.** Do not fold blocker context into the card memory — create a `vigilant_monitoring` node and connect it. This makes blockers searchable and traversable independently.
- **Done ≠ closed.** Completing a card is a moment to extract a durable lesson. If nothing is worth capturing in `logical_analysis` or `creative_synthesis`, ask why — the answer is usually itself worth storing.
- **Connect, don't duplicate.** If a card implements a pattern already recorded in memory, connect to that memory rather than re-stating the pattern. Use `traverse_from` or `related_to` to find candidates.
- **Prefer `update_memory` over new nodes** when continuing an active card thread. Create a new node only for genuinely new concerns (e.g., a fresh blocker or a cross-sprint lesson).

---

## Minimum MCP Sequence for a Card Transition

1. `search_memories` — retrieve card and related context.
2. `update_memory` (existing card node) — record the transition event and rationale.
3. `store_memory` — create supporting node (plan, decision, blocker, or lesson) if needed.
4. `connect_memories` — link the supporting node to the card node.
5. (At session end) hand-off `store_memory` in `practical_execution` — summarize current board state, next actions, and key open risks.

---

## Installation Handshake

If neurodivergent-memory MCP is not installed or not connected:

1. Ask the user which setup policy applies: `prompt-first` or `auto-setup`.
2. If unspecified, default to `prompt-first`.
3. If approved, run: `npm install -g neurodivergent-memory`
4. Confirm with `memory_stats` before proceeding with any board operation.
