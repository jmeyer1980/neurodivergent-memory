---
name: Memory-Driven Issue Execution
description: Use when working through GitHub issues with neurodivergent-memory MCP memory logging, implementation, self-review, and PR creation.
argument-hint: GitHub issues URL/search scope and any priority constraints
agent: neurodivergent-agent
---
You are working in the currently open repository.

Inputs:
- {{input}}: A GitHub issues URL, issue query, or issue list scope (for example: https://github.com/jmeyer1980/neurodivergent-memory/issues).

Goal:
Select one actionable issue and complete it end-to-end using the neurodivergent-memory MCP tools for continuous memory capture.

Workflow (execute in order):
1. Discover context:
- Open the provided issues URL/scope.
- Start with `memory_stats`, then use `search_memories` or equivalent retrieval to find relevant context.
- Read relevant memories before choosing work.

2. Choose issue:
- Pick one issue that is open, implementable, and high-value.
- Prioritize by highest impact first.
- If the highest-impact candidate appears breaking, risky, or architecture-shifting, stop and ask the user for guidance before implementation.
- Briefly justify why this issue was selected.

3. Research and plan:
- Inspect the codebase and related files.
- Create a concise implementation plan.
- Before substantial execution, create or update an MCP-backed plan memory on the active task thread.
- If you create a new plan or task-thread node, connect it with `connect_memories`.
- Prefer `update_memory` when continuing an active slice instead of creating duplicate high-similarity task logs.
- Store your reasoning, plan, assumptions, and the durable principle behind the work as memories throughout the process.

4. Implement:
- Make the required code changes.
- Keep storing progress notes and decisions on the same active task thread while working.
- Do not leave execution-only logs; each substantial implementation memory should explain why the change exists or connect to a reasoning memory that does.
- Do not treat repo-local notes, scratch docs, or TODO files as substitutes for MCP plan, progress, validation, or handoff writes.
- If sub-agents are available and the work is bounded, delegate deliberately scoped tasks such as issue scanning, repo exploration, focused validation, or self-review. If sub-agents are unavailable or not worth the overhead, continue locally.
- Run available validation (tests/lint/build) relevant to the change.

5. Self-review:
- Review your own diff for correctness, regressions, and style consistency.
- If issues are found, fix them before proceeding.
- Record validation results on the active task thread before concluding.

6. Finalize:
- Create a draft pull request first with a concise summary, testing notes, and issue linkage.
- Complete self-review and any follow-up fixes.
- If the result is clean, commit with a clear message and transition the pull request to ready for review.
- Request GitHub Copilot review on the PR.
- Before ending, write a handoff memory that summarizes what was completed, what remains (if anything), and immediate next actions.
- If the work produced a reusable insight, store or update a `logical_analysis` or `creative_synthesis` memory that states the principle explicitly.

Output format:
- Selected issue: <link + short rationale>
- Plan: <numbered steps>
- Changes made: <files + key edits>
- Validation: <commands + results>
- Self-review findings: <none or list>
- Commit: <hash + message>
- PR: <link>
- Copilot review: <requested/pending/result>
- Memory summary: <what was stored, why, and which durable principle or synthesis was captured>

Rules:
- Use the neurodivergent-memory MCP server continuously for memories (decisions, progress, blockers, outcomes).
- Favor connective synthesis over raw task logging: link implementation memories back to reusable reasoning whenever possible.
- Use `connect_memories` for new plan or task-thread nodes and prefer `update_memory` when continuing an existing slice.
- Include a final handoff memory at the end of the run.
- Do not claim completion if tests fail or required checks are not run.
- If blocked by permissions (push/PR/review), report the blocker and provide exact next commands/actions.
