# neurodivergent-memory — Agent Bootstrap Instructions

This file is automatically read by GitHub Copilot and compatible agents at the start of every session.
It replaces the need to fetch the governance memory (`memory_11`) before working with this MCP server.

---

## What this server is

`neurodivergent-memory` is a **Model Context Protocol (MCP) server** that stores and retrieves memories as a
knowledge graph. It is designed for neurodivergent thinking patterns: non-linear, associative, tag-rich.

Memories are organised into five **districts** (knowledge domains) and connected via bidirectional edges.
Search uses **BM25 semantic ranking** — no embedding model or cloud LLM required.

---

## Canonical Tag Schema

Always apply tags from the four namespaces below when calling `store_memory`.
Multiple tags from different namespaces are expected on every memory.

| Namespace | Purpose | Examples |
|---|---|---|
| `topic:X` | Subject matter / domain | `topic:unity-ecs`, `topic:adhd-strategies`, `topic:rust-async` |
| `scope:X` | Breadth of the memory | `scope:concept`, `scope:project`, `scope:session`, `scope:global` |
| `kind:X` | Type of knowledge | `kind:insight`, `kind:decision`, `kind:pattern`, `kind:reference`, `kind:task` |
| `layer:X` | Abstraction level | `layer:architecture`, `layer:implementation`, `layer:debugging`, `layer:research` |

**Example tag set for a Unity ECS memory:**
```
["topic:unity-ecs", "topic:dots", "scope:project", "kind:pattern", "layer:architecture"]
```

---

## Districts

| Key | Purpose |
|---|---|
| `logical_analysis` | Structured thinking, analysis, research findings |
| `emotional_processing` | Feelings, emotional states, affective responses |
| `practical_execution` | Tasks, plans, implementations, action items |
| `vigilant_monitoring` | Risks, warnings, constraints, safety concerns |
| `creative_synthesis` | Novel connections, creative ideas, cross-domain insights |

---

## Available MCP Tools (quick reference)

| Tool | Purpose |
|---|---|
| `store_memory` | Create a new memory node |
| `retrieve_memory` | Fetch one memory by ID |
| `update_memory` | Modify content, tags, district, valence, or intensity |
| `delete_memory` | Remove a memory and all its connections |
| `connect_memories` | Add an edge between two memory nodes |
| `search_memories` | BM25-ranked search with optional `min_score`, district, tag, valence, intensity filters |
| `traverse_from` | BFS graph walk from a node up to N hops |
| `related_to` | Hop-proximity + BM25 blend for a given memory ID |
| `list_memories` | Paginated enumeration of all stored memories |
| `memory_stats` | Totals, per-district counts, most-accessed, orphans |
| `import_memories` | Bulk seed from a JSON array |

---

## Persistence

Memories are automatically saved to `~/.neurodivergent-memory/memories.json` on every write.
The graph is restored on server startup — no data is lost between restarts.

---

## Bootstrap checklist for new agent sessions

1. Call `memory_stats` to see how many memories exist.
2. Use `search_memories` with a broad query to locate relevant prior context.
3. Apply the canonical tag schema when calling `store_memory`.
4. Connect new memories to related existing ones with `connect_memories`.
5. Use `traverse_from` or `related_to` for associative retrieval rather than repeated searches.
