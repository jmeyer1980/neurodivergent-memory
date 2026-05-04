---
name: address-pr-comments
description: "Address review comments (including Copilot comments) on the active pull request using rationale-first memory capture and thread resolution."
argument-hint: "Optionally specify a reviewer name or file to focus on"
agent: neurodivergent-agent
---

# Address PR Review Comments

Read the active pull request, identify unresolved review comments and feedback, implement the requested changes, resolve threads, and continuously capture rationale-first memories in neurodivergent-memory MCP.

## When to Use

- A reviewer has left comments or change requests on the active PR
- You need to systematically work through all open review threads
- You want to respond to or implement reviewer feedback

## MCP Prerequisite (Do Not Skip)

Before any code or PR-thread action, ensure neurodivergent-memory MCP tools are available.

- If available, start with memory retrieval before planning or editing.
- If unavailable or disconnected:
1. Ask the user which setup policy applies: `prompt-first` or `auto-setup`.
2. If unspecified, default to `prompt-first`.
3. If user approves setup, run `npm install -g neurodivergent-memory`.
4. Confirm connectivity with a simple memory operation.
5. If MCP still cannot be used, stop and report the blocker instead of silently proceeding.

## Memory Contract (Mandatory)

Use canonical tags on all memories:
- `topic:X`
- `scope:X`
- `kind:X`
- `layer:X`

Minimum cadence (required):
1. Retrieve context (`memory_stats` and `search_memories`, or equivalent retrieval if `memory_stats` is unavailable).
2. Store or update a plan memory before implementation.
3. Connect the plan to related prior reasoning/risk/handoff memories when `connect_memories` is available.
4. Execute review fixes.
5. After every file modification or significant decision, write or update memory with what changed and why.
6. Write validation memory with test/lint/build results or explicit verification notes.
7. Write final handoff memory with completed work, remaining work, current slice, and key constraints/risks.
8. Connect new memories to the task thread when `connect_memories` is available.

Memory quality rules:
- Do not write execution-only logs. Include rationale/tradeoff, or link to a reasoning memory in `logical_analysis` or `creative_synthesis`.
- Prefer `update_memory` over creating duplicate high-similarity task logs when continuing the same active slice.
- Do not treat repo-local notes or markdown files as substitutes for MCP plan/progress/validation/handoff writes.

## Procedure

### 1. Read the Active PR

Use the active-pull-request tool available in the current workflow (for example `github.vscode-pull-request-github/activePullRequest` or an equivalent pull-request read tool).

Refresh logic:
- Call the tool once without `refresh` to get cached state.
- Inspect `lastUpdatedAt` in the result.
- If timestamp is less than 3 minutes ago, call again with `refresh: true`.
- If older than 3 minutes, proceed with cached data.

Before moving to step 2, retrieve memory context relevant to this PR and reviewer feedback.

### 2. Identify Unresolved Comments

From the tool result, collect all feedback that needs action:
- `reviewThreads`: focus on threads where `isResolved` is `false`.
- `timelineComments`: include comments/reviews where `commentType` is `CHANGES_REQUESTED` or `COMMENTED`.

Group related threads by file (`file`) to handle them efficiently.

### 3. Plan Changes

Before modifying files:
1. Read each unresolved comment carefully.
2. Identify file/location per comment.
3. Determine minimal correct fix or explicit no-change rationale.
4. Note dependencies between comments.

Then write or update an MCP plan memory for this PR-comment slice, including planned thread groups, risk flags, validation intent, and the durable principle guiding the changes.

### 4. Implement Changes

Work through grouped comments file by file:
- Read relevant file section before editing.
- Apply requested change.
- Avoid out-of-scope refactors.
- If a comment is unclear/contradictory, capture follow-up question instead of guessing.

After each file change or meaningful decision, immediately write or update memory.

### 5. Verify

After all changes:
- Ensure each originally unresolved thread has either a code change or explicit no-change rationale.
- Ensure no unrelated code was modified.
- Record validation evidence in memory (tests/lint/build or explicit manual verification notes).

### 6. Resolve Threads

For each addressed thread:
- If the current workflow exposes a pull-request review-thread resolution tool, use that available tool with the thread `id`.
- Resolve only when `canResolve` is `true`.
- Skip threads already resolved or not resolvable.
- If no review-thread resolution tool is available in the current workflow, do not attempt to resolve the thread; note that limitation in the final summary.

### 7. Summarize

Provide a concise summary of:
- Which comments were addressed and what changed.
- Which comments were intentionally skipped (with rationale).
- Any follow-up questions for the reviewer.

Also include memory outcomes:
- Plan/progress/validation/handoff memory IDs.
- Which memories were updated versus created.
- The key rationale/principle captured for reuse.
