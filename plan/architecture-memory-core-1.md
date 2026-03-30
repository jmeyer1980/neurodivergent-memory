---
goal: Memory Core Roadmap Execution Plan (v0.2.0 to v0.3.0)
version: 1.0
date_created: 2026-03-29
last_updated: 2026-03-29
owner: jmeyer1980 + Copilot
status: 'Planned'
tags: [architecture, feature, roadmap, telemetry, distillation]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This document defines the implementation sequence for roadmap milestones v0.2.0 and v0.3.0 in the TypeScript MCP server. The plan is optimized for deterministic execution, preserves the existing API where possible, and ports only high-value patterns discovered in Warbler as read-only references.

## 1. Requirements & Constraints

- **REQ-001**: Keep Warbler files reference-only; do not add imports from development-artifacts paths.
- **REQ-002**: Preserve all existing MCP tools in src/index.ts with backward-compatible behavior unless explicitly versioned.
- **REQ-003**: Implement v0.2.0 observability-first loop telemetry before any automated behavior changes.
- **REQ-004**: Implement v0.3.0 distill_memory and abstracted_from linkage as first-class entities.
- **REQ-005**: Add optional agent_id support to store_memory, connect_memories, and import_memories.
- **REQ-006**: Add optional context + recency_weight support to search_memories and related_to.
- **REQ-007**: Add custom district registration with LUCA-derived parent validation.
- **REQ-008**: Distillation source eligibility is cross-district by default; emotional_processing is a high-priority source but not an exclusive source.
- **REQ-009**: Distillation policy must support allowlist/blocklist district constraints via configuration without code changes.
- **REQ-009**: Distillation policy must support allowlist/blocklist district constraints via configuration without code changes.
- **REQ-010**: Memories used as planning artifacts must support an explicit `epistemic_status` field: `draft | validated | outdated`. Agents must not treat `draft` or `outdated` memories as authoritative without human confirmation. (Source: council synthesis 2026-03-29.)
- **SEC-001**: Validate all new numeric input ranges in MCP input schemas and runtime guards.
- **SEC-002**: Do not expose private raw emotional content when returning distilled artifacts unless explicitly requested.
- **CON-001**: Single-file core architecture in src/index.ts is current state; incremental modular extraction is allowed but not required in v0.2.0.
- **CON-002**: Existing persistence file format must continue to load old snapshots without migration failure.
- **GUD-001**: Prefer additive interfaces and optional fields over breaking schema changes.
- **GUD-002**: Every new server-side behavior must have test coverage and failure-path tests.
- **GUD-002**: Every new server-side behavior must have test coverage and failure-path tests.
- **GUD-003**: New planning memories default to `epistemic_status: draft`. Transition to `validated` requires either human action or an explicit agent assertion with a rationale note stored as a connected memory. Transition to `outdated` may be automated when a superseding memory is connected via `abstracted_from` or a conflict edge. (Source: council synthesis 2026-03-29.)
- **PAT-001**: Apply Warbler-derived pattern: telemetry first, then guardrail activation.
- **PAT-002**: Apply Warbler-derived pattern: micro-to-macro distillation provenance chain.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Establish v0.2.0 durability and telemetry primitives without changing default user-visible behavior.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create src/core/types.ts defining MemoryNPC extensions: agent_id?, abstracted_from?, telemetry fields (repeat_count, last_similarity_score, ping_pong_counter). |  |  |
| TASK-001 | Create src/core/types.ts defining MemoryNPC extensions: agent_id?, abstracted_from?, epistemic_status?: 'draft' \| 'validated' \| 'outdated', and telemetry fields (repeat_count, last_similarity_score, ping_pong_counter). |  |  |
| TASK-002 | Create src/core/error-codes.ts with stable code map NM_E001-NM_E030 and helper for MCP error payload formatting. |  |  |
| TASK-003 | Create src/core/logger.ts with structured JSON logger wrapper and severity levels. |  |  |
| TASK-004 | Refactor persistence block in src/index.ts to use write-ahead journal file (memories.wal.jsonl) and startup compaction into memories.json. |  |  |
| TASK-005 | Add async write mutex + queue in src/index.ts for all mutating operations (store/update/delete/connect/import). |  |  |
| TASK-006 | Add config surface in src/index.ts for storage path env override and memory cap + eviction strategy enum (lru/access_frequency/district_priority). |  |  |
| TASK-007 | Extend MCP input schemas in src/index.ts list-tools handler: store_memory/connect_memories/import_memories optional agent_id. | ✅ | 2026-03-29 |
| TASK-008 | Add loop telemetry counters in src/index.ts for repeated writes, repeated reads, and ping-pong detection by district/agent pair. |  |  |
| TASK-009 | Extend memory_stats output in src/index.ts to include perAgent and loop telemetry summary blocks. | ✅ | 2026-03-29 |
| TASK-010 | Add benchmark harness skeleton at tests/benchmarks/memory-benchmark.ts covering 1k/5k/10k search latency and write throughput. |  |  |

