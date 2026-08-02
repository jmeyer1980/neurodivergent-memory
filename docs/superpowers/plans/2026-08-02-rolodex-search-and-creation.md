# Rolodex Search & Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the rolodex the two capabilities the classic app has and it lacks — finding memories by BM25 relevance, and creating them.

**Architecture:** All new pure logic goes into `scripts/nd-mem-rolodex-helpers.mjs`, which is DOM-free and unit-tested under `node --test`. The bridge gains one read-only route that calls the daemon's `search_memories` and returns structured hits. The page gains a search input, a dim-rendering pass, a `+` control, a create mode on the existing edit modal, and a long-press gesture. Nothing changes in drum geometry or the nav tree.

**Tech Stack:** Vanilla ES modules, no build step for the web apps. `node --test` for unit tests (`npm test`), Playwright for browser tests (`npx playwright test`, projects `desktop-chrome` and `mobile-safari`).

**Spec:** `docs/superpowers/specs/2026-08-02-rolodex-search-and-creation-design.md`

## Global Constraints

- **Branch is `feat/rolodex-search-and-creation`**, based on the merged `development` (`fb13048`). PRs target `development`; the remote is `neurodivergent-memory`, never `origin`.
- **`npm test` is `npm run build && node test-support/run-tests.mjs`** — `node --test` with DEFAULT discovery, which treats everything under `test/` as a test file. Shared test helpers live in `test-support/`, NOT `test/`. Browser specs stay in `e2e/`.
- **Verified baseline before this work:** `npm test` → tests 294 / pass 292 / **fail 2**. Those 2 are pre-existing wording drift in `test/agent-customization-wording.test.mjs`, unrelated. `npx playwright test` → **51 passed / 1 skipped** (the skip is the desktop-only wheel guard; mobile WebKit has no wheel input). Your bar: the same 2 failures and no others, and zero NEW skips.
- **Every new colour uses an existing CSS custom property** (`--text`, `--muted`, `--faint`, `--primary`, `--surface`, `--surfaceBorder`, `--wash`, `--washStrong`, `--cardBase`, `--cardWash`). No literal colours. Check both themes — light is a warm sepia tuned by measuring rendered pixels.
- **Chromium cannot hit-test 3D-rotated cards.** Real controls live only on chrome or `.card3d.front`; anything on a side card resolves through the page's own `cardIndexAtPoint`.
- **`flex-wrap` on `#chrome` is load-bearing at every width.** A phone in landscape is ~737–852px and misses the 560px query.
- **The plan's prescribed code is not pre-verified.** The previous slice found six defects in its own plan — an algorithm that failed the plan's own assertion, an e2e test that never exercised the feature, a wrong geometry claim, a test that could not fail, a mid-animation timeout, and a two-task layout interaction. **Run every test you write and confirm it fails before you make it pass.** If the plan's code is wrong, fix it, keep the intent, and report the deviation with evidence.
- Run `npm test` and `npx playwright test` **in the foreground** before each commit. Do not delegate verification to a background job.

---

# PHASE 1 — CREATION (Tasks 1–3)

Creation is nearly self-contained: `POST /save` already exists and routes to `store_memory`. Phase 1 can ship even if Phase 2 needs another round.

---

### Task 1: Autofill resolver

The pure function that decides what a new memory inherits from where you are standing.

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append after `truncateNodeLabel`)
- Test: `test/rolodex-helpers.test.mjs`

**Interfaces:**
- Consumes: `UNASSIGNED` (already exported from the same file).
- Produces: `createDefaultsFor(view, pressedCard) => { projectId: string|null, district: string|null }`, exported. `view` is `state.view` (`{ level, projectId, districtId }`). `pressedCard` is `null` for the `+` button, or `{ kind: 'project'|'district', id: string }` for a long-press.

- [ ] **Step 1: Write the failing test**

Append to `test/rolodex-helpers.test.mjs`, adding `createDefaultsFor` to the import block at the top:

