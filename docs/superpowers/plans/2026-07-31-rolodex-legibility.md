# Rolodex Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rolodex legible to someone who has never seen it — a single prominent location band, visible interaction affordances on cards, a readable branch map, and copy that states what the app is for.

**Architecture:** Two files carry the whole slice. All new pure logic (label truncation, hint wording) goes into `scripts/nd-mem-rolodex-helpers.mjs`, which is DOM-free and unit-tested under `node --test`; everything visual goes into `scripts/nd-mem-rolodex.html`, a single file holding markup, CSS and one inline ES module. Nothing here changes drum geometry, gesture semantics or the nav tree — every task is presentation, wiring, or copy.

**Tech Stack:** Vanilla ES modules, no build step. `node --test` for unit tests (`npm test`), Playwright for browser tests (`npm run test:browser`, projects `desktop-chrome` and `mobile-safari`).

**Spec:** `docs/superpowers/specs/2026-07-31-rolodex-legibility-design.md`

## Global Constraints

- **Branch is `feat/rolodex-legibility`**, stacked on `fix/rolodex-mobile-usability`. Do not rebase onto `development` — it has no `e2e/`, no `playwright.config.ts` and no playwright devDependency.
- **`npm test` must stay byte-identical in scope.** It is `node --test` with default discovery, which picks up anything under `test/`. Browser specs stay in `e2e/`. Never add a spec under `test/`.
- **Chevrons on outer cards must never be hit targets.** Chromium cannot hit-test 3D-rotated cards: pointer events and `elementFromPoint` both return `#scene`. Use a CSS `::after` with `pointer-events:none` — no new DOM node.
- **`flex-wrap` on `#chrome` is load-bearing at every width.** A phone in landscape is ~737–852px CSS and misses the 560px query; removing wrap re-breaks it.
- **Dark theme must not shift.** Any new colour uses an existing custom property (`--text`, `--muted`, `--faint`, `--primary`, `--surface`, `--surfaceBorder`, `--wash`, `--washStrong`). Do not introduce literal colours.
- **Read constants, not the comments above them.** `MINIMAP_COL` is `46`; the `26` in its comment is a superseded value being justified.
- Run `npm test` and `npm run test:browser` before every commit. Baseline before this work: `npm test` 285 total / 283 pass / **2 known pre-existing failures** in `test/agent-customization-wording.test.mjs` (agent-kit template wording drift, unrelated). `npx playwright test` 16/16.

---

### Task 1: Touch-correct hint wording

The hint bar tells phones to right-click. `#hudHint{display:none}` occurs exactly once — in `@media (max-height:500px)` — so landscape phones get nothing and portrait phones get desktop prose. The landscape hide stays (it reclaimed space on a viewport where the bar sat on the card); the wording gets fixed.

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append after `coordinateOf`, ~line 507)
- Modify: `scripts/nd-mem-rolodex.html:559-561` (the inline ternary), `:212` (add the pointer probe)
- Test: `test/rolodex-helpers.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `hintFor(level: string, pointerKind: 'fine' | 'coarse') => string` and `HINTS` (the nested wording table), both exported.

- [ ] **Step 1: Write the failing test**

Append to `test/rolodex-helpers.test.mjs`, and add `hintFor` to the import block at the top of the file:

```js
test('hintFor gives coarse pointers touch verbs and never desktop-only ones', () => {
  for (const level of ['projects', 'districts', 'memories']) {
    const hint = hintFor(level, 'coarse');
    assert.doesNotMatch(hint, /right-click|Ctrl|scroll to spin/i, `${level} coarse hint leaks desktop wording`);
    assert.match(hint, /^Swipe to spin/, `${level} coarse hint should lead with the spin gesture`);
  }
});

test('hintFor keeps the shipped desktop wording for fine pointers', () => {
  assert.match(hintFor('projects', 'fine'), /right-click \/ Esc to zoom out/);
  assert.match(hintFor('memories', 'fine'), /scroll inside the card to read/);
});

test('hintFor distinguishes the memories level, where the card is a reading surface', () => {
  assert.notEqual(hintFor('memories', 'coarse'), hintFor('projects', 'coarse'));
  assert.match(hintFor('memories', 'coarse'), /drag inside the card to read/);
});