### Implementation Phase 2

- **GOAL-002**: Implement v0.3.0 distillation and contextual retrieval behaviors on top of Phase 1 telemetry.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Create src/core/distillation.ts with DistilledArtifact type: signals[], triggers[], constraints[], next_actions[], risk_flags[], abstracted_from. |  |  |
| TASK-012 | Add new MCP tool schema distill_memory in src/index.ts with input: memory_id, mode(optional), output_district(optional). |  |  |
| TASK-013 | Implement distill_memory handler in src/index.ts: source must exist; source may be from any district by default; apply configurable policy (allowlist/blocklist + intensity threshold + optional district mappings); create derived memory with abstracted_from populated. |  |  |
| TASK-014 | Add loop guardrails in src/index.ts call handlers: when repetition threshold crossed, include warning metadata and distillation suggestion in tool response text. |  |  |
| TASK-015 | Extend search_memories schema + logic in src/index.ts with context:string and recency_weight:number[0..1]; blend normalized BM25 with recency score. |  |  |
| TASK-016 | Extend related_to schema + logic in src/index.ts with context + recency_weight blending over proximity+semantic score. |  |  |
| TASK-017 | Implement custom district registry in src/core/district-registry.ts with canonical base districts, LUCA-parent validation, and enum metadata inspired by development-artifacts/fractalsemantics/fractalsemantics/dynamic_enum.py. |  |  |
| TASK-018 | Add MCP tool register_district in src/index.ts to declare custom districts with parent_district and metadata. |  |  |
| TASK-019 | Extend list_memories/search_memories/memory_stats to include custom district counts and filtering behavior parity. |  |  |
| TASK-020 | Add tests in tests/distillation.spec.ts and tests/retrieval-context.spec.ts for abstraction, context-blended ranking, and guardrail messaging. |  |  |

### Implementation Phase 3

- **GOAL-003**: Stabilize release artifacts and docs for v0.2.0 then v0.3.0 cut.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-021 | Update README.md with new tool docs for distill_memory, register_district, context/recency retrieval, and agent_id fields. |  |  |
| TASK-022 | Update CHANGELOG.md with explicit migration notes and compatibility guarantees for persisted snapshots. |  |  |
| TASK-023 | Add wiki-aligned benchmark results section to SMOKE_TEST_REPORT.md and/or TEST_SUMMARY.md after benchmark run. |  |  |
| TASK-024 | Bump package.json version for v0.2.0 then v0.3.0, update server.json metadata consistently. |  |  |
| TASK-025 | Execute full verification: npm run build, smoke scripts, benchmark scripts, and report outputs checked into tracked docs only. |  |  |

## 3. Alternatives

- **ALT-001**: Implement full Warbler RetrievalAPI and FractalStat bridge directly in TypeScript. Not chosen because it introduces large conceptual surface before v0.2.0 hardening is complete.
- **ALT-002**: Add distillation as client-side convention only. Not chosen because roadmap requires first-class server tooling and provenance links.
- **ALT-003**: Replace single-file architecture with full module split first. Not chosen because sequencing risk is high before telemetry baseline is established.
- **ALT-004**: Lock distillation to emotional_processing only. Not chosen because risk and operational memories in vigilant_monitoring and practical_execution also benefit from structured distillation.

## 4. Dependencies