```js
test('createDefaultsFor inherits nothing at the projects level', () => {
  assert.deepEqual(
    createDefaultsFor({ level: 'projects', projectId: null, districtId: null }, null),
    { projectId: null, district: null },
  );
});

test('createDefaultsFor inherits the project at the districts level', () => {
  assert.deepEqual(
    createDefaultsFor({ level: 'districts', projectId: 'alpha', districtId: null }, null),
    { projectId: 'alpha', district: null },
  );
});

test('createDefaultsFor inherits project and district at the memories level', () => {
  assert.deepEqual(
    createDefaultsFor({ level: 'memories', projectId: 'alpha', districtId: 'logical_analysis' }, null),
    { projectId: 'alpha', district: 'logical_analysis' },
  );
});

test('createDefaultsFor takes a long-pressed project card over the current view', () => {
  assert.deepEqual(
    createDefaultsFor({ level: 'projects', projectId: null, districtId: null }, { kind: 'project', id: 'beta' }),
    { projectId: 'beta', district: null },
  );
});

test('createDefaultsFor takes a long-pressed district card with its parent project', () => {
  assert.deepEqual(
    createDefaultsFor({ level: 'districts', projectId: 'alpha', districtId: null }, { kind: 'district', id: 'vigilant_monitoring' }),
    { projectId: 'alpha', district: 'vigilant_monitoring' },
  );
});

test('createDefaultsFor never inherits the unassigned sentinel as a real project', () => {
  // '(no project)' is a display bucket, not a project id -- storing it would
  // create a literal project named after the placeholder.
  assert.deepEqual(
    createDefaultsFor({ level: 'districts', projectId: UNASSIGNED, districtId: null }, null),
    { projectId: null, district: null },
  );
  assert.deepEqual(
    createDefaultsFor({ level: 'projects', projectId: null, districtId: null }, { kind: 'project', id: UNASSIGNED }),
    { projectId: null, district: null },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `SyntaxError: The requested module ... does not provide an export named 'createDefaultsFor'`

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// What a new memory inherits from where you are standing. The deeper you are,
// the more context it takes -- which is exactly what the coordinate already
// means. A long-pressed card outranks the current view, because pressing a
// specific card is a more explicit statement of intent than standing near it.
//
// UNASSIGNED is a DISPLAY bucket for memories with no project, not a project
// id. Inheriting it would create a real project literally named '(no project)'.
export function createDefaultsFor(view, pressedCard = null) {
  const realProject = (id) => (id && id !== UNASSIGNED ? String(id) : null);

  if (pressedCard && pressedCard.kind === 'project') {
    return { projectId: realProject(pressedCard.id), district: null };
  }
  if (pressedCard && pressedCard.kind === 'district') {
    return { projectId: realProject(view.projectId), district: String(pressedCard.id) };
  }
  if (view.level === 'memories') {
    return { projectId: realProject(view.projectId), district: view.districtId ? String(view.districtId) : null };
  }
  if (view.level === 'districts') {
    return { projectId: realProject(view.projectId), district: null };
  }
  return { projectId: null, district: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS, whole file green.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test` — expect the 2 known `agent-customization-wording` failures and no others.

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): resolve what a new memory inherits from context"
```

---

### Task 2: Create mode on the edit modal

One modal, two modes. Not a second copy — the two apps' near-duplicate modals have already drifted once.

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` — modal markup (~`:367-381`), `openEditModal` (~`:1627`), `submitEdit` (~`:1645`), the `els` map, listener wiring
- Test: `e2e/rolodex-layout.spec.ts`

**Interfaces:**
- Consumes: `H.createDefaultsFor(view, pressedCard)` from Task 1; the existing `POST /save` route, which accepts `{ content, district, tags, intensity, projectId, visibility, epistemicStatus, ... }` and maps them to `store_memory`.
- Produces: `openCreateModal(pressedCard = null)`, and `state.modalMode` which is `'edit'` or `'create'`. Task 3 calls `openCreateModal`.

- [ ] **Step 1: Write the failing test**

Append to `e2e/rolodex-layout.spec.ts`:

```ts
// The rolodex could read, navigate, rename and edit -- but not create. The
// classic app has had a New Card form all along.
test('the + button opens a create modal pre-filled from where you are standing', async ({ page }) => {
  test.slow();
  // At the wall: nothing inherited.
  await page.locator('#createBtn').click();
  await expect(page.locator('#editModalBg')).toHaveClass(/open/);
  expect(await page.locator('#editModalTitle').textContent()).toMatch(/new memory/i);
  expect(await page.locator('#editProject').inputValue()).toBe('');
  await page.locator('#editCancelBtn').click();

  // At memories depth: project AND district inherited.
  expect(await diveToMemories(page)).toBe('memories');
  const where = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('#crumb .seg')];
    return { project: (segs[1]?.getAttribute('title') ?? segs[1]?.textContent ?? '').trim(),
             district: (segs[2]?.getAttribute('title') ?? segs[2]?.textContent ?? '').trim() };
  });
  await page.locator('#createBtn').click();
  await expect(page.locator('#editModalBg')).toHaveClass(/open/);
  expect(await page.locator('#editProject').inputValue()).toBe(where.project);
  expect(await page.locator('#editDistrict').inputValue()).toBe(where.district);
  await page.locator('#editCancelBtn').click();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test -g "the \+ button opens a create modal"`
Expected: FAIL — locator `#createBtn` resolves to nothing.

- [ ] **Step 3: Add the button and give the modal an addressable title**

In `scripts/nd-mem-rolodex.html`, add to the chrome bar's right-hand cluster, immediately before `#helpBtn`:

```html
      <button class="pill" id="createBtn" title="New memory" aria-label="New memory">+</button>
```

Give the modal heading an id so both modes can address it — change `<h2>Edit memory</h2>` in `#editModalBg` to:

```html
      <h2 id="editModalTitle">Edit memory</h2>
```

- [ ] **Step 4: Add create mode**

Add `createBtn: $('#createBtn')` to the `els` object. Then add beside `openEditModal`:

```js
    // One modal, two modes. A second modal would drift from this one exactly as
    // the classic app's copy already drifted from it -- that divergence was a
    // code-review finding, not a hypothetical.
    function openCreateModal(pressedCard = null){
      const defaults = H.createDefaultsFor(state.view, pressedCard);
      state.modalMode = 'create';
      state.editingId = null;
      $('#editModalTitle').textContent = 'New memory';
      $('#editSaveBtn').textContent = 'Create';
      const districts = H.CANONICAL_DISTRICTS;
      $('#editDistrict').innerHTML = districts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      $('#editContent').value = '';
      $('#editDistrict').value = defaults.district || 'practical_execution';
      // Seeded the same way openEditModal does, so submitEdit's "only send a
      // district the user actually chose" guard behaves identically in both modes.
      state.editingDistrict = $('#editDistrict').value;
      $('#editProject').value = defaults.projectId ?? '';
      $('#editVisibility').value = 'private';
      $('#editIntensity').value = '0.5';
      $('#editEpistemic').value = '';
      $('#editTags').value = '';
      $('#editModalBg').classList.add('open');
      $('#editContent').focus();
    }
```

