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

## Benchmark Baseline (2026-03-31)

Environment:

- Node: `v24.11.1`
- Platform: `win32 10.0.26200 (x64)`
- CPU: `Intel(R) Core(TM) i7-10870H CPU @ 2.20GHz` (16 logical cores)
- Memory: `31.91 GB`
- Commit: `54e44ad`

Method:

- Harness: `npm run benchmark`
- Transport: end-to-end MCP stdio against `build/index.js`
- Isolation: temp persistence directory per dataset run
- Sizes: 1k / 5k / 10k memories
- Measurements: 100 sampled `store_memory` writes near each dataset tier, 100-query `search_memories` latency, 100-query `list_memories` latency, and `traverse_from` latency at depths 2/3/5 over a connected 500-memory graph

| Dataset | Measured Writes | Store Throughput ops/s | Search p95 ms | List p95 ms | Traverse d2 p95 ms | Traverse d3 p95 ms | Traverse d5 p95 ms |
| ---- | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| 1000 | 100 | 654.1 | 5.39 | 1.02 | 0.40 | 0.45 | 0.38 |
| 5000 | 100 | 260.5 | 27.99 | 3.24 | 0.43 | 0.39 | 0.37 |
| 10000 | 100 | 175.4 | 71.97 | 8.58 | 0.49 | 0.43 | 0.58 |

Baseline artifacts (committed, not overwritten by default):

- Raw benchmark JSON baseline (committed file): `benchmark-results/memory-benchmark-baseline.json`
- Markdown benchmark report baseline (committed file): `benchmark-results/memory-benchmark-baseline.md`
  These paths refer to the committed baseline artifacts for the run described above; local benchmark runs may write results to different filenames or locations.
