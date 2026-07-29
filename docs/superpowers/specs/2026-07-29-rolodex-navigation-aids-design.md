# Rolodex Navigation Aids — Design

**Date:** 2026-07-29
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with Claude (Fable 5)
**Builds on:** `docs/superpowers/specs/2026-07-28-rolodex-webapp-design.md` (shipped)

## Goal

Give the rolodex proprioception. The drum shows *what you're looking at*;
nothing shows *how deep you are* or *how you got here*, and the cyclic
dive makes depth invisible without a counter. Four additions:

1. **Coordinate display** — a live shorthand path with a depth counter:
   `0^7 > project > district > memory_id`.
2. **Exploration-tree minimap** — a collapsible, bottom-rooted tree in the
   left rail recording every dive this session, dead ends included; every
   node is a clickable jump.
3. **In-app project rename** — the classic app's rename/merge flow, native
   to the rolodex.
4. **Fan layout for small drums** — any drum with ≤ 4 cards lays out as a
   forward-facing arc with every card visible; ≥ 5 cards keeps the full
   cylinder. Applies at every level.
5. **Click-through at the memories level** — clicking a memory card dives
   onward (the wrap to projects), exactly like every other level; only
   interactive controls (Edit, Rename, links) are exempt. Supersedes the
   shipped design's "memories cards are a reading surface" click rule,
   which field use proved to be friction: readers scroll, divers click.

## Non-goals

- Persisting the exploration tree across page reloads (session-only, like
  the history it replaces).
- Creating memories or merging projects beyond what rename-with-collision
  already implies. Creation stays in the classic app.
- Search/filters (unchanged from the v1 non-goals).
- Changing bridge write paths — rename uses the existing `POST /update`.

## 1. Coordinate display

The breadcrumb pill becomes the coordinate, monospace, always visible:

```
0^7 > twg_progressiongraph > practical_execution > memory_1106
```

- `N` in `0^N` = active-path length of the navigation tree (total dives to
  reach the current view; zoom-out decrements it). `0` is the origin marker.
- Path segments are the current lap's context (`view.projectId`,
  `view.districtId`) and the **live centered card** as the leaf — the leaf
  updates while spinning. At the projects level the coordinate is just
  `0^N` plus the centered project as leaf.
- Every segment is clickable:
  - `0` jumps to the session root (the wall).
  - A context segment jumps back to the view where that segment was the
    drum (the districts drum of that project, etc.): the cursor walks up
    the active path until the view matches the segment's level + context.
    If nothing on the path matches (contexts died to SSE changes),
    validation walks further up — nearest surviving ancestor, same
    reconciliation rules as zoom-out.
  - The leaf segment is the current position; clicking it does nothing.
- The existing level-name pill stays; the position pill (`card 3 / 12`)
  stays.

## 2. Exploration-tree minimap

### Data model: history stack → navigation tree

The page's history stack is superseded by a **navigation tree** (new pure
helpers; the stack helpers remain exported and tested but the page stops
using them):

- Node: `{ id, parentId, view, childIds }`. A node's `view` is the view
  you were at when standing on that node (same view shape as today). The
  root node (`id 0`) is the session origin and holds the initial projects
  view.
- `cursor` points at the node whose view is on screen. A node's children
  are the dives taken from it. The cursor's ancestors (root → parent)
  play exactly the role the history stack plays today:
  - **Dive** first updates the cursor node's `view` to the leave-time
    snapshot (rotation, centered card — what `pushView` captures today),
    then enters a child holding the new view and advances the cursor.
    Re-diving into a decision already recorded as a child of the cursor
    (same level + projectId + districtId) re-enters that child instead of
    creating a duplicate sibling.
  - **Zoom-out** moves the cursor to its parent and renders the parent's
    stored view. Cursor at root = the wall (bounce, unchanged).
  - **Depth `N`** = number of ancestors of the cursor (0 at the origin).
- Dead branches are never pruned. Project rename remaps ids across the
  whole tree (see §3) so dead branches stay jumpable.

New helpers (pure, DOM-free, unit-tested in `test/rolodex-helpers.test.mjs`):