In `openEditModal`, set the mode and restore the labels — add immediately after `state.editingId = m.id;`:

```js
      state.modalMode = 'edit';
      $('#editModalTitle').textContent = 'Edit memory';
      $('#editSaveBtn').textContent = 'Save changes';
```

- [ ] **Step 5: Branch the submit**

Do NOT try to surgically edit the object literal — replace the whole head of
`submitEdit` down to and including the district guard. Read the current function
first, keep every comment already there, and change only what is shown below.

The three differences between modes, and nothing else:

1. `memoryId` is present when editing, absent when creating.
2. In create mode the district is ALWAYS sent — a new memory has no stored
   district to preserve, so the "only send what the user changed" guard that
   protects an edit would silently create it with no district at all.
3. The route is `/save` when creating, `/update` when editing.

```js
    async function submitEdit(){
      const creating = state.modalMode === 'create';
      const content = $('#editContent').value.trim();
      if (!content) { showToast('Content cannot be empty.'); return; }
      const project = $('#editProject').value.trim();
      const district = $('#editDistrict').value;
      const rawIntensity = $('#editIntensity').value.trim();
      const epistemic = $('#editEpistemic').value;

      const body = {
        content,
        visibility: $('#editVisibility').value,
        projectId: project === '' ? null : project,
        tags: $('#editTags').value.split(',').map(s => s.trim()).filter(Boolean),
      };
      if (!creating) body.memoryId = state.editingId;
      // Editing sends a district only when the user actually changed it, so an
      // untouched select cannot silently refile a district-less memory. Creating
      // must always send one -- there is nothing to preserve.
      if (creating || district !== state.editingDistrict) body.district = district;
      if (rawIntensity !== '') {
        const n = Number(rawIntensity);
        if (!Number.isFinite(n) || n < 0 || n > 1) { showToast('Intensity must be a number between 0 and 1.'); return; }
        body.intensity = n;
      }
      if (epistemic) body.epistemicStatus = epistemic;

      const route = creating ? '/save' : '/update';
      let res, data;
      try {
        res = await fetch(`${BRIDGE}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        data = await res.json();
      } catch {
        showToast('Could not reach the bridge — nothing was saved.');
        return;
      }
      if (!res.ok || !data.ok) { showToast(creating ? 'Create failed.' : 'Update failed.'); return; }
      $('#editModalBg').classList.remove('open');
      showToast(creating ? 'Memory created.' : 'Memory updated.');
    }
```

**Check this against the function actually in the file before pasting.** If the
live `submitEdit` does anything this block drops — an extra field, a refresh
call, a `setWritesDisabled` wrapper — keep it. This block shows the mode
branching, not permission to discard whatever else is there.

- [ ] **Step 6: Wire the button**

```js
    els.createBtn.addEventListener('click', () => openCreateModal());
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx playwright test -g "the \+ button opens a create modal"`
Expected: PASS on both projects.

- [ ] **Step 8: Verify the chrome bar survives a seventh control**

Run: `npx playwright test -g "chrome bar keeps every control on screen"`
Expected: PASS at all five viewports. **If this fails, that is a real defect, not a test to adjust** — the bar has overflowed in production before. Report it and stop rather than loosening the assertion.

- [ ] **Step 9: Run both suites and commit**

Run: `npm test` and `npx playwright test` in the foreground.
Expected: `npm test` the 2 known failures; playwright 53 passed / 1 skipped.

```bash
git add scripts/nd-mem-rolodex.html e2e/rolodex-layout.spec.ts
git commit -m "feat(rolodex): create memories, in one modal with two modes"
```

---

### Task 3: Long-press to create in context

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (`routeGesture`), `scripts/nd-mem-rolodex.html` (pointer handlers, CSS)
- Test: `test/rolodex-helpers.test.mjs`, `e2e/rolodex-layout.spec.ts`

**Interfaces:**
- Consumes: `openCreateModal(pressedCard)` from Task 2; the existing `cardIndexAtPoint(clientX, clientY)` and `state.items`.
- Produces: `routeGesture('longPress', ctx)` returning `'create'` or `'none'`.

- [ ] **Step 1: Write the failing unit test**

Append to `test/rolodex-helpers.test.mjs`:

```js
test('routeGesture maps a long press to create, except on memory cards', () => {
  // A memory card is a reading surface; there the gesture belongs to selection.
  assert.equal(routeGesture('longPress', { level: 'projects', insideReader: false }), 'create');
  assert.equal(routeGesture('longPress', { level: 'districts', insideReader: false }), 'create');
  assert.equal(routeGesture('longPress', { level: 'memories', insideReader: false }), 'none');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `routeGesture` returns `'none'` for the projects case (the default branch).

- [ ] **Step 3: Add the gesture**

In `scripts/nd-mem-rolodex-helpers.mjs`, inside `routeGesture`'s switch, add before `default:`:

```js
    // Long-press creates, carrying the pressed card's context. Not at the
    // memories level: there the card is a reading surface and the press belongs
    // to text selection. Right-click is unavailable -- `rightClick` above
    // already means zoomOut -- so this is the only free gesture.
    case 'longPress': return level === 'memories' ? 'none' : 'create';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add the press timer**

In `scripts/nd-mem-rolodex.html`, near the other pointer state (`let pinchStart = 0, dragMoved = 0;`), add:

```js
    // Long-press: 500ms with the pointer essentially still. Cancelled by any
    // real movement, a second pointer, or release -- so it can never fire in the
    // middle of a spin, a pinch, or a reader drag.
    const LONG_PRESS_MS = 500;
    const LONG_PRESS_SLOP_PX = 10;
    let longPressTimer = null;
    function cancelLongPress(){ if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } }
```

In the `pointerdown` handler, after `pressTarget` is set, add:

```js
      cancelLongPress();
      if (pointers.size === 1 && H.routeGesture('longPress', { level: state.view.level, insideReader: false }) === 'create') {
        const px = e.clientX, py = e.clientY;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          // Resolve through the geometric hit-test: Chromium cannot hit-test a
          // rotated side card, so e.target alone would resolve to #scene.
          const idx = cardIndexAtPoint(px, py);
          const item = idx >= 0 ? state.items[idx] : null;
          if (!item) return;
          // Suppress the click that release would otherwise produce, so the
          // press does not also dive into the card it just created from.
          dragMoved = 999;
          openCreateModal({ kind: item.kind, id: item.id });
        }, LONG_PRESS_MS);
      }
