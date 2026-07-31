# Rolodex Legibility — Design

**Date:** 2026-07-31
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with Claude (Opus 5)
**Builds on:** `docs/superpowers/specs/2026-07-29-rolodex-navigation-aids-design.md` (shipped)
**Origin:** public feedback on a Threads post showing the rolodex

## Goal

The navigation aids shipped on 2026-07-29 gave the rolodex proprioception.
Field feedback from people who had never seen it before shows the aids are
*present but not legible*: they communicate only with someone who already
knows the app.

Four complaints, four hats on one defect:

> "It's good practice to leave some clearer breadcrumbs to see where I am in
> the navigation. The branch map is an interesting idea but doesn't give me
> enough reference."

> "I would suggest to add some chevron or text buttons on the outer cards /
> nodes to give more affordance that it's interactive, esp on mobile."

> "Need a little more context as to what we are trying to achieve here as a
> user."

Each was verified against the code rather than taken on report, and each is
a real defect:

| Complaint | Verified cause |
|---|---|
| Breadcrumbs not apparent | Location is split across **three** identical `.pill`s (`#crumb`, `#levelName`, `#position`), none dominant, and `0^N` is printed twice |
| Cards don't look interactive | Non-front cards are `opacity:.55` with `.actions{display:none}` — an outer card carries **zero** interactive signal |
| Branch map lacks reference | Nodes are unlabelled 5px circles; the label exists only in an SVG `<title>`, so on touch the map has **no text at all** |
| No sense of purpose | Nothing states the premise, and the hint bar is wrong or absent on every phone — see §4 |

## Non-goals

- **Layered / "floor" carousels and their up/down chevrons.** The user's
  "chevrons for elevating or descending a floor" and the reviewer's "each
  layer is a new carousel underneath or above the previous level, the old one
  faded out" are the same feature, arrived at from opposite directions. It
  changes how the scene renders — today `#stage` holds exactly one `#drum`
  and diving is a zoom-through that destroys the previous level — and it
  deserves its own spec. **This design reserves its control slot** so adding
  it later is an insertion, not a redesign.
- Search, pinning, and connection/tag jumping (the standing queued features).
- Any change to the classic app at `/`, or to bridge write paths.
- Changing drum geometry, the gesture table's semantics, or nav-tree
  structure. This slice is presentation and affordance only.

## 1. Location band

`#crumb`, `#levelName` and `#position` collapse into one band that owns
"where am I":

```
⌂ 0^2   twg-progressiongraph › logical_analysis › memory_1655      card 3 of 12
```

**Rulings:**

- **`#levelName` is deleted, not moved.** It rendered `Memories · 0^2`; the
  level is already stated by the path's last district segment, and its `0^N`
  duplicated the depth badge. Net element count goes 3 → 1, so the chrome bar
  gets simpler while location gets louder.
- The depth badge gains a `⌂` glyph so it reads as the home button it has
  always been. The `0^N` notation itself is kept — it is the project's
  established coordinate language — and is explained in the `?` panel (§4)
  rather than in the band.
- **No inline `Project:` / `District:` labels.** They would roughly double the
  length of a string that already overflows at 52vw. Segment *kind* stays
  conveyed by the existing `.seg.depth` / `.seg.leaf` styling.
- **Wraps; never ellipsises.** Where a viewport still cannot fit, truncation
  consumes the **leftmost** segments first. The leaf is the one segment a user
  always needs.
- Type goes from `.78rem` muted (`var(--muted)`) to `.95rem` at
  `var(--text)`. Monospace is retained — the segments are machine ids and
  monospace is honest about it.
- At the wall the band reads `All projects · N projects`.
- Segment jump-back behaviour, the `atCurrent` disabled rule and the
  `atWallBadge` rule carry over **verbatim**. This is a presentation change;
  no navigation semantics move.
- On landscape phones (`max-height:500px`) the band folds back into the
  existing chrome row rather than adding a second one. That viewport is the
  tightest the app has and already drove a dedicated fix.

## 2. Card affordance chevrons

A `›` appears on every non-`.front` card — the mirror of how `.actions`
appears only on the front one.

