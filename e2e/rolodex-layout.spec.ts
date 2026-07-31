import { test, expect, type Page } from '@playwright/test';

/**
 * Guards the invariants that only a real browser can see. Each one here failed
 * in production at least once and was found by clicking, not by node:test.
 */

/** Every pill in the chrome bar, with whether it escaped the viewport. */
async function chromeBar(page: Page) {
  return page.evaluate(() => {
    const chrome = document.querySelector('#chrome')!;
    const shown = (el: Element) => getComputedStyle(el).display !== 'none';
    const pills = [...chrome.querySelectorAll('.pill')].filter(shown).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: (el as HTMLElement).id || (el.textContent ?? '').trim().slice(0, 12),
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        offscreen: r.right > window.innerWidth + 0.5 || r.left < -0.5,
      };
    });
    const overlaps: string[] = [];
    for (let i = 0; i < pills.length; i++) {
      for (let j = i + 1; j < pills.length; j++) {
        const a = pills[i], b = pills[j];
        if (a.right > b.left + 0.5 && b.right > a.left + 0.5 && a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5) {
          overlaps.push(`${a.id} over ${b.id}`);
        }
      }
    }
    return { offscreen: pills.filter((p) => p.offscreen).map((p) => p.id), overlaps, ids: pills.map((p) => p.id) };
  });
}

/** Clicks the centre card until the memories level is reached. */
async function diveToMemories(page: Page) {
  const level = () => page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level);
  const box = page.viewportSize()!;
  for (let i = 0; i < 6 && (await level()) !== 'memories'; i++) {
    await page.mouse.click(box.width / 2, box.height / 2);
    await page.waitForTimeout(1700); // two ~700ms zoom halves, plus slack
  }
  return level();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/rolodex', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#drum .card3d').length > 0, null, { timeout: 15_000 });
});