```

In the `pointermove` handler, immediately after `dragMoved` is computed, add:

```js
      if (longPressTimer && (Math.abs(e.clientX - dragOrigin.x) > LONG_PRESS_SLOP_PX || Math.abs(e.clientY - dragOrigin.y) > LONG_PRESS_SLOP_PX)) cancelLongPress();
```

In the `pointerup` and `pointercancel` handlers, add `cancelLongPress();` as the first statement. Also cancel when a second pointer arrives — in `pointerdown`, `pointers.size === 1` already gates arming, but an existing timer must die:

```js
      if (pointers.size > 1) cancelLongPress();
```

- [ ] **Step 6: Suppress the iOS callout on card surfaces**

Add to the stylesheet, beside the other `.card3d` rules:

```css
    /* iOS shows a selection callout on a long press. The gesture means "create"
       on project and district cards, so suppress it there -- but NEVER on
       .reader-scroll, whose user-select:text is deliberate and is how a memory
       is read and copied. */
    #stage:not([data-level="memories"]) .card3d{-webkit-touch-callout:none}
```

- [ ] **Step 7: Write the browser guard**

Append to `e2e/rolodex-layout.spec.ts`:

```ts
// Creation in context: the pressed card supplies the defaults.
test('long-pressing a district card creates with project and district pre-filled', async ({ page }) => {
  test.slow();
  // Dive once to reach districts.
  const box = page.viewportSize()!;
  await page.mouse.click(box.width / 2, box.height / 2);
  await page.waitForTimeout(1700);
  expect(await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level)).toBe('districts');

  const front = await page.evaluate(() => {
    const f = document.querySelector('#drum .card3d.front') as HTMLElement | null;
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  expect(front, 'a front district card should exist to press').not.toBeNull();

  await page.mouse.move(front!.x, front!.y);
  await page.mouse.down();
  await page.waitForTimeout(750); // past LONG_PRESS_MS
  await page.mouse.up();
  await page.waitForTimeout(300);

  await expect(page.locator('#editModalBg')).toHaveClass(/open/);
  expect(await page.locator('#editDistrict').inputValue()).not.toBe('');
  // The press must not ALSO dive -- the click it would otherwise produce is
  // suppressed, so we are still at districts.
  expect(await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level)).toBe('districts');
});
```

- [ ] **Step 8: Run the test**

Run: `npx playwright test -g "long-pressing a district card"`
Expected: PASS on both projects.

- [ ] **Step 9: Run both suites and commit**

Run: `npm test` and `npx playwright test` in the foreground.
Expected: `npm test` the 2 known failures; playwright 55 passed / 1 skipped.

```bash
git add scripts/nd-mem-rolodex-helpers.mjs scripts/nd-mem-rolodex.html test/rolodex-helpers.test.mjs e2e/rolodex-layout.spec.ts
git commit -m "feat(rolodex): long-press a project or district to create in context"
```

---

# PHASE 2 — SEARCH (Tasks 4–7)

---

### Task 4: The result parser

The one fragile seam in the design, isolated into a pure function and pinned by a contract test in Task 5.

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs`
- Test: `test/rolodex-helpers.test.mjs`

**Interfaces:**
- Produces: `parseSearchResults(text) => Array<{ id: string, score: number }>`, exported. Order preserved (the daemon already returns them ranked).

- [ ] **Step 1: Write the failing test**

Append to `test/rolodex-helpers.test.mjs`, adding `parseSearchResults` to the import block:

