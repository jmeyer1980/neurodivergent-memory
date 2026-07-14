# Project Rename / Merge-on-Collision (ND-Mem Web App) — Design

**Date:** 2026-07-13
**Status:** Approved design, not yet implemented
**Target:** development branch, build-and-serve-locally (no version bump; unreleased)

## Problem

Project names drift: agents and humans create near-duplicate `project_id` spellings (live example: `twg-progressiongraph`, 38 cards, vs the canonical `twg_progressiongraph`, 341 cards). Fixing this today means editing each memory one at a time through the edit modal — slow by hand and token-wasteful for agents. The web app needs a mass re-assignment operation.

A project has no stored entity of its own: carousels are derived at render time from each memory's `project_id` (`carousels()`, [scripts/nd-mem-mcp-app-bridge.html:112](../../../scripts/nd-mem-mcp-app-bridge.html)). "Renaming a project" therefore *is* "bulk-updating `project_id` on every memory in it" — rename and merge are one mechanism with two outcomes.

## Decisions made with the user

- **UX shape:** a single "Rename project…" affordance with merge-on-collision. Renaming to an existing project's name asks for confirmation, then moves all cards into that project. (No separate merge picker.)
- **Canonical example target:** `twg_progressiongraph` (the user's message contained the typo `twg_progressiograph` — confirmed corrected; this near-miss is exactly why the design includes a similarity guard).
- **Mechanism:** client-side sequential loop over the existing bridge `POST /update` endpoint (option A). No bridge or daemon write-path changes (the bridge only gains a one-line static route for the shared helpers module — see Testing). Rejected: a new bridge endpoint (progress reporting gets harder) and a new bulk MCP tool (right primitive, but YAGNI until bulk ops recur).

## UX flow

A "Rename project…" button appears with the active project's stats (hidden when the active carousel is the `(unassigned)` pseudo-project). Clicking it prompts for a new name, pre-filled with the current `project_id`. Outcomes:

1. **Blank or unchanged** → no-op.
2. **Matches an existing project** (see Normalization below) → confirm dialog: *"Project `<target>` already exists (<targetCount> cards). Move all <N> cards from `<source>` into it?"* → on OK, run the bulk move into the **existing project's exact spelling** (the match may be normalized, e.g. user typed `TWG-ProgressionGraph`; cards get the target's canonical `project_id`, not the typed string).
3. **Genuinely new name** → if the name is a *near-miss* of some other existing project (same normalized form is case 2; here: small edit distance, e.g. one character missing — `twg_progressiograph` vs `twg_progressiongraph`), warn: *"Did you mean `<existing>`? OK = use `<existing>` (merge), Cancel = keep `<typed>` (plain rename)."* Then confirm and bulk-rename all N cards to the chosen name.

During the run: progress toast ("Moving 17/38 …"), rename/edit/save buttons disabled. On completion: toast with final count, active carousel switches to the target project (which the next render derives automatically).

## Normalization and matching

- **Collision matching (case 2):** two project ids match when `normalizeProjectId(a) === normalizeProjectId(b)` where `normalizeProjectId` lowercases and maps `-` to `_`. So `twg-progressiongraph` collides with `twg_progressiongraph`.
- **Near-miss guard (case 3):** Levenshtein distance ≤ 2 between normalized forms (computed against every existing project id) triggers the "did you mean" warning. Pure client-side helper, ~15 lines; no dependency.

## Execution

For each memory id in the source project (ids snapshotted before the first write): `POST ${BRIDGE}/update` with body `{ memoryId, projectId: <target> }` — nothing else, so content/tags/district/visibility are untouched (the bridge forwards only supplied fields; the daemon serializes writes). Calls run sequentially; each response is checked for `ok`. SSE-triggered re-renders during the run are safe (all UI state is derived from the snapshot), but the run loop iterates its own pre-snapshotted id list, not live render state.

## Error handling

- First failed `/update` stops the loop: toast *"Moved M of N. Re-run rename to move the rest."* A partial merge is a smaller source project — never data loss — and re-running the same rename is naturally resumable (already-moved cards are no longer in the source).
- Bridge/daemon unreachable at start → the first call fails → same stop-and-report path.
- Renaming `(unassigned)` is impossible (button hidden) — assigning a project to unassigned cards remains the per-card edit modal's job.

## Testing

- **Automated (bridge level):** extend the pattern in [test/bridge-daemon.test.mjs](../../../test/bridge-daemon.test.mjs): store two memories under project `drift-a`, one under `drift-b`; `POST /update` each `drift-a` memory with only `{memoryId, projectId: "drift-b"}`; assert the snapshot ends with all three under `drift-b`, content/tags/district unchanged, and no other field mutated.
- **Unit (pure helpers):** `normalizeProjectId(id)` and `nearMissOf(id, existingIds)` (Levenshtein ≤ 2 on normalized forms) live in a real module, `scripts/nd-mem-app-helpers.mjs`, so `test/project-rename-helpers.test.mjs` imports them directly. The HTML app loads them with `<script type="module">` importing `/nd-mem-app-helpers.mjs`, which the bridge serves via a one-line static route next to the existing `/` route. (This is a serve-path addition only; the bridge's write path is unchanged.)
- **Manual:** with the real store backed up, rename `twg-progressiongraph` → confirm merge into `twg_progressiongraph` → verify 0/379 split becomes one 379-card project and spot-check a moved card's fields.

## Non-goals

- Bulk edits of any other field (tags, district, visibility) — this is project re-assignment only.
- A server-side bulk/atomic tool (revisit if bulk operations recur).
- Merging connection graphs or deduplicating similar memories across the merged projects.
- Any version bump or release framing.
