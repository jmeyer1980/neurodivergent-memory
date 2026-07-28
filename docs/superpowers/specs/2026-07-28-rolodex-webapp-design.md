# Nested 3D Rolodex Web App — Design

**Date:** 2026-07-28
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with Claude (Fable 5)

## Goal

A second web UI for browsing the memory store as nested 3D rolodex carousels:
spin through **Projects**, dive into one to spin through its **Districts**, dive
again to read **Memories** card by card. Diving past the memories level wraps
back to project selection; zooming out walks back through the exact views you
came from. The experience is navigation-first — the rolodex itself is the
reader.

The classic app stays untouched at `/`. The rolodex is a new page at
`/rolodex`; once it earns it, which page `/` serves can be flipped later.

## Non-goals (v1)

- Creating memories, project rename/merge — classic app keeps those; the
  rolodex links to it.
- Search and scope/district filters.
- Replacing the classic app or changing any bridge write behavior.
- WebGL/Three.js or any dependency. CSS 3D transforms only, no build step.

## Navigation model

Three levels in a fixed cycle, one drum (cylinder carousel) on screen at a
time:

```
Projects ──dive──▶ Districts ──dive──▶ Memories ──dive──▶ Projects (wraps)
    ▲                                                          │
    └────────────────── zoom-out pops history ◀────────────────┘
```

- **Projects drum** — one card per project, derived from every memory's
  `project_id`, including the `(no project)` pseudo-project, same rules as the
  classic sidebar.
- **Districts drum** — one card per district that has at least one memory in
  the selected project.
- **Memories drum** — one card per memory in the selected project + district.
- **Dive from Memories wraps to Projects**: `level = (level + 1) % 3`.

### History stack

Every dive pushes a snapshot of the view being left: `{ level, contextIds
(project/district), centeredItemId, rotation }`. Zoom-out **pops** — it
returns to the precise prior view (same centered card, same rotation), not
merely "one level up". After Memories → dive → Projects, a single zoom-out
lands back on that same memory, centered, mid-read. Further zoom-outs continue
down the stack through the district and project views that led there.

### The wall

A fresh page load starts at Projects with an empty history stack. Zoom-out on
an empty stack bounces: a short backward camera nudge that springs back (plus
a subtle screen-edge flash), and nothing else. History only grows by diving,
so the first-ever view is always the hard floor — you can never back out past
it.

## Input map

| Input | Outside front card | Inside front card (Memories level) |
|---|---|---|
| Wheel | Spin drum (with inertia) | Scroll card content |
| Ctrl+wheel up / pinch-spread | Dive into centered card | Dive |
| Ctrl+wheel down / pinch-together | Zoom out (pop history) | Zoom out |
| Click a non-centered card | Rotate it to center; at Projects/Districts then dive | Rotate it to center only |
| Click the centered card | Dive (Projects/Districts) | No dive — text selection and buttons work normally |
| Horizontal drag / swipe | Spin drum | Spin drum |
| Vertical swipe (touch) | Spin drum | Scroll card content |
| Right-click / long-press | Zoom out | Zoom out |
| Esc / Backspace | Zoom out | Zoom out |
| ← / → arrows | Step one card | Step one card |
| Enter | Dive into centered card | Dive |
| On-screen ⤺ button | Zoom out | Zoom out |

Gesture ownership: the page is full-viewport with no page scroll. Wheel
listeners are non-passive and call `preventDefault()` so Ctrl+wheel never
triggers browser page-zoom; `contextmenu` is suppressed so right-click is
free. Deliberate deviation from pinch convention: **pinch-spread = dive (zoom
in), pinch-together = zoom out** — "zoom into the card / pull the camera
back", like map apps.