```js
const SEARCH_TEXT = [
  '🔍 Found 2 memories (ranked by BM25 relevance):',
  '• [0.873] memory_123 — Some title (scholar)',
  '  first eighty characters of content…',
  '• [0.412] memory_9 — Another title (merchant)',
  '  more content here',
].join('\n');

test('parseSearchResults recovers id and score, in rank order', () => {
  assert.deepEqual(parseSearchResults(SEARCH_TEXT), [
    { id: 'memory_123', score: 0.873 },
    { id: 'memory_9', score: 0.412 },
  ]);
});

test('parseSearchResults returns nothing for a no-results response', () => {
  assert.deepEqual(parseSearchResults('🔍 No memories found matching query: "zzz"'), []);
});

test('parseSearchResults ignores the did-you-mean suffix', () => {
  const text = SEARCH_TEXT + '\nDid you mean project_id: alpha?';
  assert.deepEqual(parseSearchResults(text).map(h => h.id), ['memory_123', 'memory_9']);
});

test('parseSearchResults ignores the partial-matches block, which also uses bullets', () => {
  // Partial matches are formatted "• candidate (similarity=0.9, field=..., memories=memory_5, ...)".
  // Those bullets carry no [score] prefix and must not be read as hits.
  const text = SEARCH_TEXT +
    '\n\nPartial matches:\n• alpah (similarity=0.833, field=project_id, memories=memory_5, projects=alpha)';
  assert.deepEqual(parseSearchResults(text).map(h => h.id), ['memory_123', 'memory_9']);
});

test('parseSearchResults tolerates junk without throwing', () => {
  assert.deepEqual(parseSearchResults(''), []);
  assert.deepEqual(parseSearchResults(null), []);
  assert.deepEqual(parseSearchResults('completely unrelated text'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — no export named `parseSearchResults`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// search_memories answers in PROSE, for a reader:
//   • [0.873] memory_123 — Some title (scholar)
//     first eighty characters of content…
// There is no structured search API and the BM25 index is private to
// server-main.ts, so the bridge recovers the two tokens it cannot get locally --
// the id and its score -- and hydrates everything else from the snapshot it
// already reads. Deliberately anchored on the "[score] id" shape: the partial-
// matches block below the results uses bullets too, but carries no score, so
// requiring the bracket keeps those out.
//
// This regex is the whole fragile seam in the search feature. Its failure mode
// is SILENT -- zero hits, not an error -- which is why a contract test runs the
// real tool and asserts this still parses it.
const SEARCH_HIT_RE = /^\s*[•*-]\s*\[(\d+(?:\.\d+)?)\]\s*(\S+)\s+—/;

export function parseSearchResults(text) {
  if (typeof text !== 'string' || text === '') return [];
  const hits = [];
  for (const line of text.split('\n')) {
    const m = SEARCH_HIT_RE.exec(line);
    if (!m) continue;
    const score = Number(m[1]);
    if (!Number.isFinite(score)) continue;
    hits.push({ id: m[2], score });
  }
  return hits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): parse search hits out of the daemon's prose"
```

---

### Task 5: The `/search` route and its contract test

**Files:**
- Modify: `scripts/nd-mem-bridge-server.mjs`
- Create: `test/bridge-search-contract.test.mjs`

**Interfaces:**
- Consumes: `parseSearchResults` from Task 4; the existing `runMcpTool(toolName, args)` and `readSnapshot()`.
- Produces: `GET /search?q=…` returning `{ ok: true, query, total, hits: [{ id, score }] }`.

- [ ] **Step 1: Write the failing contract test**

Create `test/bridge-search-contract.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getFreePort, waitForHealth, stopDaemonOnPort } from "../test-support/daemon.mjs";

// The bridge recovers search hits by PARSING the daemon's prose. That contract
// is invisible at runtime -- if the tool's wording changes, the parser silently
// returns zero hits and search just looks broken. This test runs the REAL tool
// against a seeded store and asserts the parser still recovers what it stored,
// so a formatting change fails CI instead of production.
test("the bridge's /search parses what search_memories actually emits", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-search-contract-"));
  const memoryFile = path.join(tempDir, "memories.json");
  const bridgePort = await getFreePort();
  const daemonPort = await getFreePort();

  const bridge = spawn(process.execPath, ["scripts/nd-mem-bridge-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ND_MEM_FILE: memoryFile,
      NEURODIVERGENT_MEMORY_FILE: memoryFile,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      ND_MEM_BRIDGE_PORT: String(bridgePort),
      ND_MEM_BRIDGE_OPEN: "0",
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  bridge.stderr.on("data", (c) => { stderr += c.toString(); });

  try {
    await waitForHealth(`http://127.0.0.1:${bridgePort}/health`);

    // Seed through the bridge's own write path so the daemon indexes it.
    const save = await fetch(`http://127.0.0.1:${bridgePort}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "deployment pipeline rollout checklist", district: "practical_execution" }),
    });
    assert.ok(save.ok, `seed save failed: ${save.status}\n${stderr}`);

    const res = await fetch(`http://127.0.0.1:${bridgePort}/search?q=${encodeURIComponent("deployment")}`);
    assert.ok(res.ok, `search failed: ${res.status}\n${stderr}`);
    const body = await res.json();

    assert.ok(Array.isArray(body.hits), `hits should be an array: ${JSON.stringify(body)}`);
    assert.ok(body.hits.length > 0,
      `THE PARSER RECOVERED NOTHING. Either search_memories' output format changed, or the regex in ` +
      `parseSearchResults no longer matches it. Response: ${JSON.stringify(body)}\n${stderr}`);
    for (const hit of body.hits) {
      assert.match(hit.id, /^memory_/, `hit id should look like a memory id: ${JSON.stringify(hit)}`);
      assert.ok(Number.isFinite(hit.score), `hit score should be a number: ${JSON.stringify(hit)}`);
    }
  } finally {
    bridge.kill();
    await stopDaemonOnPort(daemonPort);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bridge-search-contract.test.mjs`
Expected: FAIL — `/search` 404s, so `res.ok` is false.

- [ ] **Step 3: Add the route**

In `scripts/nd-mem-bridge-server.mjs`, import the parser near the top:

```js
import { parseSearchResults } from './nd-mem-rolodex-helpers.mjs';
```

Add beside the other read routes (after `/memories`):

```js
// READ ONLY. Ranks through the daemon so the UI sees exactly what an agent
// would -- same BM25, same tie-breaks -- rather than a second, divergent
// client-side filter. Only the id and score are parsed out of the tool's prose;
// everything else the UI needs it already has in the snapshot.
app.get('/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) { res.json({ ok: true, query: '', total: 0, hits: [] }); return; }
  try {
    const args = { query };
    if (req.query.district) args.district = String(req.query.district);
    if (req.query.project_id) args.project_id = String(req.query.project_id);
    if (req.query.min_score) args.min_score = Number(req.query.min_score);
    if (req.query.tags) args.tags = String(req.query.tags).split(',').map(s => s.trim()).filter(Boolean);

    const { result } = await runMcpTool('search_memories', args);
    const text = result?.result?.content?.map(c => c?.text).filter(Boolean).join('\n') ?? '';
    const hits = parseSearchResults(text);
    res.json({ ok: true, query, total: hits.length, hits });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error), query });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bridge-search-contract.test.mjs`
Expected: PASS.

**If the parser recovers nothing**, do NOT loosen the assertion. Print the raw `text` the tool returned, compare it against `SEARCH_HIT_RE`, and fix the regex — that is exactly the failure this test exists to surface. Report the real format you observed.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test` — expect the 2 known failures plus this new test passing.

