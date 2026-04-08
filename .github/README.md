# nd-memory Agent Kit

This directory is a reusable, project-agnostic customization pack for memory-driven development with the neurodivergent-memory MCP server.

## Contents

| File | Purpose |
|---|---|
| `templates/neurodivergent-agent.agent.md` | Full-featured Memory-Driven Development Coordinator agent. Five-phase workflow: pull context → research → improve memories → plan → act & hand off, with explicit capture of the why behind decisions. |
| `templates/memory-driven-template.agent.md` | Minimal generic agent template — a lighter starting point for custom workflows. |
| `templates/nd-memory-workflow.instructions.md` | Shared instruction file that reinforces memory-driven habits in day-to-day coding sessions, including rationale-first memory capture. |
| `templates/setup-nd-memory.prompt.md` | Guided setup prompt that asks the user to choose an install policy before anything is installed. |
| `templates/copilot-instructions.md` | Bootstrap reference for GitHub Copilot sessions — tag schema, district table, tool quick-reference, session checklist, and memory-quality guardrails for recording why. |
| `templates/explore_memory_city.prompt.md` | Prompt for guided exploration of memory districts and graph structure. |
| `templates/memory-driven-issue-execution.prompt.md` | Prompt for executing a tracked issue with full memory-driven context (pull → plan → act → update), including durable reasoning capture. |

## Recommended Install Path

For packaged releases, prefer the installer command instead of manually copying from `node_modules`:

```bash
npx neurodivergent-memory@latest init-agent-kit
```

This copies the packaged templates into the target repository's `.github/...` locations. Use `--dry-run` to preview and `--force` to overwrite existing files.

The authoring source in this repository stays under `.github/agent-kit/templates/`. The live destination `.github/agents/neurodivergent-agent.agent.md` should be treated as generated consumer state, not as a tracked source file.

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
5. Preserve the rationale-first rule: imported workflows should capture what changed, why it changed, and any durable principle worth linking or distilling.
