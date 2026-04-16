# Changelog

## [Unreleased]

## [0.3.4] - 2026-04-15

This patch release resolves Docker Hub immutable-tag push failures on release reruns and overlapping branch/tag workflows.

### Fixed

- Removed `type=sha` Docker metadata tags from `ci`, `rc_release`, and `release` jobs so workflows no longer attempt to push immutable `sha-<commit>` tags that may already exist
- Preserved existing versioned/raw release tags while preventing Docker Hub collisions such as `sha-f97f62f` already assigned errors

## [0.3.3] - 2026-04-15

This patch release hardens Marketplace publish behavior so release artifacts continue even when `tfx` validation status polling is unstable.

### Fixed

- Marketplace publish now uses `--no-wait-validation` to avoid the `tfx` validation wait-path crash (`Cannot read properties of null (reading 'versions')`)
- Marketplace publish failures are now non-blocking warnings so npm, Docker, and GitHub release asset publication continue

## [0.3.2] - 2026-04-15

This patch release fixes release workflow failures observed on the initial `v0.3.1` run.

### Fixed

- Corrected `tfx-cli` invocation in GitHub Actions from `npm exec --yes tfx-cli ...` to `npm exec --yes -- tfx-cli ...`, preventing npm from swallowing `--manifest-globs` / `--output-path` and causing `Command 'vss-extension.json' not found`
- Updated `sync_release_with_main` guardrail to skip (exit `0`) instead of fail when a tag commit is not on `main`, so expected non-main tag flows do not mark the run as failed

## [0.3.1] - 2026-04-15

This patch release adds first-class Azure DevOps / Visual Studio Marketplace distribution support to the release pipeline.

### Marketplace

- `vss-extension.json` manifest and Marketplace overview content at `docs/marketplace-overview.md` so VSIX packaging has explicit source assets
- Optional tagged-release Marketplace publish path using `tfx-cli`, gated by manifest presence and `AZURE_DEVOPS_MARKETPLACE_TOKEN`
- GitHub tagged releases now attach generated `.vsix` artifacts when present

### Release Workflow

- Release workflow now synchronizes `vss-extension.json` version from `package.json` during the packaging step to keep extension and package versions aligned
- Generated `.vsix` artifacts are ignored via `.gitignore` to prevent accidental binary commits

### Added

- Goal-aware retrieval tuning for `search_memories` and `related_to` via optional `context` scoring, plus `recency_weight` support on `search_memories`
- Preferred `min_intensity` / `max_intensity` filter names for `search_memories` while preserving backward-compatible `intensity_min` / `intensity_max` aliases
- Epistemic-status consistency improvements: new `practical_execution` task memories default to `draft` when no explicit status is supplied, and `related_to` / `list_memories` now accept optional `epistemic_statuses` filters alongside `search_memories`
- Explicit runtime version confirmation via new `server_handshake` tool, plus MCP server metadata now sourced from package runtime version instead of a stale hardcoded value
- `synthesize_memory_packets` prompt for attachment-constrained clients, emitting one coverage manifest plus bounded structured memory slices that summarize the full graph while preserving memory-id traceability
- Active loop guardrails on top of existing telemetry: `No net-new info` warnings for repeated stores, `distill_memory` suggestions after repeated logical reads of emotional memories, and optional cross-district cooldown enforcement via `NEURODIVERGENT_MEMORY_DISTILL_SUGGEST_THRESHOLD` and `NEURODIVERGENT_MEMORY_CROSS_DISTRICT_COOLDOWN_MS` (`NM_E012`)
- Tool mirrors for prompt-derived context (`prepare_memory_city_context`, `prepare_synthesis_context`, and `prepare_packetized_synthesis_context`) so prompt content remains accessible in MCP clients that support tools but not prompts
- Richer prompt descriptors with explicit empty `arguments` arrays to improve compatibility with stricter MCP prompt clients
- Project ID filters and storage are now case-insensitive. All project_id values are normalized to lower case for matching and storage, preventing false zero-memory results due to casing mismatches.
- When a project_id query returns zero results, the server suggests a near-miss project_id (Levenshtein distance ≤ 2) as a did_you_mean assist in the response, improving recovery from typos and casing errors.
- All project_id validation, import, and update operations are covered by tests for mixed-case and near-miss scenarios.

## [0.2.0] - 2026-04-01

### Added

- Write-ahead journal persistence (`memories.json.wal.jsonl`) for mutating operations with startup replay and compaction into `memories.json`
- Startup recovery telemetry indicating whether boot path was `fresh`, `snapshot-load`, or `wal-replay`
- Configurable memory cap and eviction policies via:
  - `NEURODIVERGENT_MEMORY_MAX`
  - `NEURODIVERGENT_MEMORY_EVICTION` (`lru`, `access_frequency`, `district_priority`)
