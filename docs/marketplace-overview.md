# neurodivergent-memory

`neurodivergent-memory` is a Model Context Protocol (MCP) server that stores and retrieves memories as a persistent graph designed for neurodivergent thinking patterns.

## What it provides

- Five memory districts for structured, emotional, practical, vigilant, and creative thought capture.
- BM25 ranking for semantic retrieval without embedding dependencies.
- Persistent graph storage with WAL-backed recovery.
- Tools for storing, retrieving, connecting, searching, traversing, and distilling memory nodes.

## Typical use

Use this package with MCP-capable clients and agents that need long-lived context across sessions and projects.

The repository also ships a thin VS Code companion extension that helps users configure the MCP server quickly.
The extension does not replace the MCP runtime; it provides setup-oriented commands and marketplace discoverability.

Quick start:

```bash
npx neurodivergent-memory@latest init-agent-kit
```

VS Code companion commands:

- `Neurodivergent Memory: Copy MCP Config`
- `Neurodivergent Memory: Open Setup Docs`

## Repository and docs

- Source: <https://github.com/jmeyer1980/neurodivergent-memory>
- README: <https://github.com/jmeyer1980/neurodivergent-memory/blob/main/README.md>
- License: MIT