// The chrome bar wanted 575px of controls against a 393px phone, leaving three
// controls past the right edge and untappable. Landscape then reproduced it at
// ~737-852px, because "narrow" had been treated as the only way to overflow.
for (const vp of [
  { name: 'phone portrait', width: 393, height: 852 },
  { name: 'phone landscape', width: 852, height: 393 },
  { name: 'phone landscape, safe-area inset', width: 737, height: 393 },
  { name: 'small phone', width: 320, height: 568 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  test(`chrome bar keeps every control on screen: ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // Worst realistic content, not whatever the root view happens to show.
    await page.evaluate(() => {
      document.querySelector('#position')!.textContent = 'card 124 of 124';
      document.querySelector('#connState')!.textContent = 'Bridge :3799';
    });
    const bar = await chromeBar(page);
    expect(bar.offscreen, `pills off screen at ${vp.width}x${vp.height}`).toEqual([]);
    expect(bar.overlaps, `pills overlapping at ${vp.width}x${vp.height}`).toEqual([]);
    // The coordinate is the primary navigation aid and must never be the thing
    // dropped. It is no longer a .pill, so assert on the band itself.
    const locus = await page.evaluate(() => {
      const r = document.querySelector('#locus')!.getBoundingClientRect();
      return { onScreen: r.right <= window.innerWidth + 0.5 && r.left >= -0.5, visible: r.width > 0 };
    });
    expect(locus.visible, `the location band vanished at ${vp.width}x${vp.height}`).toBe(true);
    expect(locus.onScreen, `the location band escaped at ${vp.width}x${vp.height}`).toBe(true);
  });
}

// buildDrum used to render every item. The real store has a 364-memory bucket,
// which meant ~9,100 DOM nodes and as many composited 3D layers in one
// innerHTML -- half a second of lag, then the tab's renderer was jettisoned.
test('the drum renders a bounded window regardless of bucket size', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  const stats = await page.evaluate(() => ({
    rendered: document.querySelectorAll('#drum .card3d').length,
    total: Number((document.querySelector('#position')!.textContent!.match(/of\s+(\d+)/) ?? [])[1] ?? 0),
    domNodes: document.querySelectorAll('*').length,
    fronts: document.querySelectorAll('#drum .card3d.front').length,
  }));
  expect(stats.rendered).toBeLessThanOrEqual(25);
  expect(stats.rendered).toBeLessThanOrEqual(stats.total);
  expect(stats.domNodes).toBeLessThan(1000);
  expect(stats.fronts).toBe(1);
});

// Windowing broke the old "DOM child i == item i" assumption in three places.
// Stepping has to keep the selection correct as the window slides, including
// backwards across the wrap from card 0 to card n-1.
test('the selected card stays correct as the window slides, including across the wrap', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  const probe = () => page.evaluate(() => {
    const front = document.querySelector('#drum .card3d.front') as HTMLElement | null;
    const idxs = [...document.querySelectorAll('#drum .card3d')].map((c) => Number((c as HTMLElement).dataset.idx));
    return {
      frontIdx: front ? Number(front.dataset.idx) : -1,
      expected: Number((document.querySelector('#position')!.textContent!.match(/card\s+(\d+)/) ?? [])[1] ?? 0) - 1,
      fronts: document.querySelectorAll('#drum .card3d.front').length,
      rendered: idxs.length,
      frontIsRendered: front ? idxs.includes(Number(front.dataset.idx)) : false,
    };
  });
  for (const [key, steps] of [['ArrowRight', 20], ['ArrowLeft', 40]] as const) {
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(80);
    }
    const s = await probe();
    expect(s.fronts, `exactly one front card after ${key}`).toBe(1);
    expect(s.frontIdx, `front card matches the position readout after ${key}`).toBe(s.expected);
    expect(s.frontIsRendered, `the front card is inside the rendered window after ${key}`).toBe(true);
    expect(s.rendered).toBeLessThanOrEqual(25);
  }
});

// The nav tree used to live only in memory, so any reload -- including the ones
// iOS performs on its own after jettisoning the renderer -- lost the whole
// exploration. It survives now, while a deliberately fresh tab still starts at
// the root.
test('an unexpected reload keeps your place', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100); }
  await page.waitForTimeout(800); // the persist write is coalesced at 500ms

  const where = () => page.evaluate(() => ({
    level: (document.querySelector('#stage') as HTMLElement).dataset.level,
    crumb: document.querySelector('#crumb')!.textContent!.trim(),
    map: document.querySelector('#mapToggle')!.textContent!.trim(),
    position: document.querySelector('#position')!.textContent!.trim(),
  }));
  const before = await where();
  expect(before.map, 'precondition: navigated somewhere with real depth').not.toBe('Map 0^0');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  expect(await where()).toEqual(before);
});

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

// The map's labels lived only in <title>, so on touch it was a field of
// identical dots with no text at all.
test('the branch map labels its nodes as text, not only as tooltips', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  // Narrow viewports default the rail to collapsed, and the render itself is
  // gated behind that class — flipping it directly (bypassing the toggle
  // button) leaves #mapBody never-rendered and empty. Use the real control.
  const collapsed = await page.evaluate(() => document.querySelector('#minimap')!.classList.contains('collapsed'));
  if (collapsed) await page.click('#mapToggle');
  await page.waitForTimeout(300);
  const labels = await page.locator('#mapBody svg text.nodeLabel').allTextContents();
  expect(labels.length, 'every node should carry a text label').toBeGreaterThan(1);
  expect(labels.every((l) => l.trim().length > 0)).toBe(true);
  expect(labels.every((l) => l.length <= 10), `labels over 10 chars: ${labels}`).toBe(true);
});

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

// The existing diveToMemories helper clicks the centre card, which never
// exercises an outer one. Click directly over where the chevron is drawn to
// prove the pseudo-element is not swallowing the tap meant for the card.
//
// The DOM's first non-front card (ascending neighbour, index 1) is not the
// only outer card rendered: at the root level (20 items -- above
// isFanCount's FAN_MAX_CARDS=4 -- the drum runs in cylinder mode, not a
// fan), the wrap-side neighbour (index 19, front's OTHER neighbour) sits
// only ~18deg off-axis and lands its chevron corner on-screen even when the
// ascending neighbour's does not. Scan every rendered outer card for the
// first one whose chevron corner is actually on-screen, rather than
// hardcoding "the first DOM match" and treating an off-canvas corner as a
// reason to skip: a genuinely clickable candidate is present every run.
test('clicking an outer card on its chevron still centres and dives', async ({ page }) => {
  const before = await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level);
  const corners = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#drum .card3d:not(.front)')] as HTMLElement[];
    return cards.map((card) => {
      const r = card.getBoundingClientRect();
      // Bottom-right corner, where the ::after is drawn.
      return { x: r.right - 20, y: r.bottom - 16, w: r.width };
    });
  });
  const vp = page.viewportSize();
  const candidate = vp
    ? corners.find((c) => c.w >= 20 && c.x >= 0 && c.x <= vp.width && c.y >= 0 && c.y <= vp.height)
    : undefined;
  // Last resort only: every rendered outer card's corner is genuinely
  // off-canvas or too edge-on at this viewport. Not expected to trigger on
  // either configured project/viewport pairing.
  test.skip(!candidate, 'no rendered outer card presents an on-screen, flat-enough corner to click at this viewport');
  await page.mouse.click(candidate!.x, candidate!.y);
  await page.waitForTimeout(1700);
  const after = await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level);
  expect(after, 'the chevron swallowed the click instead of the card taking it').not.toBe(before);
});

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

// The design spec's §6 requires "a band segment click jumps back to that
// view". Task 4 rewrote #crumb from a single .pill span into a flex container
// of <button class="seg" data-seg="i"> elements carrying index-based jump-back
// delegation (see the els.crumb click handler), changed the label (prefixing
// "⌂"), and appended a no-data-seg leaf for the empty-store case -- and
// nothing exercised whether the delegation itself still resolves to the right
// place. The reload test above only ever compares textContent, which would
// stay green even if every click silently did nothing. Asserting the
// resulting level AND the project/district identity (not just "something
// changed") is what keeps this from passing vacuously if the wiring breaks.
test('clicking an earlier band segment jumps back to that view', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  const read = () => page.evaluate(() => ({
    level: (document.querySelector('#stage') as HTMLElement).dataset.level,
    segs: [...document.querySelectorAll('#crumb .seg')].map((s) => s.textContent!.trim()),
  }));
  const before = await read();
  expect(before.segs.length, 'precondition: depth + project + district segments are all present').toBeGreaterThanOrEqual(3);
  const projectText = before.segs[1];
  const districtText = before.segs[2];

  // Segment 1 is always the project segment at the memories level -- see
  // H.coordinateOf: depth, then project, then district, then the leaf.
  await page.locator('#crumb .seg[data-seg="1"]').click();
  await page.waitForTimeout(1000);
  const after = await read();

  expect(after.level, 'clicking the project segment should land one level back, at districts').toBe('districts');
  expect(after.segs[1], 'should land back on the SAME project it was clicked from').toBe(projectText);
  expect(after.segs[2], 'should be centred on the SAME district it dived out of, not just any district')
    .toBe(districtText);
});

// An earlier version of this test only checked that
// #locus's own box stayed inside the viewport at the (unnavigated) root level.
// #locus is pinned to its row's width by flex-basis:100%+min-width:0 regardless
// of its children's content, and the root coordinate is the SHORTEST one the app
// ever shows -- so that version could not fail from a wrapping regression; the
// sibling "chrome bar ... small phone" test already covers the same two facts at
// the same viewport. This version instead measures the thing the spec actually
// mandates ("wrap, never ellipsise") on the coordinate's full, real length.
//
// "More than one line" is checked via each segment's own getBoundingClientRect().top
// rather than #crumb.getClientRects().length or #crumb.scrollHeight vs an assumed
// line-height: #crumb is a flex container, and CSS flex-wrap fragments a container
// into multiple FLEX LINES without fragmenting the container's own box the way
// wrapped inline text fragments a <span> -- getClientRects() on a block-level flex
// container reports one rect regardless of how many flex lines it holds, and
// #crumb has no authored line-height to compare scrollHeight against (its height
// is driven by flex content, not text leading). Comparing children's own top
// offsets is a direct, engine-agnostic read of whether a second flex line
// actually rendered.
//
// The second viewport is 500x393, not the suite's usual 737x393 "phone
// landscape, safe-area inset": measured directly, #locus does not share its
// row with the two .cluster pills at 737px -- it wraps to a row of its own and
// flex-grows to ~713px wide, so this store's real coordinate (project + district
// name, ~40-60 chars combined) fits on one line there with or without the
// Finding-1 fix, and 737px cannot exercise the regression at all with real
// data. 500px sits inside both the max-width:560px and max-height:500px
// breakpoints together (a landscape-shaped viewport narrow enough to matter --
// e.g. a compact device or a split-screen pane), and was confirmed by direct
// measurement (both projects) to force a genuine second line with zero
// ellipsis under the fix. Confirmed as a real guard, not just a passing
// assertion, by temporarily reintroducing the old nowrap+overflow:hidden rule
// on #crumb: this test failed on the reintroduced ellipsis at both viewports,
// then passed again once the rule was removed.
test('the location band wraps instead of escaping a narrow viewport', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  for (const vp of [
    { name: 'small phone portrait', width: 320, height: 568 },
    { name: 'narrow landscape (max-height:500px breakpoint)', width: 500, height: 393 },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const wrap = await page.evaluate(() => {
      const segs = [...document.querySelectorAll('#crumb .seg')] as HTMLElement[];
      const lines = new Set(segs.map((s) => Math.round(s.getBoundingClientRect().top)));
      const ellipsised = segs
        .filter((s) => s.scrollWidth > s.clientWidth + 0.5)
        .map((s) => s.textContent);
      return { segCount: segs.length, lineCount: lines.size, ellipsised };
    });
    expect(wrap.segCount, `expected the full coordinate (>1 segment) at ${vp.name}`).toBeGreaterThan(1);
    expect(wrap.lineCount, `the coordinate should wrap onto more than one line at ${vp.name}`).toBeGreaterThan(1);
    expect(wrap.ellipsised, `no segment should be truncated with an ellipsis at ${vp.name}`).toEqual([]);
  }
});

// Spinning was discoverable only if you already knew to scroll or drag.
// A card-width step eases in on a rAF loop (see tick()'s `d * 0.14` decay
// toward state.stepTarget), not on a fixed timer. The brief's prescribed
// `waitForTimeout(600)` converged reliably on desktop-chrome but was measured
// (via a temporary rAF/setInterval tick counter, since removed) to sometimes
// still be mid-ease on mobile-safari's WebKit at 600ms -- the same rotation
// delta rendered visibly fewer frames per wall-clock second there. Rather than
// pick a bigger fixed guess that would still be a guess, poll for the position
// readout to actually reach the target card, so the test's tolerance is
// "however long this browser's compositor needs", not a magic number.
function waitForCard(page: Page, expected: number, label: string) {
  return page.waitForFunction(
    (want) => Number((document.querySelector('#position')!.textContent!.match(/card\s+(\d+)/) ?? [])[1] ?? 0) === want,
    expected,
    { timeout: 5000 },
  ).catch((e) => { throw new Error(`${label}: ${e.message}`); });
}

test('an edge chevron advances the selection by exactly one', async ({ page }) => {
  const at = () => page.evaluate(() =>
    Number((document.querySelector('#position')!.textContent!.match(/card\s+(\d+)/) ?? [])[1] ?? 0));
  const total = await page.evaluate(() =>
    Number((document.querySelector('#position')!.textContent!.match(/of\s+(\d+)/) ?? [])[1] ?? 0));
  // A skip here is a silent no-op: beforeEach only waits for #drum .card3d to
  // be non-empty, so a store with exactly one project would satisfy that and
  // then quietly skip the only behavioural test of this branch's edge-chevron
  // control, every run, forever. Fail loudly instead -- a degenerate dataset
  // should surface as a failing test, not a green run that tested nothing.
  expect(total, 'needs at least two cards to step between').toBeGreaterThan(1);
  const before = await at();
  const expectedNext = before === total ? 1 : before + 1;
  await page.locator('#spinNext').click();
  await waitForCard(page, expectedNext, `expected step to card ${expectedNext}`);
  const after = await at();
  const forward = ((after - before) + total) % total;
  expect(forward, `expected one step forward, got ${before} -> ${after}`).toBe(1);

  await page.locator('#spinPrev').click();
  await waitForCard(page, before, `expected step back to card ${before}`);
  expect(await at()).toBe(before);
});

// The prescribed geometry check compares the buttons against the front card's
// box. On a phone the front card is near-full-width and the buttons move into
// the bottom HUD row (see the max-width:560px rule) rather than sitting beside
// the card in the side gutters -- so "clear of the card" has to be checked
// against where the buttons actually render at each width, not assumed.
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

// Every geometric assertion above this line checks an element against the
// VIEWPORT, never against the card itself -- except the spin-button test just
// above, whose clear(front) overlap check this one reuses for #chrome and
// #hud. That gap is exactly how #wallCopy's five-line wrap at 320x568 (the
// pill's max-width is inert once the surrounding #hud padding narrows its
// line below it) and #hud's grown box at 500x393 both sat on top of the wall
// card without any existing test noticing: chromeBar() only ever looks inside
// #chrome's own .pill children, so it cannot see #hud at all, and nothing
// else measures either bar against the card. These are the two viewports
// where it actually broke.
test('the chrome bar and hud stay clear of the card at the viewports that broke it', async ({ page }) => {
  for (const vp of [{ width: 320, height: 568 }, { width: 500, height: 393 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(200);
    const geom = await page.evaluate(() => {
      const b = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const chrome = b('#chrome'), hud = b('#hud'), front = b('#drum .card3d.front');
      const clear = (r: DOMRect) => !(r.right > front.left + 0.5 && front.right > r.left + 0.5
        && r.bottom > front.top + 0.5 && front.bottom > r.top + 0.5);
      return { chromeClear: clear(chrome), hudClear: clear(hud) };
    });
    expect(geom.chromeClear, `#chrome overlapped the card at ${vp.width}x${vp.height}`).toBe(true);
    expect(geom.hudClear, `#hud overlapped the card at ${vp.width}x${vp.height}`).toBe(true);
  }
});

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