- Structured MCP error helpers with stable `Code` / `Message` / `Recovery` text blocks for tool failures
- Structured Pino info logging for write-path operations (`store`, `update`, `delete`, `connect`, `import`)
- Async write serialization via mutex to prevent concurrent mutation races under multi-agent load
- Bounded mutating write queue with backpressure signaling (`NEURODIVERGENT_MEMORY_QUEUE_DEPTH`, `NM_E010`)
- WIP saturation guardrail warning for in-progress practical tasks (`NEURODIVERGENT_MEMORY_WIP_LIMIT`, `NM_E011`)
- Development branch release-candidate pipeline that publishes the same npm package name as prereleases (`0.x.x-rc.N`, dist-tag `rc`, where `N=run_number.run_attempt`) and pushes immutable per-run Docker tags `rc-0.x.x-rc.N` derived from the same run sequence
- Observe-only loop telemetry for `store_memory`, `retrieve_memory`, `update_memory`, and `memory_stats` with repeat counters, ping-pong detection, and recent high-similarity write reporting (`NEURODIVERGENT_MEMORY_REPEAT_THRESHOLD`, `NEURODIVERGENT_MEMORY_LOOP_WINDOW`, `NEURODIVERGENT_MEMORY_PING_PONG_THRESHOLD`)
- Deterministic MCP stdio benchmark harness at `benchmarks/memory-benchmark.mjs` with published 1k/5k/10k baseline outputs in `benchmark-results/`, including 100-write throughput samples and `traverse_from` depth latency coverage
- Optional first-class `project_id` support for memory attribution and scoped retrieval across `store_memory`, `update_memory`, `import_memories`, `search_memories`, `list_memories`, and `memory_stats` (including per-project stats breakdown)
- `list_memories` output lines now include a `project: ...` segment (`unset` when no project attribution exists)

### ⚠️ Breaking Change

- **`/root/.neurodivergent-memory` mounts no longer found automatically.** The image runs as the `node` user which cannot read `/root`. Configs that previously mounted data at `/root/.neurodivergent-memory` will silently start empty. Migrate by re-mounting the same host volume at `/data` (with `NEURODIVERGENT_MEMORY_DIR=/data`) or at `/home/node/.neurodivergent-memory`. See the README for full recovery instructions.

### Fixed

- Persistence path resolution now honors explicit env overrides (`NEURODIVERGENT_MEMORY_DIR`, `NEURODIVERGENT_MEMORY_FILE`) and automatically reuses existing snapshots from the `node` user home directory, preventing empty-memory startups when container home paths differ
- Docker named volume at `/data` is now pre-created with `node` ownership in the image, preventing EACCES errors when no bind-mount ownership is set
- Docker examples updated to use explicit `/data` data directory and document per-project isolation with cross-platform path guidance
- Tool handlers now normalize known failures to the NM_E taxonomy instead of returning inconsistent plain-text error messages
- RC container publish now emits immutable per-run tags only (`rc-0.x.x-rc.N`) to avoid Docker Hub immutability failures when updating floating base tags

### Documentation

- Published first local benchmark baseline in `TEST_SUMMARY.md` and `benchmark-results/memory-benchmark-baseline.md` for 1k/5k/10k memory datasets
- Updated roadmap and architecture planning documents to reflect v0.2.0 progress status (persistence, concurrency safety, structured logging, loop telemetry, and benchmark baseline complete)

### ⚠️ Research Preview Releases

## [0.1.8] - 2026-03-28

This patch release forces Docker Hub README refresh on each release and upgrades Node to 24.

### Fixed

- Added `peter-evans/dockerhub-description@v4` step in the release workflow so Docker Hub description is always updated from `README.md`
- Added `workflow_dispatch` to allow manual README refresh runs when needed

### Security

- Upgraded workflow Node runtime from 20 to 24
- Upgraded Docker build/runtime base images from `node:20-alpine` to `node:24-alpine`

## [0.1.7] - 2026-03-28

This patch release fixes README GIF and link rendering on Docker Hub and GHCR.

### Fixed

- Replaced relative GIF paths with absolute `raw.githubusercontent.com` URLs so Docker Hub and GHCR can render the preview image and link correctly

## [0.1.6] - 2026-03-28

This patch release disables Docker `latest` tag generation to comply with immutable tag settings.

### Fixed

- Release workflow now sets Docker metadata `flavor.latest=false` to avoid pushing immutable `latest`
- Prevents Docker Hub publish failures caused by immutable floating tags

## [0.1.5] - 2026-03-28

This patch release fixes Docker Hub immutable tag conflict and publishes to the official MCP Registry.

### Added

- Added `mcpName` field to `package.json` required for MCP Registry namespace verification (`io.github.jmeyer1980/neurodivergent-memory`)
- Added `server.json` for publishing to the official MCP Registry at `registry.modelcontextprotocol.io`

## [0.1.3] - 2026-03-28

This patch release improves package visibility in GitHub by publishing container images to GitHub Container Registry (GHCR) in addition to Docker Hub.

### Fixed

- Release workflow now publishes container images to `ghcr.io/jmeyer1980/neurodivergent-memory`
- Added `packages: write` workflow permissions required for GHCR publishing
- GitHub Packages listing now available through GHCR package pages linked to this repository

## [0.1.2] - 2026-03-28

This patch release focuses on release pipeline reliability and publish resiliency.

### Fixed

- Release workflow now syncs `release` with `main` on version tag pushes
- Release workflow now skips npm publish when the version already exists on npm (rerun-safe)
- Continued hardening for GitHub Actions JavaScript runtime migration to Node 24

## [0.1.1] - 2026-03-28

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

#### **v0.2.0 (Stability & Observability)**

- Structured logging with error codes and recovery paths
- Concurrent write safety (mutex + journal pattern)
- Resource quotas and performance monitoring
- Load testing & scaling characteristics documentation

#### **v0.3.0 (Agent Lifecycle)**

- Agent lifecycle hooks (on_memory_created, on_connection_added, etc.)
- Agent goal context integration (personalized relevance ranking)
- Dynamic district creation for adaptive taxonomies

#### **v0.4.0 (Multi-Agent Orchestration)**

- Council-style agentic workflows: Multiple CLI agents coordinated by orchestrator
- Kanban orchestration: Task distribution and state tracking across agent workers
- Inter-agent knowledge sharing patterns
- Concurrency & contention resolution

#### **v1.0.0 (Production Ready)**

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
