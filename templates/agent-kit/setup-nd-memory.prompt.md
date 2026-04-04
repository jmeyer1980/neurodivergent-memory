---
name: setup-nd-memory

description: Set up memory-driven project customizations from the nd-memory agent kit and confirm install policy.
argument-hint: Optional target agent name and any project-specific constraints
agent: agent
---

Import and configure memory-driven customizations for the current project.

Inputs:
- {{input}}: Optional target agent name and constraints.

Execution steps:

1. Copy templates from `.github/agent-kit/templates/` into project customization locations:
- Agent template -> `.github/agents/<target-name>.agent.md`
- Instructions template -> `.github/instructions/nd-memory-workflow.instructions.md`
- Prompt template (this file) -> `.github/prompts/setup-nd-memory.prompt.md`

2. Ask the user which installation policy to use for neurodivergent-memory MCP:
- `prompt-first`
- `auto-setup`

3. If no policy is specified, default to `prompt-first`.

4. Update the imported agent and instructions files to reflect the selected policy.

5. Confirm final file paths and summarize exactly what was imported and configured.

Rules:
- Do not silently install neurodivergent-memory MCP without a confirmed `auto-setup` policy.
- Keep all imported customization files project-agnostic unless the user requests specialization.
