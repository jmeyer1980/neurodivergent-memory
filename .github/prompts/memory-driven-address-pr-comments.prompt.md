---
name: address-pr-comments
description: "Address review comments (including Copilot comments) on the active pull request. Use when: responding to PR feedback, fixing review comments, resolving PR threads, implementing requested changes from reviewers, addressing code review, fixing PR issues."
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

Call the `github-pull-request_currentActivePullRequest` tool.

**Refresh logic**: Check whether a refresh is needed before reading:

- Call the tool once *without* `refresh` to get the cached state
- Inspect the `lastUpdatedAt` field in the result
- If the timestamp is **less than 3 minutes ago**, the PR is actively changing - call the tool again with `refresh: true` to ensure you have the latest comments and state
- If the timestamp is older than 3 minutes, proceed with the cached data

Before moving to step 2, retrieve memory context relevant to this PR and reviewer feedback.

### 2. Identify Unresolved Comments

From the tool result, collect all feedback that needs action:

- **`reviewThreads`** array: inline review thread objects with an `id`, `isResolved` flag, `canResolve` flag, `file` path, and nested `comments`. Focus on threads where `isResolved` is `false`.
- **`timelineComments`** array: general PR comments and reviews where `commentType` is `"CHANGES_REQUESTED"` or `"COMMENTED"`

Group related threads by file (`file` field) to handle them efficiently.

### 3. Plan Changes

Before modifying any files:

1. Read each unresolved comment carefully
2. Identify the file and location each comment refers to
3. Determine the minimal correct fix for each, if a fix is needed (not all comments are worthy of a change)
4. Note dependencies between comments (e.g., a rename that affects multiple files)

Then write or update an MCP plan memory for this PR-comment slice, including:

- Planned comment/thread groups
- Risk flags
- Validation intent
- Durable principle guiding the changes

### 4. Implement Changes

Work through the grouped comments file by file:

- Read the relevant file section before editing
- Apply the requested change
- Do not refactor or modify code outside the scope of each comment
- If a comment is unclear or contradictory, note it for a follow-up reply rather than guessing

After each file change or meaningful decision, immediately write or update memory.

### 5. Verify

After all changes are made:

- Review that each originally unresolved thread has a corresponding code change or a note about why no code change was needed.
- Ensure no unrelated code was modified
- Record validation evidence in memory (tests/lint/build or explicit manual verification notes).

### 6. Resolve Threads

For each thread that was addressed (either by a code change or by a deliberate decision not to change):

- If the current workflow exposes a pull-request review-thread resolution tool, use that available tool with the `id` from the `reviewThreads` array.
- Only resolve threads where `canResolve` is `true`.
- Skip threads that are already resolved (`isResolved: true`) or where `canResolve` is `false`.
- If no review-thread resolution tool is available in the current workflow, do not attempt to resolve the thread; instead, note that limitation in the final summary.

### 7. Summarize

Provide a concise summary of:

- Which comments were addressed and what changes were made
- Any comments that were intentionally skipped (with reasoning)
- Any follow-up questions for the reviewer

Also include a memory summary:

- Plan/progress/validation/handoff memory IDs
- Which memories were updated vs newly created
- The key rationale/principle captured for future sessions