test('hintFor falls back rather than returning undefined for unknown input', () => {
  assert.equal(hintFor('districts', 'fine'), hintFor('projects', 'fine'));
  assert.equal(hintFor('projects', 'nonsense'), hintFor('projects', 'fine'));
  assert.equal(typeof hintFor(undefined, undefined), 'string');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `SyntaxError: The requested module ... does not provide an export named 'hintFor'`

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// The hint bar shipped as one desktop sentence shown to everyone, then hidden
// outright in landscape. A thumb has no right-click and no Ctrl key, so the
// portrait phone was being given instructions it could not follow. Wording is
// data keyed by (level, pointerKind) so it can be tested without a browser.
export const HINTS = {
  fine: {
    default: 'Scroll to spin · click a card to dive · right-click / Esc to zoom out · Ctrl+scroll zooms',
    memories: 'Scroll to spin · scroll inside the card to read · click to dive onward · right-click / Esc goes back',
  },
  coarse: {
    default: 'Swipe to spin · tap a card to open · pinch in to go back',
    memories: 'Swipe to spin · drag inside the card to read · tap to go onward · pinch in to go back',
  },
};

export function hintFor(level, pointerKind) {
  const table = HINTS[pointerKind] ?? HINTS.fine;
  return table[level] ?? table.default;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Wire it into the page**

In `scripts/nd-mem-rolodex.html`, after the `REDUCED` line (~212), add:

```js
    // Matched once at load, not per render: a pointer type does not change
    // mid-session, and matchMedia in a hot path is wasted work.
    const POINTER_KIND = matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine';
```

Then replace the three-line ternary at `:559-561`:

```js
      els.hudHint.textContent = level === 'memories'
        ? 'Scroll to spin · scroll inside the card to read · click to dive onward · right-click / Esc goes back'
        : 'Scroll to spin · click a card to dive · right-click / Esc to zoom out · Ctrl+scroll zooms';
```

with:

```js
      els.hudHint.textContent = H.hintFor(level, POINTER_KIND);
```

Also update the static fallback text in the markup at `:175` so a pre-JS paint does not flash desktop wording — replace the hard-coded sentence inside `#hudHint` with nothing (`<span class="pill" id="hudHint"></span>`), since `updateChrome` fills it on first render.

- [ ] **Step 6: Add the browser guard**

Append to `e2e/rolodex-layout.spec.ts`:

```ts
// A thumb has no right-click and no Ctrl key. The hint bar told it to use both.
test('the hint bar speaks the pointer it is being read by', async ({ page }, testInfo) => {
  const hint = await page.locator('#hudHint').textContent();
  const isTouch = testInfo.project.name === 'mobile-safari';
  if (isTouch) {
    expect(hint).not.toMatch(/right-click|Ctrl/i);
    expect(hint).toMatch(/^Swipe to spin/);
  } else {
    expect(hint).toMatch(/right-click/);
  }
});
```

- [ ] **Step 7: Run both suites**

Run: `npm test` — expected 285 total, 283 pass, the same 2 pre-existing `agent-customization-wording` failures and no others.
Run: `npx playwright test` — expected 18/18 (16 existing + 1 new × 2 projects).

- [ ] **Step 8: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs scripts/nd-mem-rolodex.html test/rolodex-helpers.test.mjs e2e/rolodex-layout.spec.ts
git commit -m "fix(rolodex): stop telling phones to right-click"
```

---

### Task 2: Branch-map node labels

The minimap draws unlabelled 5px circles whose only label is an SVG `<title>`. Tooltips need hover, so on touch the map has no text at all.

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs:520` (`MINIMAP_COL`), append `truncateNodeLabel`
- Modify: `scripts/nd-mem-rolodex.html:521-523` (node rendering), `:95` (`#mapBody` width), `:98-105` (add `.nodeLabel` style)
- Test: `test/rolodex-helpers.test.mjs`

**Interfaces:**
- Consumes: `layoutNavTree(tree) => { nodes: [{id, x, y, depth, onPath, isCursor, label}], edges, width, height }` (existing, unchanged shape).
- Produces: `truncateNodeLabel(label: string, max?: number) => string`, exported. Default `max` is `10`.

- [ ] **Step 1: Write the failing test**

Append to `test/rolodex-helpers.test.mjs`, adding `truncateNodeLabel` to the import block:

```js
test('truncateNodeLabel leaves short labels untouched', () => {
  assert.equal(truncateNodeLabel('start'), 'start');
  assert.equal(truncateNodeLabel('alpha'), 'alpha');
  assert.equal(truncateNodeLabel('0123456789'), '0123456789'); // exactly at the limit
});

test('truncateNodeLabel elides the middle, keeping head and tail', () => {
  // District names diverge at BOTH ends; a head-only truncation loses the word
  // that distinguishes vigilant_monitoring from vigilant_anything_else.
  const out = truncateNodeLabel('logical_analysis');
  assert.equal(out.length, 10);
  assert.ok(out.startsWith('logi'), `expected a head, got ${out}`);
  assert.ok(out.endsWith('ysis'), `expected a tail, got ${out}`);
  assert.match(out, /…/);
});

test('truncateNodeLabel keeps distinct long labels distinct', () => {
  const a = truncateNodeLabel('practical_execution');
  const b = truncateNodeLabel('practical_evaluation');
  assert.notEqual(a, b);
});

test('truncateNodeLabel tolerates junk without throwing', () => {
  assert.equal(truncateNodeLabel(''), '');
  assert.equal(truncateNodeLabel(null), '');
  assert.equal(truncateNodeLabel(undefined), '');
  assert.equal(typeof truncateNodeLabel(12345678901234), 'string');
});

test('layoutNavTree columns leave room for a truncated label', () => {
  // 10 chars at .6rem monospace is ~58px; a node is r=5 and wants a 4px gap.
  // If the pitch ever drops back below that, labels from adjacent columns
  // collide and the map becomes less readable than the bare dots it replaced.
  assert.ok(MINIMAP_COL >= 67, `MINIMAP_COL is ${MINIMAP_COL}, too tight for a 10-char label`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — no export named `truncateNodeLabel` (and `MINIMAP_COL` is not exported yet).

- [ ] **Step 3: Write minimal implementation**

In `scripts/nd-mem-rolodex-helpers.mjs`, export the pitch constant and widen it. Replace:

```js
const MINIMAP_COL = 46;   // px between sibling columns
```

with:

```js
// Widened from 46 to fit a 10-char label beside each node: ~58px of text plus
// the node's own r=5 and a 4px gap needs ~67px of clearance. (The 26 in the
// comment above is an even older value this constant already superseded —
// derive from the constant, never from the prose.)
export const MINIMAP_COL = 76;   // px between sibling columns
export const NODE_LABEL_MAX = 10;
```

Then append after `navNodeLabel`:

```js
// The map's only label used to be an SVG <title>, which requires a hover — so
// on touch the tree was a field of identical dots. Labels now render as text,
// which means they have to fit: elide the MIDDLE, because project ids share
// heads ("twg-…") and district names share tails ("…_analysis"/"…_monitoring"),
// and dropping either end alone collapses distinct nodes into the same string.
export function truncateNodeLabel(label, max = NODE_LABEL_MAX) {
  const s = String(label ?? '');
  if (s.length <= max) return s;
  const keep = max - 1;                 // one char is spent on the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}…${tail ? s.slice(-tail) : ''}`;
}
```

Add `MINIMAP_COL` to the test file's import block alongside `truncateNodeLabel`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS.

- [ ] **Step 5: Render the labels**

In `scripts/nd-mem-rolodex.html`, replace the `nodes` mapping at `:521-522`:

```js
        const nodes = laid.nodes.map(n =>
          `<circle class="node${n.onPath ? ' on' : ''}${n.isCursor ? ' cursor' : ''}" data-node="${n.id}" cx="${n.x}" cy="${n.y}" r="5"><title>${esc(n.label)} (0^${n.depth})</title></circle>`).join('');
```

with:

```js
        // The label is a sibling <text>, not a child of <circle>: SVG will not
        // render text inside a shape, and the circle stays the only click
        // target so the existing [data-node] delegation is untouched.
        const nodes = laid.nodes.map(n =>
          `<circle class="node${n.onPath ? ' on' : ''}${n.isCursor ? ' cursor' : ''}" data-node="${n.id}" cx="${n.x}" cy="${n.y}" r="5"><title>${esc(n.label)} (0^${n.depth})</title></circle>`
          + `<text class="nodeLabel${n.onPath ? ' on' : ''}" x="${n.x + 9}" y="${n.y + 3.5}">${esc(H.truncateNodeLabel(n.label))}</text>`).join('');
```

The SVG width must now include the widest label. Replace the `els.mapBody.innerHTML` assignment at `:523` so the viewBox is padded:

```js
        // laid.width measures dot positions only; the rightmost label overhangs it.
        const labelOverhang = 9 + NODE_LABEL_PX;
        const w = laid.width + labelOverhang;
        els.mapBody.innerHTML = `<svg width="${w}" height="${laid.height}" viewBox="0 0 ${w} ${laid.height}">${edges}${nodes}</svg>`;
```

and declare the constant next to `POINTER_KIND` (~line 213):

```js
    const NODE_LABEL_PX = 58; // 10 monospace chars at .6rem; see truncateNodeLabel
```

- [ ] **Step 6: Style the labels and widen the panel**

In `scripts/nd-mem-rolodex.html`, change `:95`:

```css
    #mapBody{max-height:100%;max-width:180px;overflow:auto;...}
```

to `max-width:260px`, and add after the `#mapBody .node:hover` rule (`:103`):

```css
    #mapBody .nodeLabel{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.6rem;fill:var(--faint);pointer-events:none;user-select:none}
    #mapBody .nodeLabel.on{fill:var(--muted)}
```

- [ ] **Step 7: Add the browser guard**

Append to `e2e/rolodex-layout.spec.ts`:

```ts
// The map's labels lived only in <title>, so on touch it was a field of
// identical dots with no text at all.
test('the branch map labels its nodes as text, not only as tooltips', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  await page.evaluate(() => document.querySelector('#minimap')!.classList.remove('collapsed'));
  await page.waitForTimeout(300);
  const labels = await page.locator('#mapBody svg text.nodeLabel').allTextContents();
  expect(labels.length, 'every node should carry a text label').toBeGreaterThan(1);
  expect(labels.every((l) => l.trim().length > 0)).toBe(true);
  expect(labels.every((l) => l.length <= 10), `labels over 10 chars: ${labels}`).toBe(true);
});
```

- [ ] **Step 8: Run both suites**

Run: `npm test` — expect the 2 known pre-existing `agent-customization-wording` failures and no others. The pass count keeps growing as this slice adds tests, so treat the *number* as whatever the controller states as your inherited baseline, not as a fixed 283.
Run: `npx playwright test` — expected 20/20.

- [ ] **Step 9: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs scripts/nd-mem-rolodex.html test/rolodex-helpers.test.mjs e2e/rolodex-layout.spec.ts
git commit -m "fix(rolodex): give the branch map labels a thumb can read"
```

---

### Task 3: Outer-card affordance chevron

An outer card is `opacity:.55` with its `.actions` hidden — zero signal that it does anything. Clicking one already centres-then-dives; the chevron only says so.

**Files:**
- Modify: `scripts/nd-mem-rolodex.html:58-59` (add rules after `.card3d.front`)
- Test: `e2e/rolodex-layout.spec.ts` (CSS-only change; no unit test applies)

**Interfaces:**
- Consumes: `.card3d` / `.card3d.front` class contract from `buildDrum` and `updateFrontCard` (existing).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to `e2e/rolodex-layout.spec.ts`. This is the single most important guard in the slice — it fails the moment the chevron becomes a real hit target:

```ts
// Outer cards carry no interactive signal at all. The fix is a chevron that is
// a SIGN, not a control: Chromium cannot hit-test 3D-rotated cards, so a real
// element here would swallow the click that dives.
test('outer cards show a chevron that never steals the click', async ({ page }) => {
  const marker = await page.evaluate(() => {
    const card = document.querySelector('#drum .card3d:not(.front)');
    if (!card) return null;
    const after = getComputedStyle(card, '::after');
    return { content: after.content, pointerEvents: after.pointerEvents };
  });
  expect(marker, 'a non-front card should exist to carry the affordance').not.toBeNull();
  expect(marker!.content).not.toBe('none');
  expect(marker!.pointerEvents, 'the chevron must never be a hit target').toBe('none');

  // The front card must NOT carry it — it has real buttons instead.
  const frontContent = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#drum .card3d.front')!, '::after').content);
  expect(frontContent).toBe('none');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test -g "outer cards show a chevron"`
Expected: FAIL — `expect(received).not.toBe('none')` because no `::after` exists yet.

- [ ] **Step 3: Write minimal implementation**

In `scripts/nd-mem-rolodex.html`, add immediately after the `.card3d.front` rule at `:59`:

```css
    /* A sign, not a control. Chromium cannot hit-test a 3D-rotated card —
       pointer events AND elementFromPoint both return #scene — which is why
       every real button lives on .card3d.front only. A pseudo-element adds no
       node to hit, and pointer-events:none makes that belt-and-braces. The
       whole card is already clickable (routeGesture clickOther =>
       centerThenDive); this just admits it. */
    .card3d:not(.front)::after{content:'›';position:absolute;right:16px;bottom:12px;
      font-size:1.5rem;line-height:1;color:var(--faint);pointer-events:none}
    .card3d{cursor:pointer}
    @media (hover:hover){.card3d:not(.front):hover{opacity:.75}}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test -g "outer cards show a chevron"`
Expected: PASS on both projects.

- [ ] **Step 5: Verify the click still dives**

The existing `diveToMemories` helper clicks the centre card, which does not exercise an outer card. Append a guard that clicks an outer card directly over where the chevron sits:

```ts
test('clicking an outer card on its chevron still centres and dives', async ({ page }) => {
  const before = await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level);
  const box = await page.evaluate(() => {
    const card = document.querySelector('#drum .card3d:not(.front)');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    // Bottom-right corner, where the ::after is drawn.
    return { x: r.right - 20, y: r.bottom - 16, w: r.width };
  });
  test.skip(!box || box.w < 20, 'no outer card is presented flat enough to click at this viewport');
  await page.mouse.click(box!.x, box!.y);
  await page.waitForTimeout(1700);
  const after = await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level);
  expect(after, 'the chevron swallowed the click instead of the card taking it').not.toBe(before);
});
```

Run: `npx playwright test -g "still centres and dives"`
Expected: PASS.

- [ ] **Step 6: Run both suites**

Run: `npm test` — 283 pass / 2 known failures (unchanged; this task touches no JS).
Run: `npx playwright test` — expected 24/24.

- [ ] **Step 7: Commit**

```bash
git add scripts/nd-mem-rolodex.html e2e/rolodex-layout.spec.ts
git commit -m "fix(rolodex): make outer cards look as clickable as they are"
```

---

### Task 4: The location band

Three pills compete to answer "where am I" and none wins; `#levelName` prints the depth a second time. They collapse into one band. **This task edits two existing browser tests** whose assertions encode the old structure.

**Files:**
- Modify: `scripts/nd-mem-rolodex.html:34` (delete `#levelName` style), `:37-43` (`#crumb` restyle), `:92` + `:144` + `:156` (minimap offsets), `:161-176` (markup), `:215` (element map), `:532-558` (`updateChrome`)
- Modify: `e2e/rolodex-layout.spec.ts:64`, `:71`, `:83`, `:136` (assertions encoding the old structure)
- Test: `e2e/rolodex-layout.spec.ts`

**Interfaces:**
- Consumes: `H.coordinateOf(view, depth, centeredId) => [{kind, text, target}]` (existing, **unchanged** — the `⌂` is prefixed in the view layer so the helper and its unit tests stay untouched).
- Produces: `#locus` (the band), `#crumb` (segments, id retained), `#position` (count, id retained, format now `card N of M`). `#levelName` no longer exists.

**Simplification worth knowing:** the spec's "truncate leftmost segments first" rule is not needed. `coordinateOf` returns **at most four** segments (depth, project, district, leaf) regardless of how deep `0^N` goes, so a wrapping band reaches two lines in the worst realistic case and never has to drop anything. Per-segment ellipsis remains only as a guard against one pathologically long id.

- [ ] **Step 1: Write the failing test**

Append to `e2e/rolodex-layout.spec.ts`:

```ts
// Location was split across #crumb, #levelName and #position -- three identical
// pills, none dominant -- and 0^N was printed twice. One band, one answer.
test('one band owns the location, and says the depth once', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  const band = await page.evaluate(() => {
    const locus = document.querySelector('#locus');
    return {
      exists: !!locus,
      text: (locus?.textContent ?? '').trim(),
      levelNameGone: !document.querySelector('#levelName'),
      segments: [...document.querySelectorAll('#crumb .seg')].map((s) => s.textContent!.trim()),
    };
  });
  expect(band.exists).toBe(true);
  expect(band.levelNameGone, '#levelName should be deleted, not hidden').toBe(true);
  expect(band.segments.length).toBeGreaterThan(1);
  expect(band.segments[0]).toMatch(/^⌂ 0\^\d+$/);
  // The depth must appear exactly once across the whole band.
  expect((band.text.match(/0\^\d+/g) ?? []).length).toBe(1);
});

test('the location band wraps instead of escaping a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => {
    document.querySelector('#position')!.textContent = 'card 124 of 124';
  });
  const fits = await page.evaluate(() => {
    const r = document.querySelector('#locus')!.getBoundingClientRect();
    return { right: r.right, left: r.left, w: window.innerWidth };
  });
  expect(fits.right).toBeLessThanOrEqual(fits.w + 0.5);
  expect(fits.left).toBeGreaterThanOrEqual(-0.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test -g "one band owns the location"`
Expected: FAIL — `expect(band.exists).toBe(true)` receives `false`; `#locus` does not exist.

- [ ] **Step 3: Replace the markup**

In `scripts/nd-mem-rolodex.html`, replace `:161-173`:

```html
  <div id="chrome">
    <div class="cluster">
      <button class="pill" id="backBtn" title="Zoom out (Esc / right-click)">⤺</button>
    </div>
    <div class="cluster">
      <span class="pill" id="connState">Connecting…</span>
      <button class="pill" id="themeBtn" title="Toggle theme">◐</button>
      <a class="pill" href="/">Classic view</a>
    </div>
    <div id="locus"><span id="crumb"></span><span id="position">—</span></div>
  </div>
```

`#levelName` is gone entirely. `#locus` sits inside `#chrome` as a wrapping flex item so there is still exactly one fixed header to measure.

- [ ] **Step 4: Replace the styles**

Delete `#levelName{...}` at `:34`. Replace the `#crumb` block at `:37-43` with:

```css
    /* One band, one answer to "where am I". It is a flex item of #chrome with
       flex-basis:100%, so it always takes its own row without a second fixed
       element to position around. coordinateOf returns at most four segments
       however deep 0^N goes, so wrapping is always enough and nothing is ever
       dropped -- the per-segment ellipsis below only guards one absurd id. */
    #locus{flex:1 1 100%;display:flex;align-items:baseline;gap:10px;min-width:0;pointer-events:auto;
      padding:8px 14px;border-radius:16px;border:1px solid var(--surfaceBorder);
      background:var(--surface);backdrop-filter:blur(10px)}
    #crumb{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:0 2px;
      font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95rem;
      letter-spacing:.02em;color:var(--text)}
    #crumb .seg{background:none;border:0;padding:0 2px;font:inherit;color:var(--muted);cursor:pointer;
      border-radius:4px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #crumb .seg:hover{color:var(--text);background:var(--washStrong)}
    #crumb .seg.depth{color:var(--primary);font-weight:600;white-space:nowrap}
    #crumb .seg.leaf,#crumb .seg:disabled{color:var(--text);cursor:default}
    #crumb .seg:disabled:hover{background:none}
    #crumb .sep{color:var(--faint);padding:0 1px}
    #position{flex:0 0 auto;font-size:.78rem;color:var(--muted);white-space:nowrap}
```

In `@media (max-width:560px)` (`:128-145`) delete `#levelName{display:none}` and the `#crumb{max-width:none;flex:1 1 auto;min-width:0}` rule (both now redundant), and delete `#minimap{top:108px}` entirely.

In `@media (max-height:500px)` (`:151-157`) delete `#levelName{display:none}`; keep `#hudHint{display:none}`; and **narrow `#minimap{top:56px;bottom:48px}` to `#minimap{bottom:48px}`** — the `top` is now measured, but the `bottom` still reclaims landscape space and must survive. Then add the fold-back:

```css
      /* Landscape has width to spare and no height at all: the band goes back
         inline rather than claiming a second row. */
      #locus{flex:1 1 auto;padding:5px 10px}
      #crumb{font-size:.82rem;flex-wrap:nowrap;overflow:hidden}
```

- [ ] **Step 5: Measure the chrome instead of guessing it**

`#minimap` positioned itself with three hand-tuned `top` offsets that each encoded a guess about the bar's height. The band makes it taller and would need a fourth. Change `:92` from `top:64px` to `top:calc(var(--chromeH, 64px) + 8px)`, then add near the element map (`:215`):

```js
    // Three hand-tuned offsets (64/108/56) each encoded a guess at how tall
    // #chrome renders at that breakpoint. The band would have needed a fourth.
    // Measure it once and let CSS read the answer.
    const syncChromeHeight = () => document.documentElement.style
      .setProperty('--chromeH', `${Math.ceil($('#chrome').getBoundingClientRect().height)}px`);
    new ResizeObserver(syncChromeHeight).observe($('#chrome'));
    syncChromeHeight();
```

Remove `levelName: $('#levelName'),` from the `els` object at `:215`.

- [ ] **Step 6: Update `updateChrome`**

Replace `:534` (the `els.levelName.textContent` assignment) — delete it outright. In the segment map at `:538-556`, render the depth badge with its home glyph; change the returned button line from `>${esc(s.text)}<` to:

```js
        // The ⌂ is added here, not in coordinateOf: the helper stays pure text
        // so its unit tests and any non-visual caller are unaffected.
        const label = s.kind === 'depth' ? `⌂ ${s.text}` : s.text;
        return sep + `<button class="seg ${s.kind}" data-seg="${i}"${jumpable ? '' : ' disabled'}>${esc(label)}</button>`;
```

Change the position readout at `:558` from `card ${n} / ${m}` to:

```js
      els.position.textContent = state.items.length ? `card ${state.frontIndex + 1} of ${state.items.length}` : '—';
```

Finally, restore the empty-state wording the old markup carried in `#crumb`'s initial HTML. After the `innerHTML` assignment, add:

```js
      // An empty store has no centered card, so the coordinate collapses to a
      // lone depth badge and the band would read "⌂ 0^0" and nothing else.
      if (segs.length <= 1) els.crumb.innerHTML += '<span class="sep">·</span><span class="seg leaf">All projects</span>';
```

> **Deliberate deviation from spec §1.** The spec says the wall band reads `All projects · N projects`. Implemented literally that is triple redundancy: the coordinate already names the centred project, and `#position` already reads `card 3 of 12` where 12 *is* the project count. So "All projects" survives only as the genuine empty state above, and the count is left to `#position`. Flag this to the user at review rather than silently shipping either version.

- [ ] **Step 7: Update the two existing tests that encode the old structure**

In `e2e/rolodex-layout.spec.ts`:

- `:64` — change the seeded worst-case text from `'card 124 / 124'` to `'card 124 of 124'`.
- `:71` — `chromeBar()` collects `.pill` elements, and `#locus` is deliberately not a pill. Replace `expect(bar.ids).toContain('crumb')` with a direct check that the band is on screen:

```ts
    // The coordinate is the primary navigation aid and must never be the thing
    // dropped. It is no longer a .pill, so assert on the band itself.
    const locus = await page.evaluate(() => {
      const r = document.querySelector('#locus')!.getBoundingClientRect();
      return { onScreen: r.right <= window.innerWidth + 0.5 && r.left >= -0.5, visible: r.width > 0 };
    });
    expect(locus.visible, `the location band vanished at ${vp.width}x${vp.height}`).toBe(true);
    expect(locus.onScreen, `the location band escaped at ${vp.width}x${vp.height}`).toBe(true);
```

- `:83` — the total is parsed with `/\/\s*(\d+)/`, which the new wording breaks. Change to `/of\s+(\d+)/`. (The sibling `/card\s+(\d+)/` at `:104` still matches and needs no change.)
- `:136` — the reload test reads `#crumb` textContent, which still exists. No change needed, but re-run it: the restore path must survive `#levelName`'s deletion.

- [ ] **Step 8: Run both suites**

Run: `npm test` — expect the 2 known pre-existing `agent-customization-wording` failures and no others. The pass count keeps growing as this slice adds tests, so treat the *number* as whatever the controller states as your inherited baseline, not as a fixed 283.
Run: `npx playwright test` — expected 28/28. Pay attention to `an unexpected reload keeps your place`: it is the guard that nav restore survived this task.

- [ ] **Step 9: Commit**

```bash
git add scripts/nd-mem-rolodex.html e2e/rolodex-layout.spec.ts
git commit -m "fix(rolodex): give location one loud home instead of three quiet ones"
```

---

### Task 5: Stage-edge spin chevrons

Spinning is discoverable only if you already know to scroll or drag. Two real buttons make the drum's spinnability visible and give a thumb a target, routing through the same gesture table the arrow keys use.

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` — markup after `#stage` (`:174`), CSS after `#hud` (`:91`), element map (`:215`), listener near `els.backBtn` (`:1231`), and a call in `updateChrome`
- Test: `e2e/rolodex-layout.spec.ts`

**Interfaces:**
- Consumes: `H.routeGesture(kind, ctx) => 'stepPrev' | 'stepNext' | ...` and the page's existing `stepBy(delta)` (used at `:1228-1229`), `state.items`, `state.transitioning`.
- Produces: `#spin`, `#spinPrev`, `#spinNext`. The `#spin` grid reserves the vertical axis for the deferred floor chevrons.

- [ ] **Step 1: Write the failing test**

Append to `e2e/rolodex-layout.spec.ts`:

```ts
// Spinning was discoverable only if you already knew to scroll or drag.
test('an edge chevron advances the selection by exactly one', async ({ page }) => {
  const at = () => page.evaluate(() =>
    Number((document.querySelector('#position')!.textContent!.match(/card\s+(\d+)/) ?? [])[1] ?? 0));
  const total = await page.evaluate(() =>
    Number((document.querySelector('#position')!.textContent!.match(/of\s+(\d+)/) ?? [])[1] ?? 0));
  test.skip(total < 2, 'needs at least two cards to step between');
  const before = await at();
  await page.locator('#spinNext').click();
  await page.waitForTimeout(600);
  const after = await at();
  const forward = ((after - before) + total) % total;
  expect(forward, `expected one step forward, got ${before} -> ${after}`).toBe(1);

  await page.locator('#spinPrev').click();
  await page.waitForTimeout(600);
  expect(await at()).toBe(before);
});

test('the spin controls stay on screen and clear of the cards', async ({ page }) => {
  for (const vp of [{ width: 393, height: 852 }, { width: 852, height: 393 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(200);
    const geom = await page.evaluate(() => {
      const b = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const prev = b('#spinPrev'), next = b('#spinNext'), front = b('#drum .card3d.front');
      const clear = (r: DOMRect) => !(r.right > front.left + 0.5 && front.right > r.left + 0.5
        && r.bottom > front.top + 0.5 && front.bottom > r.top + 0.5);
      return {
        onScreen: [prev, next].every((r) => r.left >= -0.5 && r.right <= window.innerWidth + 0.5
          && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5),
        clearOfCard: clear(prev) && clear(next),
      };
    });
    expect(geom.onScreen, `spin controls escaped at ${vp.width}x${vp.height}`).toBe(true);
    expect(geom.clearOfCard, `spin controls overlapped the card at ${vp.width}x${vp.height}`).toBe(true);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test -g "edge chevron advances"`
Expected: FAIL — locator `#spinNext` resolves to nothing.

- [ ] **Step 3: Add the markup**

In `scripts/nd-mem-rolodex.html`, insert immediately after the `#stage` div (`:174`):

```html
  <div id="spin">
    <button class="pill spinBtn" id="spinPrev" aria-label="Previous card">◀</button>
    <button class="pill spinBtn" id="spinNext" aria-label="Next card">▶</button>
  </div>
```

- [ ] **Step 4: Add the styles**

Insert after the `#hud` rule (`:91`):

```css
    /* A 3x3 grid where only the middle row's outer cells are filled. The middle
       COLUMN's outer rows are deliberately left empty: that is the reserved
       slot for the deferred floor chevrons, so adding them is an insertion
       rather than a relayout. */
    #spin{position:fixed;inset:0;z-index:8;display:grid;grid-template-columns:auto 1fr auto;
      grid-template-rows:1fr auto 1fr;align-items:center;padding:0 10px;pointer-events:none}
    #spin>*{pointer-events:auto}
    #spinPrev{grid-column:1;grid-row:2}
    #spinNext{grid-column:3;grid-row:2}
    #spin.hidden{display:none}
    .spinBtn{font-size:1.05rem;line-height:1;padding:12px 14px}
    /* A phone card is near-full-width, so a side gutter would sit on top of it.
       The bottom row is both clear of the card and where thumbs already are. */
    @media (max-width:560px){
      #spin{inset:auto 0 0 0;display:flex;justify-content:space-between;padding:0 14px 14px}
      #hud{padding:16px 76px}
    }
```

- [ ] **Step 5: Wire the buttons**

Add `spin: $('#spin'), spinPrev: $('#spinPrev'), spinNext: $('#spinNext'),` to the `els` object (`:215`). Then add beside the `els.backBtn` listener (`:1231`):

```js
    // Routed through the shipped gesture table rather than calling stepBy
    // directly, so a tap and an arrow key can never drift apart -- the same
    // reason pointer drags go through classifyDragAxis/routeDragAxis.
    function spinFromButton(kind){
      if (state.transitioning) return;
      const action = H.routeGesture(kind, { level: state.view.level, insideReader: false });
      if (action === 'stepPrev') stepBy(-1);
      else if (action === 'stepNext') stepBy(1);
    }
    els.spinPrev.addEventListener('click', () => spinFromButton('arrowLeft'));
    els.spinNext.addEventListener('click', () => spinFromButton('arrowRight'));
```

In `updateChrome`, after the position readout is set, hide the controls when there is nothing to spin:

```js
      // One card cannot be stepped between, and a lone ◀ ▶ pair implies it can.
      els.spin.classList.toggle('hidden', state.items.length < 2);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx playwright test -g "edge chevron advances"` then `npx playwright test -g "spin controls stay on screen"`
Expected: PASS on both projects.

- [ ] **Step 7: Run both suites**

Run: `npm test` — expect the 2 known pre-existing `agent-customization-wording` failures and no others. The pass count keeps growing as this slice adds tests, so treat the *number* as whatever the controller states as your inherited baseline, not as a fixed 283.
Run: `npx playwright test` — expected 32/32. Re-check `chrome bar keeps every control on screen`: `#spin` is fixed and outside `#chrome`, so it must not have disturbed the bar.

- [ ] **Step 8: Commit**

```bash
git add scripts/nd-mem-rolodex.html e2e/rolodex-layout.spec.ts
git commit -m "feat(rolodex): make the drum's spin visible and tappable"
```

---

### Task 6: Orientation copy and the help panel

Nothing states what the rolodex is. A line at the wall says it; a `?` panel holds the rest, including the `0^N` notation the band deliberately does not explain inline.

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` — `#helpBtn` in the chrome cluster, a `#helpModalBg` modal after `#renameModalBg` (`:202`), CSS for `#wallCopy`, element map, listeners
- Test: `e2e/rolodex-layout.spec.ts`

**Interfaces:**
- Consumes: the existing `.modalbg` / `.modal` markup and the `openModal`/Escape handling at `:1219-1220`; `state.view.level`; `H.hintFor` from Task 1.
- Produces: `#helpBtn`, `#helpModalBg`, `#wallCopy`. Nothing later depends on them.

- [ ] **Step 1: Write the failing test**

Append to `e2e/rolodex-layout.spec.ts`:

```ts
// "Need a little more context as to what we are trying to achieve here as a
// user." Nothing on the page answered that.
test('the wall states what this is, and only at the wall', async ({ page }) => {
  const atWall = await page.locator('#wallCopy').isVisible();
  expect(atWall, 'the root view should carry orienting copy').toBe(true);
  await expect(page.locator('#wallCopy')).toContainText(/spin/i);

  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  expect(await page.locator('#wallCopy').isVisible(),
    'orienting copy must not compete for space at depth').toBe(false);
});

test('the help panel opens, explains the coordinate, and closes on Escape', async ({ page }) => {
  await page.locator('#helpBtn').click();
  await expect(page.locator('#helpModalBg')).toHaveClass(/open/);
  // The band deliberately does not explain 0^N inline; this is where it lives.
  await expect(page.locator('#helpModalBg')).toContainText('0^');
  await page.keyboard.press('Escape');
  await expect(page.locator('#helpModalBg')).not.toHaveClass(/open/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test -g "the wall states what this is"`
Expected: FAIL — `#wallCopy` does not exist, `isVisible()` returns false.

- [ ] **Step 3: Add the markup**

Add the `?` button to the right-hand cluster, before `#themeBtn`:

```html
      <button class="pill" id="helpBtn" title="What is this?" aria-label="What is this?">?</button>
```

Add the wall copy inside `#hud`, so it shares the bottom band with the hint (`:175`):

```html
  <div id="hud"><span class="pill" id="wallCopy">Your memory, as a card drum. Spin to browse projects, open one to go deeper: projects → districts → memories.</span><span class="pill" id="hudHint"></span></div>
```

Add the help modal after `#renameModalBg` closes (`:202`):

```html
  <div class="modalbg" id="helpModalBg">
    <div class="modal">
      <h2>What this is</h2>
      <p class="hint">Every memory you have stored, arranged as a drum of cards. You move through it in three levels — <strong>projects → districts → memories</strong> — and diving past the last one wraps you back to the first.</p>
      <p class="hint"><strong>The location band</strong> at the top is where you are. <code>0^2</code> is your depth: how many times you have dived from the start. Each segment after it is a step you can click to jump straight back to.</p>
      <p class="hint"><strong>The branch map</strong> on the left records every dive this session, including the ones you backed out of. Any node jumps you there, so an abandoned path is never lost.</p>
      <p class="hint" id="helpGestures"></p>
      <div class="foot"><button class="btn primary" id="helpCloseBtn">Got it</button></div>
    </div>
  </div>
```

- [ ] **Step 4: Add the styles**

Add beside the `#hud` rule (`:91`):

```css
    #hud{gap:10px;flex-wrap:wrap}
    /* Shown only at the wall: at depth the card needs the room more than a
       first-timer needs the premise restated. */
    #wallCopy{max-width:min(560px,92vw);text-align:center;line-height:1.5}
    #stage:not([data-level="projects"]) ~ #hud #wallCopy{display:none}
```

Document order after Task 5 is `#stage`, `#spin`, `#hud` — so `~` (general sibling) is required and `+` (adjacent) would silently never match.

- [ ] **Step 5: Wire the panel**

Add `helpBtn: $('#helpBtn'), helpModalBg: $('#helpModalBg'),` to `els`. Then beside the other modal wiring:

```js
    // The gesture line is generated, not written twice: it must agree with the
    // hint bar, and the hint bar is already the single source for that wording.
    els.helpBtn.addEventListener('click', () => {
      $('#helpGestures').textContent = H.hintFor(state.view.level, POINTER_KIND);
      els.helpModalBg.classList.add('open');
    });
    $('#helpCloseBtn').addEventListener('click', () => els.helpModalBg.classList.remove('open'));
    els.helpModalBg.addEventListener('click', (e) => {
      if (e.target === els.helpModalBg) els.helpModalBg.classList.remove('open');
    });
```

Escape already closes any `.modalbg.open` via the handler at `:1219-1220`; no change needed there.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx playwright test -g "the wall states what this is"` then `npx playwright test -g "the help panel opens"`
Expected: PASS.

- [ ] **Step 7: Run both suites**

Run: `npm test` — expect the 2 known pre-existing `agent-customization-wording` failures and no others. The pass count keeps growing as this slice adds tests, so treat the *number* as whatever the controller states as your inherited baseline, not as a fixed 283.
Run: `npx playwright test` — expected 36/36. Re-check `chrome bar keeps every control on screen` at all five viewports: `#helpBtn` is a sixth control in the right-hand cluster and is exactly the kind of addition that overflowed the bar before.

- [ ] **Step 8: Commit**

```bash
git add scripts/nd-mem-rolodex.html e2e/rolodex-layout.spec.ts
git commit -m "feat(rolodex): say what this is, for people who have not seen it"
```

---

## Post-implementation

- [ ] **Device confirmation on the iPhone.** Everything above is measured on desktop engines and Playwright's WebKit, which is tap-only and exposes no CDP — it can gate layout and JS routing but can never answer "would the browser have scrolled or zoomed this natively". Reload the page (it is served from disk per request); restart the bridge only if a server-side file changed.
- [ ] **Update `memory_1655`** (the backlog index) to mark the `#hud` desktop-hints defect closed.
- [ ] **Write the HANDOFF memory** in `practical_execution` per the memory-driven-development workflow.
- [ ] Do **not** push or open a PR until the user asks. PRs target `development`, and the remote is `neurodivergent-memory`, not `origin`.