- `createNavTree() -> tree`
- `navPush(tree, view) -> nodeId` (dedupes into an existing matching child)
- `navBack(tree) -> view | null` (null = wall)
- `navAtWall(tree) -> boolean`
- `navActivePath(tree) -> view[]` (the cursor's ancestor views, root
  first, cursor's own view excluded — the "history array" equivalent
  consumed by reconciliation; empty at the wall)
- `navJump(tree, nodeId) -> view` (moves the cursor; page validates the
  view with `reconcileView` before rendering, walking to ancestors on
  invalid, as zoom-out does)
- `navRemapProject(tree, oldId, newId)` (rename support, whole tree)
- `coordinateOf(view, depth, centeredId) -> segments[]` (formatting only)

Reconcile-on-refresh keeps working on `navActivePath(tree)`; the
pop-until-valid behavior becomes cursor-walking (`navBack` repeatedly),
preserving spec rules 1–4 of the shipped design.

### One tree, one depth — every dive gesture is the same event

All dive gestures — click, Enter, Ctrl+scroll-up, pinch-spread — route
through the same `dive()` and therefore the same `navPush`, **including
the memories→projects wrap**: a wrap creates an ordinary projects-level
child at depth+1. There is no separate "loop" mechanic and no separate
loop counter; the lap-tracking mental model ("loopIndex") used during
field testing is retired, unified into tree depth. Notation note: `0^N`
in this spec means active-path depth (total dives), which subsumes the
wrap-count meaning `0^N` carried in those field notes — one symbol, one
quantity. Wrap count is derivable from the path (its projects-level
nodes) and is deliberately not a second display: the collapsed minimap
badge shows the one depth number and remains unambiguous.

### Rendering: bottom-rooted tree in the left rail

- A slim rail pinned to the left edge, rendered as one inline SVG (no
  dependencies): root node at the bottom, depth = row upward, siblings
  spread horizontally, parents centered over their children (tidy layout).
- The active path is stroked bright; dead branches are dimmed; the cursor
  node pulses. Node labels (project/district/memory id, truncated) appear
  on hover as a tooltip; nodes are ~10px circles — the rail is a map, not
  a list.
- Clicking any node = **one** animated jump (a single zoom transition to
  the target view — never replayed per-level animations).
- The rail scrolls internally when the tree grows tall or bushy; it never
  overlaps the chrome bar and takes no pointer events outside its own
  surface, so drum gestures are untouched.
- **Collapsible:** a toggle chip shrinks the rail to just the `0^N` badge.
  Collapsed state persists in `localStorage`
  (`ndmem.rolodex.minimap: 'open' | 'collapsed'`, default open).
- Reduced motion: no pulse animation; jumps are instant (existing REDUCED
  behavior).

## 3. In-app project rename