- **DEP-001**: Existing MCP SDK handlers in src/index.ts must remain functional during incremental refactor.
- **DEP-002**: Node runtime/tooling from package.json and tsconfig.json must continue compiling with no ESM contract break.
- **DEP-003**: Existing persisted snapshots at ~/.neurodivergent-memory/memories.json must be readable after WAL introduction.
- **DEP-004**: Existing test harness scripts (test-memory-graph.ps1, test-memory-graph.ts) must be adapted only where output text changes.
- **DEP-005**: FractalSemantics reference model for district metadata and LUCA lineage is read from development-artifacts/fractalsemantics/fractalsemantics/*.py and not imported at runtime.

## 5. Files

- **FILE-001**: src/index.ts — primary integration point for schemas, handlers, telemetry, retrieval blending, and tool registration.
- **FILE-002**: src/core/types.ts — new shared domain types for agent_id, distillation, telemetry.
- **FILE-003**: src/core/error-codes.ts — stable error taxonomy + response formatter.
- **FILE-004**: src/core/logger.ts — structured logging abstraction.
- **FILE-005**: src/core/distillation.ts — distillation extractor and artifact builder.
- **FILE-006**: src/core/district-registry.ts — custom district + LUCA parent validation.
- **FILE-007**: tests/distillation.spec.ts — distillation behavior tests.
- **FILE-008**: tests/retrieval-context.spec.ts — context/recency retrieval blend tests.
- **FILE-009**: tests/telemetry-loop.spec.ts — repetition and ping-pong telemetry tests.
- **FILE-010**: tests/benchmarks/memory-benchmark.ts — deterministic perf baseline runner.
- **FILE-011**: README.md — user-facing tool and parameter docs.
- **FILE-012**: CHANGELOG.md — release notes and migration notes.

## 6. Testing

- **TEST-001**: Unit test WAL replay and compaction: crash mid-write should recover deterministic memory count.
- **TEST-002**: Unit test write mutex/queue: concurrent writes preserve ordering and no dropped records.
- **TEST-003**: Unit test telemetry: repeated write/read thresholds increment expected counters.
- **TEST-004**: Unit test distill_memory: output has all required keys and abstracted_from points to source memory id.
- **TEST-005**: Unit test context + recency blend: ranking changes predictably with recency_weight=0 vs recency_weight=1.
- **TEST-006**: Unit test custom district registration: parent must resolve to canonical chain rooted in LUCA.
- **TEST-007**: Integration test store/retrieve/update/search/traverse/related/memory_stats regression parity.
- **TEST-008**: Benchmark test outputs persisted and compared against baseline threshold gates.

## 7. Risks & Assumptions

- **RISK-001**: WAL introduction can create subtle corruption if compaction and replay ordering diverge.
- **RISK-002**: Recency blending may degrade expected BM25 ranking if normalization is not bounded.
- **RISK-003**: Guardrail messaging may break external parsers relying on exact response strings.
- **RISK-004**: Custom district registration can fragment taxonomy if parent validation is weak.
- **RISK-005**: Cross-district distillation can over-normalize content if policy thresholds are too permissive.
- **RISK-005**: Cross-district distillation can over-normalize content if policy thresholds are too permissive.
- **RISK-006**: Stored plans may be treated as authoritative by future agent sessions even after superseding decisions are made. Mitigation: `epistemic_status` transitions (REQ-010, GUD-003) and the loop telemetry ping-pong detector (TASK-008) both surface stale plan reuse. (Source: council synthesis 2026-03-29.)
- **ASSUMPTION-001**: Existing clients tolerate additive output fields in tool responses.
- **ASSUMPTION-002**: Versioned release cadence allows v0.2.0 and v0.3.0 as separate hardening checkpoints.
- **ASSUMPTION-003**: Warbler remains untracked reference material under ignored development-artifacts path.

## 8. Related Specifications / Further Reading

- Roadmap: ../Roadmap_0_1_8_push_to_1_0_0.md
- Current server implementation: ../src/index.ts
- Warbler reference (ignored, read-only): ../development-artifacts/Warbler-CDA/README.md
- Warbler conflict patterns: ../development-artifacts/Warbler-CDA/warbler_cda/conflict_detector.py
- Warbler distillation patterns: ../development-artifacts/Warbler-CDA/warbler_cda/summarization_ladder.py
- Warbler retrieval patterns: ../development-artifacts/Warbler-CDA/warbler_cda/retrieval_api.py
- FractalSemantics dynamic enum reference: ../development-artifacts/fractalsemantics/fractalsemantics/dynamic_enum.py
- FractalSemantics coordinates reference: ../development-artifacts/fractalsemantics/fractalsemantics/coordinates_adapter.py
