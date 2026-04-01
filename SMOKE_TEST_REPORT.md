# Neurodivergent Memory MCP Server - Smoke Test Report

Date: 2026-04-01
Server Version: 0.2.0
Status: PASS

## Scope

This run revalidated core MCP functionality after recent release pipeline, Docker, and registry changes.

Validated areas:

- TypeScript build and executable generation
- MCP stdio tool calls across storage, search, graph operations, update, listing, and stats
- Canonical tagging and district distribution behavior

## Test Environment

- Workspace: local repository checkout
- Runtime path: `node build/index.js`
- Isolation: temporary home directory (`.tmp-home`) to avoid old persisted data affecting outcomes
- Persistence path in isolated run: `.tmp-home/.neurodivergent-memory/memories.json`

## Commands Executed

1. `npm run build`
2. `./test-memory-graph.ps1 | node build/index.js`
3. Captured output to `test-results-full.jsonl`

## Results Summary

- Total MCP requests: 19
- Responses received: 19
- Tool-level errors (`result.isError=true`): 0
- Overall outcome: PASS

## Functional Checks

1. Memory creation (all 5 districts)

- PASS: 8 memories stored (`memory_1` through `memory_8`)

1. Connections

- PASS: 3 connections created successfully
- Note: current scripted scenario creates 3 edges in this run

1. Search

- PASS: BM25 ranking returned relevant results for all scripted queries
- Example query (`time blindness dopamine task initiation`) returned 5 ranked memories

1. Update

- PASS: `update_memory` executed against `memory_4` with `content` and `intensity`

1. Traversal and related

- PASS: `traverse_from` and `related_to` returned connected memories

1. Enumeration and stats

- PASS: list and stats returned consistent graph state
- Final stats snapshot:
  - Total memories: 8
  - Total connections: 3
  - Per district:
    - `logical_analysis`: 2
    - `emotional_processing`: 1
    - `practical_execution`: 2
    - `vigilant_monitoring`: 2
    - `creative_synthesis`: 1

## Issues Found and Resolved During Revalidation

The legacy script referenced outdated conventions from earlier versions.

Resolved before final pass:

- Memory IDs updated from `mem_*` to `memory_*`
- `update_memory` argument keys aligned to current API (`content`, `intensity`)
- Scenario strings updated to current context (v0.2.0, Node 24)

## Conclusion

The server and core tooling are operating correctly for the tested workflow on 0.2.0.
This confirms testability and functional integrity after recent release infrastructure changes.

For raw evidence, see `test-results-full.jsonl`.