Click semantics are level-dependent by design: at Projects and Districts a
click is a navigation gesture (center, then dive — the prototype's behavior),
but at Memories the centered card is a *reading surface*, so clicks there
never dive. Diving from Memories (the wrap to Projects) requires an explicit
zoom gesture: Ctrl+wheel up, pinch-spread, or Enter. Clicking a non-centered
memory card just rotates it to center for reading.

## Architecture

### Files

- **`scripts/nd-mem-rolodex.html`** — new single-file page (HTML + CSS +
  vanilla JS), served at `GET /rolodex`. Owns rendering, gesture listeners,
  animation (a small `requestAnimationFrame` loop for inertia, snap, and the
  wall bounce), SSE wiring, and the edit modal.
- **`scripts/nd-mem-rolodex-helpers.mjs`** — pure, DOM-free logic, served at
  `GET /nd-mem-rolodex-helpers.mjs`, imported by the page as an ES module and
  by tests directly:
  - history stack: push/pop/peek, empty-stack (wall) detection
  - level-cycle arithmetic (dive wrap, level names)
  - cylinder math: angle-per-card, radius from card width and count (with a
    fixed minimum radius for 1–2 card drums), nearest-card snap,
    shortest-path rotation between angles
  - snapshot derivations: projects → districts → memories, same semantics as
    the classic app (`project_id` fallback to `(no project)`, `district`
    fallback to `uncategorized`)
  - refresh reconciliation: given (old view state, new snapshot) → new view
    state (see Live updates)
  - gesture routing: given (event kind, pointer-inside-front-card?, level) →
    action (`spin` | `scrollContent` | `dive` | `zoomOut` | `none`)
- **Bridge (`scripts/nd-mem-bridge-server.mjs`)** — add the two GET routes.
  This makes three copies of the existing "serve a sibling file with a
  content type" pattern, so fold all static file routes into one small
  helper while there. No write-path changes.
- **Cross-links** — classic app header gains a "Rolodex view" button linking
  to `/rolodex`; the rolodex UI has a "Classic view" link back to `/`. Only
  change to the classic app.

### Rendering approach

CSS 3D exactly as the prototype: a perspective container, a drum with
`transform-style: preserve-3d`, cards placed with
`rotateY(i·θ) translateZ(radius)`, drum spun via `rotateY(rotation)`. Dive =
camera push through the centered card (translateZ + scale + fade on the scene
container); zoom-out = the reverse. Level transitions re-render the drum's
cards while the scene is faded out.

## Cards

Shared design language with the classic app: same fonts (Clash Display /
Satoshi), dark theme default with the light theme available, teal primary,
glassy card surfaces. Per level:

- **Project card** — project name, memory count, district count chips.
- **District card** — district name, memory count, top tags.
- **Memory card** — id, title, content preview, tag chips.

**The front memory card is the reader.** The centered card scales up (~1.15×)
and brightens; it shows the full content in an internally scrollable area,
all tags, metadata (district, intensity, created, visibility), and an
**Edit** button. Non-front cards are slightly dimmed. Edit opens a modal with
the same fields as the classic edit modal (content, district, project,
visibility, intensity, epistemic status, tags) and posts to the existing
`POST /update` bridge route; only edited fields are sent.

Persistent chrome: breadcrumb (`project ▸ district`), level name, position
indicator ("card 3 / 12"), ⤺ back button, "Classic view" link, connection
state pill.

## Data & live updates

Same bridge endpoints as classic: `GET /health`, `GET /memories`,
`GET /events` (SSE). On a `memory-change` event the page refetches the
snapshot and re-renders **in place**, preserving level, rotation, history
stack, and the centered card **by id** (never by index).

Reconciliation rules (pure helper, unit-tested):

1. Centered item still exists → keep it centered (recompute its angle in the
   new drum ordering).
2. Centered item gone, drum still has items → snap to the nearest surviving
   neighbor by prior ordering.
3. Current context invalid (selected district/project no longer has items) →
   auto-zoom-out (pop) until a valid view is found, show a toast explaining
   what happened.
4. Popping history applies the same validation: a popped view whose centered
   item is gone lands on its nearest neighbor; a popped view whose whole
   context is gone is skipped (keep popping); an emptied stack shows the
   Projects root without a bounce.

## Edge cases

- **Bridge down at load** — full-screen offline notice with a retry button
  (mirrors the classic app's message).
- **Empty store** — Projects drum shows a single non-divable placeholder card
  ("No memories yet"); zoom-out still wall-bounces.
- **1–2 card drums** — fixed minimum radius so cards never z-fight or sit at
  radius 0; spin snaps between the few positions normally.
- **Very long content** — the reader area has a max height with internal
  scrolling (that is the inside-card scroll surface).
- **Edit failure** — error toast, modal stays open, input preserved.
- **`prefers-reduced-motion`** — spins, dives, and bounces become instant
  transitions; layout and behavior identical.

## Testing

- **Unit (node:test, no DOM)** against `nd-mem-rolodex-helpers.mjs`:
  - history push/pop/wall semantics, including the pop-validation rules
  - level wrap arithmetic
  - cylinder math: θ, radius (incl. 1–2 card minimum), nearest-card snap,
    shortest-path rotation
  - derivations from a fixture snapshot (projects/districts/memories,
    `(no project)` and `uncategorized` fallbacks)
  - refresh reconciliation rules 1–4 above
  - gesture routing table
- **Bridge route test** (mirrors existing bridge tests): `GET /rolodex`
  serves HTML, `GET /nd-mem-rolodex-helpers.mjs` serves JS, both with correct
  content types.
- **Manual smoke checklist** (feel can't be unit-tested):
  1. Spin each drum with wheel, drag, and arrows; inertia and snap feel right.
  2. Dive Projects → Districts → Memories; breadcrumb and position update.
  3. Read a long memory: wheel inside the card scrolls text, outside spins.
  4. Dive from Memories; confirm wrap to Projects. Zoom out once; confirm the
     exact memory returns centered.
  5. Zoom out to the root and once more; confirm the wall bounce.
  6. Edit a memory from the front card; confirm the SSE refresh keeps the
     card centered with new content.
  7. Delete/move a memory externally while viewing it; confirm
     nearest-neighbor snap (rule 2) and context fallback (rule 3).
  8. Ctrl+wheel over the page; confirm the browser never page-zooms.
  9. Touch device or DevTools emulation: horizontal swipe spins, vertical
     swipe inside the reader scrolls, pinch dives/zooms out, long-press zooms
     out.
  10. Toggle `prefers-reduced-motion` and confirm instant transitions.

## Decisions log (from brainstorming)

- New page at `/rolodex`, classic untouched; flip `/` later if earned.
- CSS 3D transforms, vanilla, single-file page + pure helpers module; no
  dependencies, no build step.
- v1 writes: edit only (front-card Edit → `/update`). Create and
  rename/merge stay in classic.
- All four zoom-out triggers accepted; page takes exclusive gesture control.
- Reading = front card is the reader with pointer-position-aware scroll
  routing.