- The front **project** card gains a `Rename…` action button (same
  front-card action pattern as the memory card's Edit).
- Opens a modal (same styling family as the edit modal): text input
  prefilled with the id, Rename / Cancel buttons, Esc closes.
- Semantics are the classic app's, by importing the same helpers module
  (`GET /nd-mem-app-helpers.mjs`: `normalizeProjectId`, `nearMissOf`) —
  no duplication:
  - Renaming `(no project)` is refused.
  - Target normalizes equal to an existing project (case- and `-`/`_`-
    insensitive) → confirm **merge**; the existing project's canonical
    spelling wins.
  - Near-miss of an existing project → "did you mean" confirm step.
  - Otherwise → plain rename confirm.
- Execution: sequential `POST /update { memoryId, projectId }` per memory
  (single-writer daemon behind the bridge), progress in the toast
  (`Moving 3/17 into alpha…`), rename/edit/save buttons disabled while in
  flight. A mid-run failure stops and reports how many moved (identical to
  classic behavior; re-running the rename moves the rest).
- Completion: `navRemapProject` rewrites the old id in **every** tree node
  and in `state.view`, the drum re-centers on the renamed/merged project,
  and the SSE refresh reconciles as usual — no spurious "view emptied"
  pops, the trail and coordinate survive intact.

## 4. Fan layout for small drums (≤ 4 cards)

- **Rule: cards ≤ 4 → fan; cards ≥ 5 → full cylinder.** Applies at every
  level; a drum crossing the threshold via live changes re-lays out on the
  next rebuild.
- Fan geometry: cards sit on a forward arc, angled outward on the cylinder
  surface (consistent 3D language). Spread scales with count and is capped
  so no card passes 60° (edge-on is unreadable):
  1 card = flat center; 2 cards ≈ ±20°; 3 ≈ ±35°; 4 ≈ ±50°.
  Radius comes from a non-overlap chord constraint with the existing
  260px floor.
- Spinning in fan mode **clamps at the fan ends** with the same
  rubber-band bounce as the wall — no wrap-around. Wheel, drag, arrows,
  click-to-center, dive, coordinate, and geometric click hit-testing keep
  their semantics (the hit-test already handles arbitrary card angles).
- Cylinder drums (≥ 5 cards) are unchanged, **including wrap-around**:
  spinning past the last card continues to the first, exactly as shipped.
  The clamp/rubber-band applies only in fan mode.
- New pure helpers: `fanAngles(count) -> deg[]`, `fanRadius(cardW, count)`,
  `clampFanRotation(rotation, count) -> rotation` — unit-tested.

## 5. Click-through at the memories level

- Click routing becomes uniform across all three levels: the centered
  card's body dives (`clickCentered -> dive`), a side card centers and
  dives in one click (`clickOther -> centerThenDive`). The level-dependent
  click table in the shipped design (memories: `none` / `centerOnly`) is
  superseded; `routeGesture` and its unit test simplify accordingly.
- Exemptions: clicks on interactive controls — the Edit button, the new
  Rename button, links, and any future buttons — never dive (the existing
  `button, a` guard). The `.reader-scroll` click exemption is removed:
  clicking the reader text dives.
- Reading is unaffected where it matters: wheel-inside-the-reader still
  scrolls (the `insideReader` wheel routing is unchanged), and text
  selection by drag still works — a drag beyond the click threshold
  suppresses its click today and continues to.
- The memories-level HUD hint updates to match:
  `Scroll to spin · scroll inside the card to read · click to dive onward
  · right-click / Esc goes back`.

## Error handling

- Jumping to a node whose view no longer validates (deleted memories,
  emptied contexts) lands on the nearest surviving ancestor with the
  existing toast language.
- Rename failure mid-run: stop, toast the progress made, leave buttons
  re-enabled; the tree is only remapped after a **fully** successful run
  (a partial run leaves both old and new projects visible, exactly as the
  classic app does).
- The minimap render must never throw the page down: an SVG layout error
  logs and hides the rail for the session rather than breaking navigation.

## Testing

- **Unit (node:test):** navigation tree (push/dedupe/back/wall/active
  path/jump/remap), coordinate formatting, fan angles/radius/clamping,
  reconciliation over `navActivePath` (rules 1–4 preserved).
- **Bridge route test:** unchanged routes; no bridge changes expected.
- **Driven-browser checks (Playwright + installed Edge, as established):**
  dive three deep → coordinate reads `0^3` with correct segments; zoom out
  → `0^2`; a Ctrl+scroll wrap from memories increments depth like any dive
  and appears in the tree; fork a branch and confirm two branches render
  with the active one bright; click a dead-branch node → single-animation
  jump; rename a project → coordinate/trail show the new id; a 4-card drum
  renders as a fan with all cards' faces visible and rotation clamps; a
  5-card drum stays a cylinder and wraps past the ends; clicking a
  centered memory card's body dives onward while the Edit button still
  opens the modal; clicking a side memory card centers and dives.
- **Manual:** feel of the fan clamp bounce, minimap legibility, rename
  confirm flow.

## Decisions log (from brainstorming)

- `0^N`: N = total dives to reach here (active-path length), not laps.
- Coordinate segments AND minimap nodes are clickable time travel; jumps
  are one animation, never replays.
- Minimap: left rail, bottom-rooted tree, dead branches retained and
  dimmed, collapsible (state in localStorage).
- Rename lives on the front project card, reuses classic helpers via the
  bridge-served module, remaps the whole tree on success.
- Fan-vs-cylinder is a count rule (≤ 4 fan, ≥ 5 cylinder) at every level,
  spread capped at 60°, clamped rubber-band spin in fan mode; cylinder
  wrap-around is preserved.
- Memories-level clicks dive through (except interactive controls),
  making click routing uniform at all levels — field-tested revision of
  the shipped reading-surface rule.
- Every dive gesture, wraps included, is one `navPush` event: one tree,
  one depth number; the loopIndex concept is retired.
