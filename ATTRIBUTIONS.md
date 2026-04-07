# Attributions

This file records the third-party standards, research, and runtime libraries
that are explicitly used or referenced by neurodivergent-memory.

It intentionally does not treat internal design-history artifacts as third-party
citations. FractalStat, FractalSemantics, Warbler-CDA, the seed, and related
project-lore references are part of the project's internal lineage and are not
listed here as external attributions.

## Project release context

- Initial public preview release: 0.1.1 on 2026-03-28
- Current cited release in [CITATION.cff](CITATION.cff): 0.3.0 on 2026-04-03

## Standards and research

### Model Context Protocol

- Organization: Anthropic PBC and the MCP ecosystem contributors
- Role in this project:
  - Defines the protocol surface for tools, resources, prompts, and stdio
    transport
  - Provides the registry schema and ecosystem conventions referenced by this
    repository
- Official resources:
  - [modelcontextprotocol.io](https://modelcontextprotocol.io/)
  - [github.com/modelcontextprotocol](https://github.com/modelcontextprotocol)

### Okapi BM25

- Reference:
  - Stephen E. Robertson and Hugo Zaragoza. "The Probabilistic Relevance
    Framework: BM25 and Beyond." Foundations and Trends in Information
    Retrieval 3, no. 4 (2009): 333-389.
- Role in this project:
  - The server's lexical retrieval and ranking model is based on Okapi BM25
  - Repository documentation describes the implementation with k1=1.5 and
    b=0.75

## Direct runtime dependencies

### @modelcontextprotocol/sdk

- Package: `@modelcontextprotocol/sdk`
- Role in this project:
  - TypeScript SDK used to implement the MCP server, tool handlers, resources,
    prompts, and stdio transport
- Source:
  - [npmjs.com/package/@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk)

### Pino

- Package: `pino`
- Role in this project:
  - Structured write-path logging and operational diagnostics
- Source:
  - [npmjs.com/package/pino](https://www.npmjs.com/package/pino)

## Scope note

This file is intentionally curated rather than exhaustive. For the complete
software supply chain, including transitive packages, see
[package.json](package.json) and [package-lock.json](package-lock.json).
