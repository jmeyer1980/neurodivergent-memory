# Smoke Test Experiment: Executive Function Support Network (0.2.0)

## Overview

This experiment reruns the narrative memory-graph scenario used for earlier releases, updated for current server behavior and release context.

Date: 2026-04-01
Version under test: 0.2.0
Run mode: isolated persistence for deterministic results

## Goals

1. Reconfirm that the MCP server still supports the end-to-end cognitive workflow.
2. Validate that recent release/tooling updates did not break core memory operations.
3. Replace stale 0.1.1-era evidence with current run artifacts.

## Scenario Design

The test models executive-function support using five districts:

- `logical_analysis`
- `emotional_processing`
- `practical_execution`
- `vigilant_monitoring`
- `creative_synthesis`

It creates and links memories, runs search queries, mutates one node, traverses graph edges, and verifies final stats.

## Execution Snapshot

Requests executed: 19
Successful responses: 19
Tool-level failures: 0

Phases exercised:

1. Create 8 memories with canonical tags.
2. Create graph connections.
3. Run semantic and filtered searches.
4. Update one memory (`memory_4`).
5. List memories and generate aggregate statistics.
6. Traverse from an anchor memory and run `related_to`.

## Key Outcomes

1. Storage and district assignment

- 8 memories stored, all districts represented.

1. Search behavior

- BM25 ranking produced coherent results for scenario-specific queries.
- Tag and district constraints returned focused subsets.

1. Graph behavior

- Connections were created and later surfaced by traversal/related queries.
- Traversal from `memory_1` returned reachable nodes within depth 2.

1. Update behavior

- `update_memory` accepted current API shape (`content`, `intensity`) and completed successfully.

1. System stats

- Final run snapshot:
  - total memories: 8
  - total connections: 3
  - district split: 2 / 1 / 2 / 2 / 1

## Findings

The run confirms current operational health for the tested workflow on 0.2.0.

Additionally, this revalidation surfaced and fixed stale harness assumptions from older versions:

- old memory IDs (`mem_*`) were updated to `memory_*`
- legacy update fields were aligned with current tool schema
- test narrative references updated to Node 24 and v0.2.0 context

## Evidence

Primary artifact: `test-results-full.jsonl`
Supporting summary: `TEST_SUMMARY.md`
Detailed pass report: `SMOKE_TEST_REPORT.md`

## Conclusion

The experiment supports continued research-preview use on 0.2.0 and provides current, reproducible test evidence after recent release and registry milestones.