> **The chevron is `pointer-events:none`. This is non-negotiable.**
>
> Chromium cannot hit-test 3D-rotated cards: pointer events *and*
> `elementFromPoint` both return `#scene` for any non-flat card. That is
> exactly why interactive controls live only on `.card3d.front` today. A real
> button on an outer card walks straight back into a defect this project has
> already fought twice. The chevron is a **sign, not a control** — the page's
> own geometric hit-test (`cardIndexAtPoint`) continues to do the work, and
> clicking anywhere on the card keeps its existing centre-then-dive meaning.

Supporting affordance: `cursor:pointer` on `.card3d`, and a small hover lift
behind `@media (hover:hover)` so pointer devices get feedback that touch
devices cannot use anyway.

## 3. Stage-edge spin chevrons

Two real `<button>`s, `◀` and `▶`, spin the drum by one card.

- They route through `H.routeGesture('arrowLeft' | 'arrowRight')` — the same
  path the arrow keys already use. Reusing the shipped gesture table rather
  than adding a parallel spin implementation follows the precedent set by
  commit `e7eaad2` (pointer drags routed through `classifyDragAxis` /
  `routeDragAxis`). Fan-mode clamping falls out of the existing step path for
  free.
- Hidden when the drum holds ≤ 1 card.
- **Placement is viewport-dependent.** Side gutters on desktop. At ≤ 560px
  they move into the bottom HUD row, flanking the hint text: phone cards are
  near-full-width, so a side gutter would overlap them, and the bottom row is
  where thumbs are.
- These buttons are real controls on flat, unrotated chrome — the §2
  hit-test constraint does not apply to them.

**Reserved slot:** the control cluster is built as a container with `left` and
`right` positions occupied and `up` / `down` positions defined but unrendered,
so the deferred floor chevrons drop in without relayout.

## 4. Orientation

- **Wall copy.** One orienting line, rendered **only at `0^0`** so it never
  competes for space at depth. Draft copy, to be refined during
  implementation but fixed in shape — what it is, then what to do:

  > Your memory, as a card drum. Spin to browse projects, open one to go
  > deeper: **projects → districts → memories.**
- **`?` pill** in the chrome opens a panel reusing the existing
  `.modalbg` / `.modal` markup. Contents: what a memory is; the three levels;
  what `0^N` means; the gestures in both touch and desktop wording; how to
  read the branch map.
- **No auto-popup.** Nothing interrupts a first visit, and the panel is
  equally available on the fiftieth visit — which a dismissed-once overlay is
  not. No persisted first-run state to get wrong.
