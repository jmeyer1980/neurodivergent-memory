---
applyTo: "**"
description: "Memory-driven workflow defaults for projects using neurodivergent-memory MCP."
---

Use neurodivergent-memory MCP as a persistent memory layer for development sessions.

## Session baseline

1. Start with `memory_stats`.
2. Run `search_memories` for the active task.
3. Use retrieved context before proposing or changing code.

## Cadence

- Ensure you claim, or add your moniker to, the author-role for memories you create or update to build a clear personal memory graph.
- Store key decisions, constraints, and blockers during work.
- Store the why behind decisions, not just the fact that a decision happened.
- Store the task plan in MCP memory before implementation, even when the plan is simple or already present in the prompt.
- For substantial implementation work, pair `practical_execution` updates with a `logical_analysis` or `creative_synthesis` memory when the durable principle should outlive the task log.
- If the source memory is noisy, distill it so the stable reasoning survives separately from the implementation detail.
- Connect related memories to reduce future rediscovery.
- Keep tags canonical: `topic:X`, `scope:X`, `kind:X`, `layer:X`.
- Do not treat repo memory files or local notes as substitutes for MCP memory writes.

## Minimum MCP sequence

When neurodivergent-memory MCP tools are available:

1. `memory_stats` and/or `list_memories`
2. `search_memories`
3. plan `store_memory` or `update_memory`
4. `connect_memories`
5. work execution
6. progress or decision `store_memory` or `update_memory`
7. `connect_memories`
8. validation memory write
9. final hand-off memory write and `connect_memories`

## Installation handshake

If neurodivergent-memory MCP is not installed or not connected:

1. Ask the user which setup policy should apply for this project:
   - `prompt-first`
   - `auto-setup`
2. If unspecified, default to `prompt-first`.
3. If approved to install, run `npm install -g neurodivergent-memory`.
4. Confirm with a simple memory operation before continuing.

## End-of-session requirement

Create a hand-off memory that captures:

- Completed work
- Remaining work
- Immediate next step (`current_slice`)
- Key constraints/risks
- The most important rationale or durable principle learned