```bash
git add scripts/nd-mem-bridge-server.mjs test/bridge-search-contract.test.mjs
git commit -m "feat(bridge): serve BM25 search, pinned by a format contract test"
```

---

### Task 6: The lit predicate and lit-stepping

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs`
- Test: `test/rolodex-helpers.test.mjs`

**Interfaces:**
- Consumes: `projectOf`, `districtOf`, `deriveMemories` (already exported).
- Produces:
  - `isLit(item, hits, snapshot, view) => boolean` — `item` is `{ id, kind }` where kind is `'project' | 'district' | 'memory'` (exactly the values `itemsForView` emits); `hits` is a `Map<memoryId, score>`; `view` is `state.view`, needed only to scope district matching to the project you are standing in.
  - `nextLitIndex(items, hits, snapshot, view, from, direction) => number` — returns the next lit index in `direction` (`1` or `-1`), wrapping; returns `from + direction` (wrapped) when nothing is lit.

- [ ] **Step 1: Write the failing test**

Append to `test/rolodex-helpers.test.mjs`, adding `isLit` and `nextLitIndex` to the import block. `SNAP` is the fixture already defined at the top of that file:

```js
const WALL = { level: 'projects', projectId: null, districtId: null };
const IN_ALPHA = { level: 'districts', projectId: 'alpha', districtId: null };

test('isLit lights a memory whose own id matched', () => {
  const hits = new Map([['mem_1', 0.9]]);
  assert.equal(isLit({ id: 'mem_1', kind: 'memory' }, hits, SNAP, WALL), true);
  assert.equal(isLit({ id: 'mem_2', kind: 'memory' }, hits, SNAP, WALL), false);
});

test('isLit lights a project containing a hit', () => {
  // mem_1 is project alpha, district practical_execution (see SNAP).
  const hits = new Map([['mem_1', 0.9]]);
  assert.equal(isLit({ id: 'alpha', kind: 'project' }, hits, SNAP, WALL), true);
  assert.equal(isLit({ id: 'beta', kind: 'project' }, hits, SNAP, WALL), false);
});

test('isLit scopes a district to the project you are standing in', () => {
  // THE POINT OF THE view ARGUMENT. District names are shared across projects,
  // not globally unique buckets: SNAP has practical_execution memories under
  // alpha. Standing inside beta, alpha's hit must NOT light beta's
  // same-named district card.
  const hitInAlpha = new Map([['mem_1', 0.9]]);
  assert.equal(
    isLit({ id: 'practical_execution', kind: 'district' }, hitInAlpha, SNAP, IN_ALPHA), true);
  assert.equal(
    isLit({ id: 'practical_execution', kind: 'district' }, hitInAlpha, SNAP,
      { level: 'districts', projectId: 'beta', districtId: null }), false);
  assert.equal(
    isLit({ id: 'vigilant_monitoring', kind: 'district' }, hitInAlpha, SNAP, IN_ALPHA), false);
});

test('isLit lights nothing when there are no hits', () => {
  const none = new Map();
  assert.equal(isLit({ id: 'mem_1', kind: 'memory' }, none, SNAP, WALL), false);
  assert.equal(isLit({ id: 'alpha', kind: 'project' }, none, SNAP, WALL), false);
});

test('nextLitIndex walks to the next lit card and wraps', () => {
  const items = [
    { id: 'mem_1', kind: 'memory' },
    { id: 'mem_2', kind: 'memory' },
    { id: 'mem_3', kind: 'memory' },
  ];
  const hits = new Map([['mem_3', 0.5]]);
  assert.equal(nextLitIndex(items, hits, SNAP, WALL, 0, 1), 2);
  // From the only lit card, forward wraps back to itself.
  assert.equal(nextLitIndex(items, hits, SNAP, WALL, 2, 1), 2);
  assert.equal(nextLitIndex(items, hits, SNAP, WALL, 0, -1), 2);
});

