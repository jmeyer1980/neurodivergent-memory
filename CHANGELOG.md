# Changelog

## [Unreleased]

### Added

- Write-ahead journal persistence (`memories.json.wal.jsonl`) for mutating operations with startup replay and compaction into `memories.json`
- Startup recovery telemetry indicating whether boot path was `fresh`, `snapshot-load`, or `wal-replay`
- Configurable memory cap and eviction policies via:
  - `NEURODIVERGENT_MEMORY_MAX`
  - `NEURODIVERGENT_MEMORY_EVICTION` (`lru`, `access_frequency`, `district_priority`)
- Structured MCP error helpers with stable `Code` / `Message` / `Recovery` text blocks for tool failures
- Structured Pino info logging for write-path operations (`store`, `update`, `delete`, `connect`, `import`)

### ⚠️ Breaking Change

- **`/root/.neurodivergent-memory` mounts no longer found automatically.** The image runs as the `node` user which cannot read `/root`. Configs that previously mounted data at `/root/.neurodivergent-memory` will silently start empty. Migrate by re-mounting the same host volume at `/data` (with `NEURODIVERGENT_MEMORY_DIR=/data`) or at `/home/node/.neurodivergent-memory`. See the README for full recovery instructions.

### Fixed

- Persistence path resolution now honors explicit env overrides (`NEURODIVERGENT_MEMORY_DIR`, `NEURODIVERGENT_MEMORY_FILE`) and automatically reuses existing snapshots from the `node` user home directory, preventing empty-memory startups when container home paths differ
- Docker named volume at `/data` is now pre-created with `node` ownership in the image, preventing EACCES errors when no bind-mount ownership is set
- Docker examples updated to use explicit `/data` data directory and document per-project isolation with cross-platform path guidance
- Tool handlers now normalize known failures to the NM_E taxonomy instead of returning inconsistent plain-text error messages

## [0.1.8] - 2026-03-28

### ⚠️ Research Preview Release

This patch release forces Docker Hub README refresh on each release and upgrades Node to 24.

### Fixed

- Added `peter-evans/dockerhub-description@v4` step in the release workflow so Docker Hub description is always updated from `README.md`
- Added `workflow_dispatch` to allow manual README refresh runs when needed

### Security

- Upgraded workflow Node runtime from 20 to 24
- Upgraded Docker build/runtime base images from `node:20-alpine` to `node:24-alpine`

## [0.1.7] - 2026-03-28

### ⚠️ Research Preview Release

This patch release fixes README GIF and link rendering on Docker Hub and GHCR.

### Fixed

- Replaced relative GIF paths with absolute `raw.githubusercontent.com` URLs so Docker Hub and GHCR can render the preview image and link correctly

## [0.1.6] - 2026-03-28

### ⚠️ Research Preview Release

This patch release disables Docker `latest` tag generation to comply with immutable tag settings.

### Fixed

- Release workflow now sets Docker metadata `flavor.latest=false` to avoid pushing immutable `latest`
- Prevents Docker Hub publish failures caused by immutable floating tags

## [0.1.5] - 2026-03-28

### ⚠️ Research Preview Release

This patch release fixes Docker Hub immutable tag conflict and publishes to the official MCP Registry.

### Added

- Added `mcpName` field to `package.json` required for MCP Registry namespace verification (`io.github.jmeyer1980/neurodivergent-memory`)
- Added `server.json` for publishing to the official MCP Registry at `registry.modelcontextprotocol.io`

## [0.1.3] - 2026-03-28

### ⚠️ Research Preview Release

This patch release improves package visibility in GitHub by publishing container images to GitHub Container Registry (GHCR) in addition to Docker Hub.

### Fixed

- Release workflow now publishes container images to `ghcr.io/jmeyer1980/neurodivergent-memory`
- Added `packages: write` workflow permissions required for GHCR publishing
- GitHub Packages listing now available through GHCR package pages linked to this repository

## [0.1.2] - 2026-03-28

### ⚠️ Research Preview Release

This patch release focuses on release pipeline reliability and publish resiliency.

### Fixed

- Release workflow now syncs `release` with `main` on version tag pushes
- Release workflow now skips npm publish when the version already exists on npm (rerun-safe)
- Continued hardening for GitHub Actions JavaScript runtime migration to Node 24

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
