# nd-memory Agent Kit

This directory is a reusable, project-agnostic customization pack for memory-driven development with the neurodivergent-memory MCP server.

## Contents

| File | Purpose |
|---|---|
| `templates/neurodivergent-agent.agent.md` | Full-featured Memory-Driven Development Coordinator agent. Five-phase workflow: pull context → research → improve memories → plan → act & hand off. |
| `templates/memory-driven-template.agent.md` | Minimal generic agent template — a lighter starting point for custom workflows. |
| `templates/nd-memory-workflow.instructions.md` | Shared instruction file that reinforces memory-driven habits in day-to-day coding sessions. |
| `templates/setup-nd-memory.prompt.md` | Guided setup prompt that asks the user to choose an install policy before anything is installed. |
| `templates/copilot-instructions.md` | Bootstrap reference for GitHub Copilot sessions — tag schema, district table, tool quick-reference, and session checklist. |
| `templates/explore_memory_city.prompt.md` | Prompt for guided exploration of memory districts and graph structure. |
| `templates/memory-driven-issue-execution.prompt.md` | Prompt for executing a tracked issue with full memory-driven context (pull → plan → act → update). |

## Import Targets

**Copy** (do not move) these templates into your project's standard customization locations. The right directories vary by agent platform — use whatever location your agent natively reads from. Common examples:

- Agent definitions: `.github/agents/<your-agent-name>.agent.md`
- Shared instructions: `.github/instructions/nd-memory-workflow.instructions.md`
- Prompts: `.github/prompts/<prompt-name>.prompt.md`
- Copilot bootstrap: `.github/copilot-instructions.md`

## Required Setup Handshake

Before installing neurodivergent-memory MCP in a project, ask the user which policy to use:

- `prompt-first`: Ask before install.
- `auto-setup`: Install automatically.

If no preference is stated, default to `prompt-first`.

## Guidance For Future Agents

When asked to add memory-driven workflow support to a project:

1. Import these templates into the project's `.github/` directories.
2. Ask the user to confirm `prompt-first` or `auto-setup`.
3. Update the imported agent file's installation section to match the user's choice.
4. Keep all other workflow behavior project- and language-agnostic.