test('nextLitIndex falls back to ordinary stepping when nothing is lit', () => {
  const items = [
    { id: 'mem_1', kind: 'memory' },
    { id: 'mem_2', kind: 'memory' },
  ];
  const none = new Map();
  assert.equal(nextLitIndex(items, none, SNAP, WALL, 0, 1), 1);
  assert.equal(nextLitIndex(items, none, SNAP, WALL, 1, 1), 0);
  assert.equal(nextLitIndex(items, none, SNAP, WALL, 0, -1), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — no exports named `isLit` / `nextLitIndex`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// One rule at every level: a card is lit if IT, or anything inside it, matched.
// That is what turns a search into a drill-down -- query at the wall, see which
// projects light, dive into a lit one, see which districts light -- instead of
// needing a separate results view.
export function isLit(item, hits, snapshot, view = {}) {
  if (!hits || hits.size === 0 || !item) return false;
  if (item.kind === 'memory') return hits.has(item.id);
  const memories = Object.values(snapshot?.memories ?? {});
  if (item.kind === 'project') {
    return memories.some(m => hits.has(m.id) && projectOf(m) === item.id);
  }
  if (item.kind === 'district') {
    // Scoped to the project being viewed. District names are shared across
    // projects, not globally unique buckets -- without this, standing inside
    // project beta would light its practical_execution card because something
    // in ALPHA's practical_execution matched.
    const scope = view.projectId;
    return memories.some(m => hits.has(m.id)
      && districtOf(m) === item.id
      && (scope == null || projectOf(m) === scope));
  }
  return false;
}

// Stepping skips dark cards while a search is active, so a 364-memory bucket
// stays fast. With nothing lit at this level, fall back to ordinary stepping
// rather than refusing to move -- a search that matches nothing here must not
// strand the drum.
export function nextLitIndex(items, hits, snapshot, view, from, direction) {
  const count = items.length;
  if (!count) return from;
  const step = direction >= 0 ? 1 : -1;
  const plain = ((from + step) % count + count) % count;
  if (!hits || hits.size === 0) return plain;
  for (let i = 1; i <= count; i++) {
    const idx = ((from + step * i) % count + count) % count;
    if (isLit(items[idx], hits, snapshot, view)) return idx;
  }
  return plain;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): light a card when it or anything inside it matches"
```

---

### Task 7: Search in the page

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` — markup, CSS, `state`, `updateChrome`, `updateFrontCard`/`buildDrum` render path, `stepBy`
- Test: `e2e/rolodex-layout.spec.ts`

**Interfaces:**
- Consumes: `H.parseSearchResults` (via the bridge, not directly), `H.isLit`, `H.nextLitIndex`; `GET /search`.
- Produces: `state.search = { query: string, hits: Map<string, number> }`.

- [ ] **Step 1: Write the failing test**

Append to `e2e/rolodex-layout.spec.ts`:

```ts
// Search DIMS rather than filtering or reordering: a 3D ring's one advantage
// over a list is that "my card was over there" stays true.
test('search dims non-matches without moving a single card', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');

  const before = await page.evaluate(() => [...document.querySelectorAll('#drum .card3d')]
    .map(c => { const r = c.getBoundingClientRect(); return { idx: (c as HTMLElement).dataset.idx, x: Math.round(r.x), y: Math.round(r.y) }; }));

  // Query a word certain to appear in this store's own memories.
  await page.locator('#searchInput').fill('memory');
  await page.waitForTimeout(1200); // 250ms debounce + daemon round trip

  const after = await page.evaluate(() => [...document.querySelectorAll('#drum .card3d')]
    .map(c => { const r = c.getBoundingClientRect(); return { idx: (c as HTMLElement).dataset.idx, x: Math.round(r.x), y: Math.round(r.y) }; }));
  expect(after, 'search must not move any card').toEqual(before);

  const dimmed = await page.evaluate(() =>
    document.querySelectorAll('#drum .card3d.search-dim').length);
  const lit = await page.evaluate(() =>
    document.querySelectorAll('#drum .card3d.search-hit').length);
  expect(lit + dimmed, 'every rendered card should be classified once a search is active')
    .toBe(after.length);
  expect(lit, 'the query should match at least one memory in this store').toBeGreaterThan(0);

  // Clearing restores everything.
  await page.locator('#searchInput').fill('');
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.querySelectorAll('#drum .card3d.search-dim').length)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test -g "search dims non-matches"`
Expected: FAIL — locator `#searchInput` resolves to nothing.

- [ ] **Step 3: Add the input**

In `scripts/nd-mem-rolodex.html`, inside `#locus`, before `#crumb`:

```html
      <input id="searchInput" type="search" placeholder="Search memories…" autocomplete="off" spellcheck="false" />
```

CSS beside the `#locus` rules:

```css
    /* Shares the band's row. While a query is active the coordinate hides: the
       coordinate answers "where am I", the query answers "what am I looking
       for", and both are rarely needed at once. The row already wraps at every
       width and is already guarded at five viewports. */
    #searchInput{flex:1 1 12rem;min-width:0;padding:4px 10px;border-radius:999px;
      border:1px solid var(--surfaceBorder);background:var(--wash);color:var(--text);
      font:inherit;font-size:.82rem}
    #searchInput::placeholder{color:var(--faint)}
    #locus.searching #crumb{display:none}
    /* Dim the misses; light the hits. Composes with the existing card states
       rather than replacing them -- .front, .flipped and the ::after affordance
       all still apply. */
    .card3d.search-dim{opacity:.25}
    .card3d.search-hit{border-color:var(--primary)}
```

- [ ] **Step 4: Add state and the fetch**

Add to the `state` object:

```js
      search: { query: '', hits: new Map() },
```

Add near the other input wiring:

```js
    // 250ms debounce, and a later query always wins: /search is a daemon round
    // trip, so a call per keystroke would both lag and land out of order.
    let searchTimer = null;
    let searchSeq = 0;
    async function runSearch(query){
      const seq = ++searchSeq;
      if (!query) { state.search = { query: '', hits: new Map() }; renderSearchState(); return; }
      try {
        const res = await fetch(`${BRIDGE}/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (seq !== searchSeq) return; // superseded
        state.search = { query, hits: new Map((data.hits || []).map(h => [h.id, h.score])) };
      } catch {
        if (seq !== searchSeq) return;
        state.search = { query, hits: new Map() };
        showToast('Search could not reach the bridge.');
      }
      renderSearchState();
    }
    els.searchInput.addEventListener('input', () => {
      const q = els.searchInput.value.trim();
      els.locus.classList.toggle('searching', q !== '');
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(q), 250);
    });
    els.searchInput.addEventListener('keydown', (e) => {
      // Escape clears the query. The modal handler owns Escape otherwise and
      // runs first, so this only fires when the input has focus and no modal is open.
      if (e.key === 'Escape') { e.stopPropagation(); els.searchInput.value = ''; els.locus.classList.remove('searching'); clearTimeout(searchTimer); runSearch(''); }
    });
