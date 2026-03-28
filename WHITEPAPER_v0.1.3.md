# Neurodivergent Memory MCP Server
## Research Preview White Paper (v0.1.3)

Date: 2026-03-28  
Version: 0.1.3  
Status: Research Preview (pre-1.0)

Author: Jerimiah Meyer (Jerry)

## Founder Note

This project is my brain-child. The goal is straightforward: build a memory system that supports neurodivergent, non-linear cognition while still meeting engineering standards for agent tooling, release discipline, and supply-chain trust.

## Executive Summary

Neurodivergent Memory MCP Server is a research-preview memory platform for agent workflows. It combines district-based memory organization, graph relationships, canonical metadata tags, and ranked retrieval.

Release 0.1.3 is the first fully successful multi-channel release in this project lifecycle, including npm, GitHub release artifacts, Docker Hub, and GHCR. This document records design intent, measured release outcomes, operational lessons, and the production-readiness gap to 1.0.0.

## Problem Statement

Most generic memory stores are not designed for:

- non-linear recall patterns,
- explicit context partitioning,
- associative graph traversal,
- and repeatable operational release delivery.

This project addresses those gaps with a district-aware graph model, canonical tag schema, BM25 retrieval, and hardened release automation.

## Architecture Summary

### District Model

Memories are stored in five cognitive districts:

- logical_analysis
- emotional_processing
- practical_execution
- vigilant_monitoring
- creative_synthesis

The district model provides intentional context boundaries while still allowing cross-district graph connections.

### Canonical Tag Schema

Memories use structured tags in four namespaces:

- topic:X
- scope:X
- kind:X
- layer:X

This schema improves consistency, discoverability, and retrieval quality across human and agent-authored entries.

### Retrieval and Graph Operations

The system provides:

- BM25-ranked lexical retrieval,
- relationship-aware graph traversal,
- and state/health inspection through memory statistics.

## Release 0.1.3 Outcomes

### Delivery Channels Completed

Release 0.1.3 completed publication across:

- npm package registry,
- GitHub release assets,
- Docker Hub container registry,
- and GitHub Container Registry (GHCR).

### Supply-Chain and Integrity Controls

Release automation includes:

- provenance-aware npm publishing,
- package and container attestations,
- checksum generation,
- and multi-architecture container builds.

### Operational Lessons Incorporated

The release process surfaced and resolved key issues:

- npm immutability behavior on reruns,
- 2FA/EOTP behavior in automation contexts,
- main/release branch synchronization gaps,
- and package visibility mismatch when GHCR was not included.

Workflow hardening now includes:

- automatic release-branch sync on version tags,
- rerun-safe npm publish skip when version already exists,
- and GHCR publication with required permissions for GitHub Packages visibility.

## Agentic Value Assessment

### Current Value

The platform is strong for:

- single-agent memory workflows,
- structured reflection and recall,
- and early-stage multi-agent experiments.

### Current Constraints

The project remains pre-1.0 and is not yet suitable for high-criticality production workloads due to current gaps in:

- concurrency control,
- durability and recovery guarantees,
- observability and operations telemetry,
- and orchestration-native control surfaces.

## Multi-Agent Roadmap Direction

Roadmap intent includes support for council-style and Kanban-like agent orchestration, where multiple CLI agents coordinate through shared memory and explicit lifecycle semantics.

Planned capabilities:

- lifecycle hooks for memory events,
- conflict-aware write and merge patterns,
- goal-aware retrieval and ranking,
- and reference orchestration patterns for parallel agent execution.

## Readiness Position

Release 0.1.3 should be interpreted as:

- ready for research and controlled pilot use,
- not yet ready for production-scale, multi-tenant deployment.

This position is intentional and consistent with semantic-versioning expectations for 0.x software.

## Milestones to 1.0.0

### Near-Term (0.2.x)

- structured logs and actionable error taxonomy,
- write serialization and crash-recovery strategy,
- and documented scale/performance envelope.

### Mid-Term (0.3.x-0.4.x)

- lifecycle hooks and memory-event semantics,
- orchestration-aware retrieval strategies,
- and council/kanban multi-agent reference implementations.

### Production Gate (1.0.0)

- durability and consistency guarantees,
- stable API contract with migration guidance,
- and validated operational runbooks.

## Publication Strategy

Best-practice placement:

- keep this full white paper in-repo as the canonical, versioned technical record,
- publish a shorter external narrative that links to this document.

This preserves a single engineering source of truth while improving discoverability.

## Evidence and References

Primary supporting materials:

- README
- CHANGELOG
- EXPERIMENT_REPORT
- SMOKE_TEST_REPORT
- SECURITY
- .github/workflows/release.yml

## Disclaimer

This document describes a research-preview release and does not constitute a production SLA, compliance certification, or formal security guarantee.
