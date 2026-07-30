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

> **Post-implementation correction (2026-07-30, second revision):** the
> bullets below replace the shrink/pan/lift design corrected in place
> earlier the same day (see the prior version of this note, still in git
> history). That design worked, but the user reviewed it and correctly
> diagnosed the actual defect: not rotation, but the fan's radius. What
> follows describes what shipped after the revert; the three-layer
> never-rotates → lift → pan → viewport-shrink apparatus is deleted, not
> narrated as history here — see the decisions log below for the ruling,
> and `.superpowers/sdd/2026-07-29-rolodex-navigation-aids/task-15-*` for
> the fuller account.

- **Rule: cards ≤ 4 → fan; cards ≥ 5 → full cylinder.** Applies at every
  level; a drum crossing the threshold via live changes re-lays out on the
  next rebuild.
- Fan geometry: cards sit on a forward arc, angled outward on the cylinder
  surface — the same language a cylinder uses, just over a much smaller
  total sweep. Spread scales with count and is capped so that centring an
  END card by rotation leaves the FAR card at no more than ~45° (cos 0.7,
  still clearly readable):
  1 card = flat center; 2 cards ±15°; 3 ±20°; 4 ±22.5°
  (`FAN_SPREAD_DEG = { 1: 0, 2: 30, 3: 40, 4: 45 }`, halved and mirrored
  about 0 for the per-card angles).
- Radius is pure non-overlap at that shallow step, with the existing
  260px floor and no viewport awareness: `fanRadius(cardWidth, count,
  minRadius = 260)`. Because the step is shallow, the no-overlap radius
  comes out large — about 1300px for four 340px cards — which is exactly
  the "not a four-card diameter" the design wants. `drumLayout(cardWidth,
  count)` is the single source of truth for a drum's mode, radius,
  angles, and rotation bounds; it no longer takes a viewport-width
  argument.