```

Add `searchInput: $('#searchInput'), locus: $('#locus'),` to the `els` object.

- [ ] **Step 5: Render the lit state**

```js
    // Applied to the rendered window only, and re-applied after any rebuild.
    function renderSearchState(){
      const { hits } = state.search;
      els.drum.querySelectorAll('.card3d[data-idx]').forEach((el) => {
        const item = state.items[Number(el.dataset.idx)];
        if (!item || !hits.size) { el.classList.remove('search-dim', 'search-hit'); return; }
        const lit = H.isLit(item, hits, state.snapshot, state.view);
        el.classList.toggle('search-hit', lit);
        el.classList.toggle('search-dim', !lit);
      });
    }
```

Call `renderSearchState()` at the end of `updateFrontCard`, so every rebuild and every front change re-applies it.

- [ ] **Step 6: Make stepping skip dark cards**

In `stepBy`, replace the index computation for the cylinder path. Find:

```js
      const raw = state.frontIndex + n;
```

and precede it with:

```js
      // While a search is active, step hit-to-hit: a 364-memory bucket is not
      // worth spinning through one dark card at a time.
      if (state.search.hits.size) {
        const target = H.nextLitIndex(state.items, state.search.hits, state.snapshot, state.view, state.frontIndex, n > 0 ? 1 : -1);
        state.stepTarget = H.rotationForCard(target, state.layout);
        state.frontIndex = target;
        return;
      }
```

- [ ] **Step 7: Run the test**

Run: `npx playwright test -g "search dims non-matches"`
Expected: PASS on both projects.

- [ ] **Step 8: Add the drill-down guard**

```ts
// The same query means something at every depth: one call, held once,
// re-interpreted one level deeper each time you dive.
test('a search at the wall survives a dive and lights the districts inside', async ({ page }) => {
  test.slow();
  await page.locator('#searchInput').fill('memory');
  await page.waitForTimeout(1200);
  const litProjects = await page.evaluate(() => document.querySelectorAll('#drum .card3d.search-hit').length);
  expect(litProjects, 'at least one project should contain a match').toBeGreaterThan(0);

  // Dive into the centred card, which the search left in place.
  const box = page.viewportSize()!;
  await page.mouse.click(box.width / 2, box.height / 2);
  await page.waitForTimeout(1700);

  expect(await page.locator('#searchInput').inputValue(), 'the query must survive the dive').toBe('memory');
  const stillClassified = await page.evaluate(() =>
    document.querySelectorAll('#drum .card3d.search-hit, #drum .card3d.search-dim').length);
  expect(stillClassified, 'the deeper level should be classified by the same query').toBeGreaterThan(0);
});
```

- [ ] **Step 9: Run both suites and commit**

Run: `npm test` and `npx playwright test` in the foreground.
Expected: `npm test` the 2 known failures; playwright 59 passed / 1 skipped.

```bash
git add scripts/nd-mem-rolodex.html e2e/rolodex-layout.spec.ts
git commit -m "feat(rolodex): search dims the misses and keeps every card in place"
```

---

## Post-implementation

- [ ] **Device confirmation on the iPhone.** Long-press callout suppression and the search input's mobile keyboard cannot be gated by Playwright's WebKit, which is tap-only and exposes no CDP. Reload the page (served from disk per request); restart the bridge only if a server-side file changed.
- [ ] **Update the backlog index** (`memory_1655`) to close the search and creation entries, and mark `memory_1644` / `memory_1664` done.
- [ ] **Write the HANDOFF memory** in `practical_execution`.
- [ ] Do **not** push or open a PR until the user asks. PRs target `development`; the remote is `neurodivergent-memory`.
