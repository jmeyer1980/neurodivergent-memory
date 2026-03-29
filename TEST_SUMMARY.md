# Test Summary

Date: 2026-03-29
Server: neurodivergent-memory v0.1.8
Build: PASS
Smoke test: PASS

## Quick Results

- Build command: `npm run build`
- Smoke command: `./test-memory-graph.ps1 | node build/index.js`
- Requests executed: 19
- Responses received: 19
- MCP tool-level errors: 0

## Functional Coverage

Validated in this run:
- Memory creation across all five districts
- Canonical tagging and listing
- BM25 search and filtered retrieval
- Memory connections
- Traversal (`traverse_from`) and associative lookup (`related_to`)
- Memory mutation (`update_memory`)
- Aggregate statistics (`memory_stats`)

## Final State (Isolated Run)

- Total memories: 8
- Total connections: 3
- District distribution:
  - logical_analysis: 2
  - emotional_processing: 1
  - practical_execution: 2
  - vigilant_monitoring: 2
  - creative_synthesis: 1

## Harness Maintenance Completed

To keep this test valid for current server behavior:
- Updated memory IDs from `mem_*` to `memory_*`
- Updated `update_memory` payload fields to current schema
- Updated scenario references from v0.1.1/Node 20 to v0.1.8/Node 24

## Artifacts

- Detailed report: `SMOKE_TEST_REPORT.md`
- Narrative report: `EXPERIMENT_REPORT.md`
- Raw interaction log: `test-results-full.jsonl`