- **The hint bar gets touch wording.** Precisely what is wrong today:
  `#hudHint{display:none}` occurs exactly once, in `@media (max-height:500px)`
  — so **landscape** phones get no hint at all, while **portrait** phones get
  the bar carrying desktop-only prose ("right-click", "Ctrl+scroll") that
  means nothing to a thumb. It is not, as first written here, hidden below
  560px.

  Wording moves to a pure `hintFor(level, pointerKind)` helper keyed off
  `(pointer: coarse)`. **The landscape hide stays.** It was a deliberate
  reclamation of vertical space on a viewport where the bar sat on the card
  at 393px tall, and shorter copy does not make that space free; the `?`
  panel is where a landscape user gets the full story. This closes the
  standing backlog defect "`#hud` still shows desktop-only hints to touch
  users". Four strings, one per (level × pointerKind) pair:

  | | `fine` (today's wording, unchanged) | `coarse` |
  |---|---|---|
  | non-memories | Scroll to spin · click a card to dive · right-click / Esc to zoom out · Ctrl+scroll zooms | Swipe to spin · tap a card to open · pinch in to go back |
  | memories | Scroll to spin · scroll inside the card to read · click to dive onward · right-click / Esc goes back | Swipe to spin · drag inside the card to read · tap to go onward · pinch in to go back |

## 5. Branch map labels

Truncated `<text>` beside every node, with the untruncated value retained in
the existing `<title>`.

- **Labels truncate to 10 characters**, middle-elided, so
  `twg-progressiongraph` → `twg-…graph` and `logical_analysis` →
  `logi…ysis`. Middle rather than tail because district names share long
  prefixes (`practical_execution` / `logical_analysis` diverge early, but
  `vigilant_monitoring` truncated to a head alone loses the word that
  distinguishes it), while the head keeps project ids recognisable.
- At `.6rem` monospace a 10-char label is ~58px. Measured from a node
  centre: `r=5` + a 4px gap + 58px = ~67px, so **`MINIMAP_COL` goes 46px →
  76px** and `#mapBody` max-width goes 180px → 260px. The existing
  `overflow:auto` and frontier auto-scroll (`scrollLeft = scrollWidth`)
  already handle the wider tree.

  > `MINIMAP_COL` is **46**, not the 26 named in the comment above it —
  > 26 is a superseded value the comment preserves as rationale. Anything
  > deriving from the pitch must read the constant, not the comment.
- **Every node is labelled, including abandoned branches.** Labelling only the
  active path would leave the map unable to answer what a branch you left
  actually was — which is the map's entire reason to exist.
- Truncation is DOM-free logic and therefore lands in
  `scripts/nd-mem-rolodex-helpers.mjs` as `truncateNodeLabel`, unit-tested,
  matching how every other pure rolodex helper is structured.
- Below 760px the map still defaults collapsed; this changes what it looks
  like when opened, not when it opens.

## 6. Testing

**Unit** (`test/rolodex-helpers.test.mjs`, `node --test`):
`truncateNodeLabel`, `hintFor`, and band composition.

**Browser** (`e2e/rolodex-layout.spec.ts`, both projects including the
iPhone 15 / mobile-safari project):

- the location band is unclipped at the five viewports already covered,
  including both landscape widths;
- a band segment click jumps back to that view;
- an edge chevron advances the selection by exactly one, and clamps rather
  than wraps in fan mode;
- **clicking an outer card *on its chevron* still centres-and-dives** — the
  single most important regression guard in this slice, since it is what
  fails if the chevron ever stops being `pointer-events:none`;
- map labels are present as `<text>`, not only as `<title>`;
- the hint bar is visible at 390px.

`npm test` must stay byte-identical: specs stay in `e2e/`, never under
`test/`, because `npm test` is `node --test` with default discovery.

## 7. Risks and constraints

- **The §2 hit-test constraint is the sharp edge of this slice.** Any drift
  toward making the chevron a real element with pointer events reintroduces a
  known, twice-fought defect that unit tests cannot see.
- The location band must not reintroduce landscape chrome overflow.
  `flex-wrap` at every width is load-bearing and must survive.
- Nav persistence and reload-restore must survive the `#levelName` deletion.
- Sampling one viewport is not verification — a past regression put the
  selected card up to 268px off-screen between 1024px and 1600px while
  passing checks at 390px and one desktop width.
- Playwright's WebKit is tap-only and exposes no CDP: it gates layout and JS
  routing but can never answer "would the browser have scrolled or zoomed
  this natively". Device confirmation on the iPhone stays necessary for
  anything gesture-shaped.

## 8. Files

| File | Change |
|---|---|
| `scripts/nd-mem-rolodex.html` | location band markup + CSS, chevrons, `?` panel, wall copy, hint visibility, map label rendering |
| `scripts/nd-mem-rolodex-helpers.mjs` | `truncateNodeLabel`, `hintFor`, band composition; wider column pitch in `layoutNavTree` |
| `test/rolodex-helpers.test.mjs` | unit coverage for the new pure helpers |
| `e2e/rolodex-layout.spec.ts` | the browser guards in §6 |

## Appendix — verbatim feedback

```
Need a little more context as to what we are trying to achieve here as a user.
Also it's good practice to leave some clearer breadcrumbs to see where I am in
the navigation. The branch map is an interesting idea but doesn't give me
enough reference.
I like the circular carousel feel in the older video, perhaps each layer is a
new carousel underneath or above the previous level but the old one remains
faded out so you can click to traverse back easily.

---

Hi! I would suggest to add some chevron or text buttons on the outer cards /
nodes to give more affordance that it's interactive, esp on mobile
```

The third paragraph of the first comment is the deferred layered-carousel
feature, recorded here so its origin is not lost when its own spec is written.