- **The fan rotates again.** Selecting a card rotates the drum to bring
  it to centre — `rotationForCard`, `indexAtRotation`, `snapRotation` and
  `clampRotation` are all live in fan mode, the same functions a cylinder
  uses. The one difference from a cylinder: a fan **clamps** at
  `minRotation`/`maxRotation` (the first/last card's angle) instead of
  wrapping, since there is no card beyond the ends to wrap to. Wheel and
  drag still bank accumulated pixels into discrete per-card steps rather
  than free-spinning the shallow arc, unchanged from before the revert —
  but each step now eases the rotation to the new centre via the same
  `stepTarget` machinery arrow-stepping uses, instead of merely marking a
  selection by lifting it.
- Because centring is done by rotation, the selected card always sits at
  0°, flat and full width at z=0, which makes it hit-testable by the
  browser's ordinary DOM hit-testing. This closes the rotated-button
  defect (a click on Edit/Rename landing on a rotated card and diving
  instead of opening the modal) structurally, rather than by the
  geometric `cardIndexAtPoint` workaround that used to be load-bearing
  for it. That workaround (the front card's rect-based button test) is
  kept — it is still correct, and still helps if a button ever renders on
  a non-centred card — but it is now belt-and-braces.
- **One geometry, every viewport** — asked and answered directly with the
  user rather than assumed: no viewport-aware shrinking, panning, or
  lifting. On a screen too narrow for all four cards, fewer are in view at
  once (you see the centred card and parts of its neighbours), but
  rotating still reaches every card; nothing is unreachable.
- **Accepted, not engineered around:** four non-overlapping 340px cards
  span roughly 1090px of screen regardless of the chosen radius
  (perspective foreshortening buys back only ~15-20%). With the middle
  card selected, all four fit on a normal desktop viewport; with an end
  card selected, the far card clips at the viewport edge on a narrow one.
  That is what "just centre the selected card" implies, and is expected.
- Cylinder drums (≥ 5 cards) are unchanged, **including wrap-around and
  free spin**, exactly as shipped.
- Shipped pure helpers: `drumLayout(cardWidth, count)`, `fanStep(count)`,
  `fanSpread(count)`, `fanRadius(cardWidth, count, minRadius)`,
  `rotationForCard`, `indexAtRotation`, `snapRotation`, `clampRotation`.
  `panForCard`, `liftForCard`, `fanProjectedHalfWidth`,
  `FAN_MIN_CHORD_RATIO`, `FAN_VIEWPORT_MARGIN`, and `FAN_LIFT_MARGIN` are
  deleted along with the viewport-fitting machinery they supported.
  `FAN_PERSPECTIVE` remains (the page imports it rather than redeclaring
  its own copy).

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
  renders as a fan on a large, shallow arc, rotates to bring the selected
  card to full-width centre, and clamps rather than wraps at the ends; a
  5-card drum stays a cylinder, spins freely and wraps past the ends;
  clicking a centered memory card's body dives onward while the Edit
  button still opens the modal at every fan selection (the structural fix
  a face-on selected card buys); clicking a side memory card centers and
  dives. [Corrected again 2026-07-30 (task 15) — the fan reverted to
  rotating and clamping, which is what this line said before the earlier
  2026-07-30 correction above swapped it to "does not clamp — it does not
  spin at all." Both corrections landed the same day; this one is later
  and is the one that matches the shipped code.]
- **Manual:** feel of the fan's rotation ease into a clamp at the ends
  (not a pan/lift), minimap legibility, rename confirm flow. [Corrected
  again 2026-07-30 (task 15) — see the note above; the clamp-bounce feel
  this line originally described is back.]

## Decisions log (from brainstorming)

- `0^N`: N = total dives to reach here (active-path length), not laps.
- Coordinate segments AND minimap nodes are clickable time travel; jumps
  are one animation, never replays.
- Minimap: left rail, bottom-rooted tree, dead branches retained and
  dimmed, collapsible (state in localStorage).
- Rename lives on the front project card, reuses classic helpers via the
  bridge-served module, remaps the whole tree on success.
- Fan-vs-cylinder is a count rule (≤ 4 fan, ≥ 5 cylinder) at every level,
  spread capped at 22.5° (±15°/±20°/±22.5° for 2/3/4 cards) so that
  centring an end card by rotation leaves the far card at ≤45° (cos 0.7);
  a fan rotates and clamps at its ends, exactly like a cylinder rotates
  and wraps at its ends. [Corrected again 2026-07-30 (task 15) — see the
  note at the top of §4. This line has now read three different things in
  one day: "spread capped at 60°, clamped rubber-band spin in fan mode"
  (original) → "spread capped at 33°... a fan never spins, so fan mode has
  no clamp" (first correction) → the rotating-again version above (this
  correction, which matches the shipped code).]
- Memories-level clicks dive through (except interactive controls),
  making click routing uniform at all levels — field-tested revision of
  the shipped reading-surface rule.
- Every dive gesture, wraps included, is one `navPush` event: one tree,
  one depth number; the loopIndex concept is retired.
- Post-implementation ruling (2026-07-30): when geometry forbids showing
  every fan card at once, reachability wins over simultaneous visibility.
  A non-overlapping arc of forward-facing cards can never project
  narrower than roughly `count * cardWidth`, so the fan first shrinks
  (spending overlap up to `FAN_MIN_CHORD_RATIO`) and, failing that, pans
  to keep the selection centered and reachable. This retires the "every
  card visible at once" promise, but only for fans that actually pan — a
  fan that fits the viewport is unaffected and still shows every card.
  [Superseded by the task-15 ruling below: the shrink/pan apparatus this
  entry describes was deleted the same day, in favor of just rotating a
  larger drum. Left in place rather than deleted so the reasoning that led
  to it — and the reasoning that later reversed it — both survive.]
- Post-implementation ruling (2026-07-30, task 15): the user reverted the
  fan to a rotating drum after diagnosing the real defect correctly — it
  was never rotation, it was the four-card diameter. At the shallow
  `FAN_SPREAD_DEG` steps in §4, centring an end card by rotation leaves
  the far card at ≤45° (cos 0.7), comfortably readable, so rotation needed
  no workaround once the drum was sized correctly. This deletes the entire
  never-rotates / lift / pan / viewport-shrink apparatus recorded above
  and in the two earlier 2026-07-30 corrections: `panForCard`,
  `liftForCard`, `fanProjectedHalfWidth`, `FAN_MIN_CHORD_RATIO`,
  `FAN_VIEWPORT_MARGIN`, `FAN_LIFT_MARGIN`, and `drumLayout`'s
  `viewportWidth` parameter are all removed rather than kept for
  compatibility. One geometry serves every viewport (asked and answered
  with the user directly): a narrow screen just shows fewer cards at once
  and reaches the rest by rotating. A second-order benefit follows from
  centring-by-rotation: the selected card always sits at 0°, flat and
  face-on, and is therefore hit-testable by the browser — closing the
  rotated-button defect structurally instead of by the geometric
  `cardIndexAtPoint` workaround, which is kept only as a belt-and-braces
  fallback.
