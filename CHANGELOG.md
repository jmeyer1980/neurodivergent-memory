# Changelog

## [0.1.1] - 2026-03-28

### ⚠️ Research Preview Release

This is a **research preview release**. We are actively developing core features and stability improvements toward 1.0.0. Expect API changes, feature additions, and potential breaking changes in minor version updates during the 0.x series.

### Added

- **Core MCP Server**: Knowledge graph storage and retrieval via Model Context Protocol stdio transport
- **5-District Architecture**: Semantic organization across logical_analysis, emotional_processing, practical_execution, vigilant_monitoring, and creative_synthesis domains
- **BM25 Full-Text Search**: Relevance-ranked memory retrieval with configurable scoring and filtering
- **Graph Connections**: Bidirectional edges between memory nodes for associative traversal
- **Canonical Tag Schema**: Enforced tagging (topic, scope, kind, layer) for structured knowledge organization
- **Persistence**: JSON-based durable storage at `~/.neurodivergent-memory/memories.json`
- **Tools**: store_memory, retrieve_memory, search_memories, delete_memory, connect_memories, traverse_from, related_to, list_memories, memory_stats, import_memories
- **Docker Support**: Multi-platform container images (amd64, arm64) with provenance and SBOM attestation
- **Security**: npm provenance publishing, container attestation, checksums on release artifacts

### Fixed

- Test script hang prevention: Added adaptive timeout and completion detection to prevent indefinite stdin blocking

### Known Limitations

- **Single-file persistence**: No Journal/WAL pattern; risk of data loss on unclean shutdown
- **No concurrency control**: Unsafe for simultaneous writes from multiple agents
- **Static districts**: Cannot adapt semantic organization per use case
- **Basic query language**: BM25 ranking ignores agent goals or context
- **No observability**: No logging, metrics, or debug endpoints
- **No resource controls**: Unbounded memory growth potential

### Roadmap to 1.0.0

**v0.2.0 (Stability & Observability)**
- Structured logging with error codes and recovery paths
- Concurrent write safety (mutex + journal pattern)
- Resource quotas and performance monitoring
- Load testing & scaling characteristics documentation

**v0.3.0 (Agent Lifecycle)**
- Agent lifecycle hooks (on_memory_created, on_connection_added, etc.)
- Agent goal context integration (personalized relevance ranking)
- Dynamic district creation for adaptive taxonomies

**v0.4.0 (Multi-Agent Orchestration)**
- Council-style agentic workflows: Multiple CLI agents coordinated by orchestrator
- Kanban orchestration: Task distribution and state tracking across agent workers
- Inter-agent knowledge sharing patterns
- Concurrency & contention resolution

**v1.0.0 (Production Ready)**
- Sub-second search performance at 100k+ memories
- Durable persistence guarantees (ACID for updates)
- Multi-tenant isolation
- Full coverage of agentic orchestration patterns
- Stable API contract with versioning strategy

### Getting Started

See [README.md](README.md) for installation and usage. This is suitable for:
- Single-agent memory prototyping
- Proof-of-concept knowledge graphs
- Research into district-based semantic organization

Not recommended for:
- Multi-agent production systems
- Mission-critical knowledge storage
- High-volume scenarios (recommend testing at your scale first)

### Contributors

- jmeyer1980

---

For detailed technical assessment, see [EXPERIMENT_REPORT.md](EXPERIMENT_REPORT.md) and [SMOKE_TEST_REPORT.md](SMOKE_TEST_REPORT.md).
