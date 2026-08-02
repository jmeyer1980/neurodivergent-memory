# Rolodex Search & Creation — Design

**Date:** 2026-08-02
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with Claude (Opus 5)
**Builds on:** `docs/superpowers/specs/2026-07-31-rolodex-legibility-design.md` (shipped, PR #161)
**Origin:** the two capabilities the classic app has that the rolodex does not

## Goal

The rolodex can read, navigate, rename, and edit. It cannot **find** and it cannot
**create**. Both gaps were raised by the user after the legibility slice shipped:

> "we're missing a search function in the new UX. We already have it in the old."

> "along with the search, being able to create new memories in the rolodex. The old
> UX had it, this one does not."

Until both exist, the rolodex cannot replace the classic app for a full session,
which is the stated direction of travel.

### Two corrections to the framing, established before designing

**The classic app's search is not what it was assumed to be.** It is a plain
client-side substring match over concatenated fields
(`` `${name} ${content} ${tags} ${district}`.toLowerCase().includes(q) ``,
`scripts/nd-mem-mcp-app-bridge.html`). No semantics, no ranking. So agent-parity
search is **new capability**, not a port. This is stated here so nobody later
"simplifies" it back into `.includes()` on the grounds that the other app does that.

**`search_memories` returns prose, not data.** The tool formats results for a reader:

```
🔍 Found 12 memories (ranked by BM25 relevance):
• [0.873] memory_123 — Some title (scholar)
  first eighty characters of content…
```

There is no structured search API. The BM25 index is a private class inside
`src/server-main.ts`, not a reusable module. Every option below is shaped by that.

## Non-goals

- Extracting the BM25 scorer into a shared module. Architecturally cleaner, but it
  refactors the internals of the agent-critical search path in a 7,000-line file —
  a larger and riskier change than the feature it would serve.
- A results view with its own place in the navigation tree. Search annotates the
  drum you are looking at; it does not build a new one. See §3.
- Search-as-navigation ("take me to the match"). The drill-down in §3 covers the
  same need using navigation that already exists.
- Any change to the classic app, to drum geometry, or to the nav tree's structure.
- Editing from the create modal, or creating from the edit modal. One component,
  two modes, one direction each (§4).

## 1. Scope and phasing

One spec, **two implementation phases**, in this order:

1. **Creation** — nearly self-contained. `POST /save` already exists and routes to
   `store_memory`; the work is UI plus an autofill resolver.
2. **Search** — larger, and carries the only real risk in the design (§2).

Phased this way so creation can land even if search needs another round. They are
designed together because they share one question — where input lives in a 3D
carousel — and answering it twice would produce two answers.

## 2. Search: obtaining the ranking

**The bridge gains `GET /search?q=…`**, with optional `district`, `project_id`,
`tags`, `min_score` passed straight through (the tool already accepts all of them).

It calls `search_memories` via the existing `runMcpTool`, then **parses only the
`[score]` and `memory_id` pairs** out of the response. The route returns those two
fields and nothing else; the **page** hydrates full records from the snapshot it
already holds. Response:

```json
{ "hits": [ { "id": "memory_123", "score": 0.873 } ], "total": 12, "query": "deploy" }
```

**Rulings:**

- **`search_memories` returns the WHOLE store, and the bridge must drop the
  zeroes.** Its `min_score` defaults to `0`; BM25 scores a document containing
  none of the query terms exactly `0`, and the Robertson IDF variant it uses is
  always positive, so a score is never negative. `0 >= 0` passes the threshold,
  and there is no result cap in the tool — so an unfiltered response ranks the
  real matches first and then lists **every other memory in the store at
  `0.000`**. Against a design that dims rather than filters, that means every
  card is lit and the query discriminates nothing. `/search` therefore keeps only
  `score > 0`. Filtered at the bridge rather than by passing a small epsilon as
  `min_score`, because the tool's schema documents `minimum: 0` and this is the
  only place the reason can be written down. Cost: scores arrive through prose at
  three decimals, so a genuine match normalising below `0.0005` of the top hit
  reads as `0.000` and is dropped with the misses — it takes a single very common
  query term plus an extreme document-length spread, and a card missing from the
  lit set is a far smaller failure than every card being in it.
- **Parse minimally.** Recovering two tokens per line is a much narrower contract
  than parsing titles, archetypes and truncated previews — and everything else is
  already available locally, at full fidelity, in the snapshot.
- **The parser is pure and exported** from `scripts/nd-mem-rolodex-helpers.mjs`,
  unit-tested against captured fixtures covering: normal results, zero results,
  the `Did you mean project_id: …?` suffix, and the `Partial matches:` block.
- **A contract test pins the format.** It runs a real `search_memories` against a
  seeded temp store and asserts the parser recovers the expected ids. Both sides
  live in this repo, so a formatting change to the tool breaks CI rather than
  silently returning zero hits in production. This test is the whole reason
  parsing is acceptable; without it this approach should not ship.
- The bridge never writes here. `/search` is a read path and must stay one.

## 3. Search: effect on the drum

State: `state.search = { query, hits }` where `hits` is a `Map<memoryId, score>`.
Empty query means no search is active and nothing is dimmed.

**One rule at every level — a card is lit if it, or anything inside it, matches:**

| level | a card is lit when |
|---|---|
| memories | its own id is in `hits` |
| districts | any memory in that district is in `hits` |
| projects | any memory in that project is in `hits` |

This makes search a **guided drill-down**: query at the wall, see which projects
light up, dive into a lit one, see which districts light, dive again, find the
memory. It reuses the navigation that already exists rather than inventing a
results view, and it gives the same query a meaning at every depth.

**The query is global and survives navigation.** One `search_memories` call returns
matches from the whole store; `hits` is held once and the lit-predicate re-evaluates
against it at whatever level you are standing on. That is what makes the drill-down
work: diving does not re-run the search, it re-interprets the same result set one
level deeper. The query persists across dives and zoom-outs until explicitly
cleared, and the input shows it the whole time so it is never a hidden mode.

**Input is debounced at 250ms** and a new query supersedes any in-flight request —
`/search` is a daemon round trip, so a call per keystroke would both lag and land
out of order. An empty or whitespace-only query clears rather than searching.

**Rendering.** Non-matching cards drop to `opacity:.25` (composing with, not
replacing, the existing `.card3d:not(.front)` value of `.55` — the dimmed state is
the lower of the two). Matching cards keep their normal opacity and gain a
`--primary` border tint; no size, position or z-order change. **Positions never
change.** That is the whole
point of choosing this over filtering or reordering: a 3D ring's one advantage over
a list is that "my card was over that way" remains true, and both alternatives
destroy it. Filtering additionally can leave the user facing an empty stage.

**Stepping.** While a search is active, `◀ ▶` and the arrow keys advance to the next
**lit** card rather than the next card, so a 364-memory bucket stays fast. With no
search active, behaviour is unchanged. If a search is active and nothing is lit at
this level, stepping falls back to normal stepping rather than refusing to move.

**Where the input lives.** In the location band's row. It replaces the coordinate
while active and restores it on clear: the coordinate answers *where am I*, the
query answers *what am I looking for*, and both are rarely needed at once. That row
already wraps at every width and is already guarded at five viewports, so it is the
one surface with an overflow test pointed at it.

**Clearing** restores full opacity everywhere and returns the coordinate. Escape
clears the query when the input has focus (the modal-close handler already owns
Escape otherwise and must keep priority).

## 4. Creation

**A round `+` in the chrome bar's right cluster**, beside `?`, theme and Classic
view. Placement reasoning is in §6.

**One modal, two modes.** The rolodex's existing edit modal gains a create mode
rather than gaining a sibling. The two apps' near-duplicate modals have *already*
drifted once — that divergence was a code-review finding — and a third copy in the
same repo would drift too. Create mode differs by: title, submit label, no
`memoryId`, and posting to `/save` instead of `/update`.

**Autofill escalates with depth**, which is what the coordinate already means:

| opened from | pre-fills |
|---|---|
| `+` at projects | nothing |
| `+` at districts | project |
| `+` at memories | project + district |
| long-press a project card | that project |
| long-press a district card | that project + district |

The resolver is a pure function of `(view, pressedCard)` and is unit-tested.

**Long-press** is a new `longPress` kind in `H.routeGesture` returning `'create'`.

- It resolves the pressed card through the existing `cardIndexAtPoint`, so rotated
  side cards work — Chromium cannot DOM-hit-test them.
- It is **not** bound at the memories level: there the card is a reading surface and
  the gesture belongs to text selection.
- On iOS it must suppress the native callout without disturbing `.reader-scroll`'s
  deliberate `user-select: text`.
- Right-click is **not** available: `contextmenu` is already bound to `zoomOut`
  via the gesture table's `rightClick` case. Long-press is the only free gesture.

**Why both a button and a gesture.** They do different jobs. The button makes
creation discoverable; the gesture makes it fast and contextual. Shipping only the
gesture would repeat the mistake this project already made once, when a bare `›`
affordance shipped and was reported as "confusing as to what that means or what it
is for". Nobody long-presses a card to discover what happens.

**Submission** posts to `/save`. Intensity reuses the validation added in PR #161:
0–1, finite, toast on invalid, omitted when the field is empty.

## 5. Testing

**Unit** (`test/rolodex-helpers.test.mjs`, pure functions in the helpers):
- the `[score] id` parser, including zero-result and did-you-mean shapes
- the "is this container lit" predicate at all three levels
- the autofill resolver for all five entry points in §4
- lit-stepping: next-lit-index from a given index, including the wrap and the
  no-lit-cards fallback to ordinary stepping

**Contract** (`test/bridge-search-contract.test.mjs`): a real `search_memories`
call against a seeded temp store, asserting the parser recovers the expected ids.
Guards the one fragile seam in the design. Seeds **two** memories, one of which
shares no token with the query, and asserts that one is **absent** from the hits —
with a single seed, "returned the match" and "returned the entire store" are the
same response, and the entire store is what the tool actually returns (see §2).

**Browser** (`e2e/rolodex-layout.spec.ts`):
- searching dims non-matches and leaves every card's position unchanged
  (positions captured before and after and asserted identical), asserting the lit
  and dimmed counts **separately** — summing them passes when nothing dims
- a project card lights when a memory inside it matches
- the query survives a dive: search at the wall, dive into a lit project, and the
  matching districts are lit without re-typing
- stepping skips to the next lit card while a search is active, and takes the
  short way round the drum to reach it
- clearing restores opacity (the coordinate's reappearance is CSS-only —
  `#locus.searching` is toggled by the same input handler that clears the query —
  and is left to the "search must not move a card" guard rather than asserted
  separately)
- `+` opens with the correct pre-fill at each level
- long-press on a district card pre-fills project and district
- the chrome bar keeps every control on screen at all five viewports **with the
  seventh control present**

`npm test` stays `node --test`; browser specs stay in `e2e/`.

## 6. Risks and constraints

- **The parser is the sharp edge.** Its failure mode is silent — zero hits, not an
  error. The contract test is what makes it acceptable; weakening that test
  re-arms the risk invisibly.
- **A seventh chrome control** goes onto a bar that has overflowed in production
  before. Chosen anyway because it is the one surface with a guard already testing
  five viewports, and the band's `flex-wrap` gives it somewhere to go. A floating
  button would have been a fifth fixed element needing to stay clear of the card,
  hud, spin buttons and minimap — four elements that all collided with something
  during the previous slice.
- **Dimming must not fight the existing card states.** `.card3d` already carries
  `.front`, `.flipped` and the `:not(.front)::after` affordance; the search state is
  another axis and must compose with all three rather than override them.
- Playwright's WebKit is tap-only and exposes no CDP, so long-press behaviour on
  iOS — especially callout suppression — needs device confirmation. It cannot be
  gated by the browser suite.

## 7. Files

| File | Change |
|---|---|
| `scripts/nd-mem-bridge-server.mjs` | `GET /search` route |
| `scripts/nd-mem-rolodex-helpers.mjs` | result parser, lit-predicate, autofill resolver |
| `scripts/nd-mem-rolodex.html` | search input, dim rendering, lit-stepping, `+` button, create mode, long-press |
| `test/rolodex-helpers.test.mjs` | unit coverage for the three pure functions |
| `test/bridge-search-contract.test.mjs` | the format contract test |
| `e2e/rolodex-layout.spec.ts` | the browser guards in §5 |
