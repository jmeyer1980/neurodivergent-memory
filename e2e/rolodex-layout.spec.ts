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

/**
 * Waits until the layout has actually settled after a viewport change, instead
 * of guessing with a fixed timeout. #stage is inset by --chromeH/--hudH, which
 * are written by ResizeObservers, and buildDrum's resize rebuild is debounced
 * 200ms on top of that -- so a flat wait races both. Measuring one occlusion
 * test mid-settle is exactly how a green suite went red on a rerun.
 */
async function settleLayout(page: Page) {
  await page.waitForFunction(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    // #chrome is top-anchored and #hud bottom-anchored, so once the custom
    // properties have landed the stage sits exactly between them.
    return Math.abs(r('#stage').top - r('#chrome').bottom) <= 1.5
      && Math.abs(r('#stage').bottom - r('#hud').top) <= 1.5;
  }, null, { timeout: 5_000 });
  await page.waitForTimeout(250); // then let the debounced buildDrum rebuild land
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
    // Issue #172 grew #position with a search-match suffix, which does not
    // shrink (flex:0 0 auto; white-space:nowrap) -- so the worst case now
    // includes it: a search matching every card at the biggest level.
    await page.evaluate(() => {
      document.querySelector('#position')!.textContent = 'card 124 of 124 · 124 results';
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

// Outer cards carry no interactive signal at all. The fix is an "Open ›"
// label that is a SIGN, not a control: Chromium cannot hit-test 3D-rotated
// cards, so a real element here would swallow the click that dives. (A bare
// `›` shipped first and read as unexplained noise to a first-time viewer --
// the text replaced it, but the hit-test constraint is unchanged.)
test('outer cards show an "Open" label that never steals the click', async ({ page }) => {
  const marker = await page.evaluate(() => {
    const card = document.querySelector('#drum .card3d:not(.front)');
    if (!card) return null;
    const after = getComputedStyle(card, '::after');
    return { content: after.content, pointerEvents: after.pointerEvents };
  });
  expect(marker, 'a non-front card should exist to carry the affordance').not.toBeNull();
  expect(marker!.content).not.toBe('none');
  expect(marker!.content, 'the affordance should read as "Open", not a bare glyph').toContain('Open');
  expect(marker!.pointerEvents, 'the label must never be a hit target').toBe('none');

  // The front card must NOT carry it — it has real buttons instead.
  const frontContent = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#drum .card3d.front')!, '::after').content);
  expect(frontContent).toBe('none');
});

// The existing diveToMemories helper clicks the centre card, which never
// exercises an outer one. Click directly over where the label is drawn to
// prove the pseudo-element is not swallowing the tap meant for the card.
//
// The DOM's first non-front card (ascending neighbour, index 1) is not the
// only outer card rendered: at the root level (20 items -- above
// isFanCount's FAN_MAX_CARDS=4 -- the drum runs in cylinder mode, not a
// fan), the wrap-side neighbour (index 19, front's OTHER neighbour) sits
// only ~18deg off-axis and lands its label's corner on-screen even when the
// ascending neighbour's does not. Scan every rendered outer card for the
// first one whose label corner is actually on-screen, rather than
// hardcoding "the first DOM match" and treating an off-canvas corner as a
// reason to skip: a genuinely clickable candidate is present every run.
test('clicking an outer card on its "Open" label still centres and dives', async ({ page }) => {
  const before = await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level);
  const corners = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#drum .card3d:not(.front)')] as HTMLElement[];
    return cards.map((card) => {
      const r = card.getBoundingClientRect();
      // Bottom-right corner, where the ::after pill is drawn (right:16px,
      // bottom:12px in the stylesheet). -20/-16 lands inside the pill's
      // padding box for both the old bare glyph and the wider "Open ›" pill:
      // the pill only grew leftward and (slightly) taller when the text
      // replaced the glyph, so a point already inset from the corner stays
      // inside it.
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
  expect(after, 'the label swallowed the click instead of the card taking it').not.toBe(before);
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
  // Read the FULL value, not the rendered one: below 560px the context segments
  // are middle-elided for width and carry the untruncated id in `title`.
  // Comparing rendered text would make this test viewport-dependent and would
  // fail on the mobile project for a reason that has nothing to do with jumping.
  const read = () => page.evaluate(() => ({
    level: (document.querySelector('#stage') as HTMLElement).dataset.level,
    segs: [...document.querySelectorAll('#crumb .seg')]
      .map((s) => (s.getAttribute('title') ?? s.textContent ?? '').trim()),
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
// AMENDED once the <=560px middle-elide landed: below that breakpoint the
// context segments are shortened in JS, so the full coordinate no longer NEEDS
// a second line there and asserting one would be asserting the opposite of the
// shipped behaviour. The wrap guard therefore runs just ABOVE the breakpoint,
// where segments are rendered in full and the space is still tight enough to
// force a wrap -- which is exactly where an ellipsis regression would hide.
// The no-ellipsis half still runs at the phone widths too, because that is
// where CSS truncation would be most tempting and most damaging.
test('the location band wraps instead of escaping a narrow viewport', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  for (const vp of [
    { name: 'just above the elide breakpoint', width: 600, height: 800, wraps: true },
    { name: 'narrow desktop', width: 640, height: 700, wraps: true },
    { name: 'small phone portrait', width: 320, height: 568, wraps: false },
    { name: 'narrow landscape (max-height:500px breakpoint)', width: 500, height: 393, wraps: false },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settleLayout(page);
    const wrap = await page.evaluate(() => {
      const segs = [...document.querySelectorAll('#crumb .seg')] as HTMLElement[];
      const lines = new Set(segs.map((s) => Math.round(s.getBoundingClientRect().top)));
      const ellipsised = segs
        .filter((s) => s.scrollWidth > s.clientWidth + 0.5)
        .map((s) => s.textContent);
      return { segCount: segs.length, lineCount: lines.size, ellipsised };
    });
    expect(wrap.segCount, `expected the full coordinate (>1 segment) at ${vp.name}`).toBeGreaterThan(1);
    if (vp.wraps) {
      expect(wrap.lineCount, `the coordinate should wrap onto more than one line at ${vp.name}`).toBeGreaterThan(1);
    }
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
    await settleLayout(page);
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
    await settleLayout(page);
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

// The guard above only ever ran at the WALL -- the most forgiving state there
// is: a 230px card and a coordinate short enough to stay on one line. At depth
// the coordinate is its full `0^N > project > district > leaf`, and on a
// 393px-wide phone that wrapped to FOUR lines, roughly doubling #chrome's
// height. #chrome is fixed and used to sit OVER #stage, so on a real iPhone in
// portrait the band covered most of a memory card and could not be dismissed.
// Reported from the device; the whole-branch review had predicted precisely
// this and it was triaged as out of scope. It was not.
test('the chrome bar stays clear of the card at DEPTH, where the coordinate is longest', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  for (const vp of [{ width: 393, height: 852 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(vp);
    await settleLayout(page);
    const geom = await page.evaluate(() => {
      const b = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const chrome = b('#chrome'), front = b('#drum .card3d.front');
      return {
        overlap: Math.max(0, Math.min(chrome.bottom, front.bottom) - Math.max(chrome.top, front.top)),
        segs: [...document.querySelectorAll('#crumb .seg')].map((s) => s.textContent!.trim()),
        cardTop: front.top, chromeBottom: chrome.bottom,
      };
    });
    expect(geom.segs.length, 'precondition: at depth the coordinate has every segment').toBeGreaterThan(2);
    expect(
      geom.overlap,
      `#chrome covered ${geom.overlap}px of the card at ${vp.width}x${vp.height} `
      + `(chrome ends ${geom.chromeBottom}, card starts ${geom.cardTop}) — segments: ${geom.segs.join(' ')}`,
    ).toBe(0);
  }
});

// The node was a 10px dot; its label sat beside it looking like part of the
// same thing and did nothing. Clicking the LABEL must jump too -- so this test
// deliberately clicks the text, well clear of the circle, and would pass
// vacuously if it clicked the dot.
test('a branch-map label is part of the node it labels, not decoration', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  await page.evaluate(() => {
    const map = document.querySelector('#minimap')!;
    if (map.classList.contains('collapsed')) (document.querySelector('#mapToggle') as HTMLElement).click();
  });
  await page.waitForTimeout(300);

  const target = await page.evaluate(() => {
    // Any node that is not the cursor -- clicking the cursor is a no-op by design.
    const cursorId = (document.querySelector('#mapBody .node.cursor')?.closest('[data-node]') as HTMLElement | null)?.dataset.node;
    const g = [...document.querySelectorAll('#mapBody .nodeG')]
      .find((el) => (el as HTMLElement).dataset.node !== cursorId) as SVGGElement | undefined;
    if (!g) return null;
    const label = g.querySelector('text')!.getBoundingClientRect();
    const dot = g.querySelector('circle')!.getBoundingClientRect();
    return {
      id: (g as unknown as HTMLElement).dataset.node,
      // Centre of the label's own box, and proof it is clear of the dot.
      x: label.x + label.width / 2, y: label.y + label.height / 2,
      clearOfDot: label.x > dot.right,
      labelWidth: label.width,
    };
  });
  expect(target, 'precondition: the map has a non-cursor node with a label').not.toBeNull();
  expect(target!.labelWidth, 'the label should have real width to aim at').toBeGreaterThan(10);
  expect(target!.clearOfDot, 'the click point must be on the label, not the dot').toBe(true);

  const before = await page.locator('#mapToggle').textContent();
  await page.mouse.click(target!.x, target!.y);
  await page.waitForTimeout(1700);
  const after = await page.evaluate(() => ({
    toggle: document.querySelector('#mapToggle')!.textContent,
    cursorId: (document.querySelector('#mapBody .node.cursor')?.closest('[data-node]') as HTMLElement | null)?.dataset.node,
  }));
  expect(after.cursorId, 'clicking the label should move the map cursor to that node').toBe(target!.id);
  expect(after.toggle, 'and the depth readout should follow the jump').not.toBe(before);
});

// The hint bar has always promised "scroll inside the card to read", and on
// desktop that silently did nothing. The page used to hand the wheel back to
// the browser for native scrolling, which never worked here: #drum sits at
// translateZ(-radius) and the front card at +radius (~11,139px at 125 cards),
// so the scroller ends up at an extreme Z inside a preserve-3d subtree and the
// compositor's wheel hit-test -- a different path from elementFromPoint, which
// resolves the reader correctly -- reaches nothing. Nobody noticed while the
// metadata grid left the reader ~20px tall; the card flip made it visible.
//
// DESKTOP ONLY, and this is the one deliberate skip in this suite. Playwright
// refuses mouse.wheel on the mobile-safari project ("Mouse wheel is not
// supported in mobile WebKit") because an iPhone has no wheel -- the capability
// genuinely does not exist there, so this is a platform exclusion rather than a
// guard quietly declining to run on a platform it covers. The touch half of the
// same behaviour is driven by the page's own pointer path and, per this
// project's standing limitation, cannot be reproduced by Playwright's WebKit at
// all (tap-only, no CDP); it stays device-verified.
test('the wheel scrolls the memory text instead of doing nothing', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-safari', 'no wheel input exists on a touch device');
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  const target = await page.evaluate(() => {
    const rs = document.querySelector('#drum .card3d.front .reader-scroll') as HTMLElement | null;
    if (!rs || rs.scrollHeight <= rs.clientHeight) return null;
    const b = rs.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  expect(target, 'precondition: the front memory has more text than fits, so there is something to scroll')
    .not.toBeNull();

  const posBefore = await page.locator('#position').textContent();
  await page.mouse.move(target!.x, target!.y);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    top: (document.querySelector('#drum .card3d.front .reader-scroll') as HTMLElement).scrollTop,
    pos: document.querySelector('#position')!.textContent,
  }));
  expect(after.top, 'the wheel over the reader should scroll the text').toBeGreaterThan(0);
  expect(after.pos, 'the wheel over the reader must NOT spin the drum instead').toBe(posBefore);
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

// "Meta-data continues to be too large for mobile and swallows the real-estate
// available on the cards" / "those meta containers are huge. They really
// don't need to take up so much space in any layout." The fix flips the
// memory card: the front face is the kicker/title/text, the back face is the
// .meta grid + chips, and a TEXT button ("Details" / "Back") swaps between
// them IN PLACE. Deliberately not a 3D rotateY of the visible face -- Chromium
// cannot hit-test a rotated card (pointer events and elementFromPoint both
// resolve to #scene; see cardIndexAtPoint and the "Open" tests above), which
// is exactly why every real control on this page already lives on
// .card3d.front only. A 3D flip would put the Back button on a rotated face.
function frontFaceState(page: Page) {
  return page.evaluate(() => {
    const front = document.querySelector('#drum .card3d.front') as HTMLElement | null;
    if (!front) return null;
    // Rendered size, not the element's OWN computed `display`: Details/Back
    // are hidden via their PARENT (.front-actions/.back-actions) going
    // display:none, and getComputedStyle on a child never reflects an
    // ancestor's display:none -- only actual layout (a zero-size box) does.
    const shown = (sel: string) => {
      const el = front.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return {
      flipped: front.classList.contains('flipped'),
      readerShown: shown('.reader-scroll'),
      metaShown: shown('.meta'),
      chipsShown: shown('.card-chips'),
      detailsShown: shown('[data-flip="open"]'),
      backShown: shown('[data-flip="close"]'),
    };
  });
}

test('the metadata is not on the front face by default', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  const s = await frontFaceState(page);
  expect(s, 'a front memory card should exist').not.toBeNull();
  expect(s!.flipped, 'a freshly-dived-to card should start unflipped').toBe(false);
  expect(s!.readerShown, 'the memory text should be visible by default').toBe(true);
  expect(s!.metaShown, 'the meta grid should stay hidden until Details is clicked').toBe(false);
  expect(s!.chipsShown, 'the tag chips should stay hidden until Details is clicked').toBe(false);
  expect(s!.detailsShown, 'the Details button should be on the front face').toBe(true);
  expect(s!.backShown, 'the Back button should not be visible on the front face').toBe(false);
});

test('clicking Details reveals the meta grid and chips, and Back restores the text', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');

  await page.locator('.card3d.front [data-flip="open"]').click();
  const flipped = await frontFaceState(page);
  expect(flipped, 'the front card should still exist after flipping').not.toBeNull();
  expect(flipped!.flipped, 'the card should record itself as flipped').toBe(true);
  expect(flipped!.metaShown, 'the meta grid should be visible after Details').toBe(true);
  expect(flipped!.chipsShown, 'the tag chips should be visible after Details').toBe(true);
  expect(flipped!.readerShown, 'the memory text should be hidden on the back').toBe(false);
  expect(flipped!.backShown, 'the Back button should be visible on the back').toBe(true);
  expect(flipped!.detailsShown, 'Details should not still be showing on the back').toBe(false);

  await page.locator('.card3d.front [data-flip="close"]').click();
  const restored = await frontFaceState(page);
  expect(restored, 'the front card should still exist after flipping back').not.toBeNull();
  expect(restored!.flipped, 'Back should clear the flipped state').toBe(false);
  expect(restored!.readerShown, 'the memory text should return after Back').toBe(true);
  expect(restored!.metaShown, 'the meta grid should hide again after Back').toBe(false);
  expect(restored!.chipsShown, 'the tag chips should hide again after Back').toBe(false);
});

test('spinning to another card resets the flip to the front', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  // A skip-by-omission here would be silent: without at least two cards there
  // is nothing to spin to, and the whole point of this test never runs. Fail
  // loudly on a degenerate store instead, matching the standing rule used by
  // the edge-chevron test above.
  const total = await page.evaluate(() =>
    Number((document.querySelector('#position')!.textContent!.match(/of\s+(\d+)/) ?? [])[1] ?? 0));
  expect(total, 'needs at least two cards to spin between').toBeGreaterThan(1);

  await page.locator('.card3d.front [data-flip="open"]').click();
  expect((await frontFaceState(page))!.flipped, 'precondition: the card is flipped before spinning').toBe(true);

  await page.locator('#spinNext').click();
  await page.waitForTimeout(1700);
  const next = await frontFaceState(page);
  expect(next, 'a front card should exist after spinning').not.toBeNull();
  expect(next!.flipped, 'a spin to a new card must not carry the flip over').toBe(false);
  expect(next!.readerShown, 'the new front card should show its text, not stale meta').toBe(true);
  expect(next!.metaShown, "the new front card should not inherit the previous card's open meta pane").toBe(false);

  // The one-step step-forward above alone cannot tell "the new card was
  // never flipped to begin with" apart from "leaving front actually clears
  // .flipped" -- a fresh card that was never opened would pass that check
  // either way. Stepping back onto the SAME card that was flipped is the
  // part that actually exercises the reset: DRUM_SLACK (6) keeps a one-step
  // round trip inside the same rendered window, so this is the persisted DOM
  // node the flip was set on, not a freshly rebuilt one that never had a
  // chance to carry the class forward.
  await page.locator('#spinPrev').click();
  await page.waitForTimeout(1700);
  const back = await frontFaceState(page);
  expect(back, 'a front card should exist after stepping back').not.toBeNull();
  expect(back!.flipped, 'the originally-flipped card must not still be flipped once it lost, then regained, front').toBe(false);
  expect(back!.readerShown, 'the re-selected card should show its text again').toBe(true);
  expect(back!.metaShown, "the re-selected card should not still show its earlier-opened meta pane").toBe(false);
});

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

// Creation in context: the pressed card supplies the defaults.
test('long-pressing a district card creates with project and district pre-filled', async ({ page }) => {
  test.slow();
  // Dive once to reach districts.
  const box = page.viewportSize()!;
  await page.mouse.click(box.width / 2, box.height / 2);
  await page.waitForTimeout(1700);
  expect(await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level)).toBe('districts');

  // settleLayout, not a flat wait: the neighbouring Rename test's own comment
  // spells out why measuring a card's rect mid-rebuild is a trap -- the press
  // lands where the card WAS. This test measures a rect too, so it needs the
  // same guarantee.
  await settleLayout(page);

  // Capture WHICH card is being pressed in the same evaluate that measures it,
  // so the assertions below can name it. A district card's <h2> is its id.
  const front = await page.evaluate(() => {
    const f = document.querySelector('#drum .card3d.front') as HTMLElement | null;
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const segs = [...document.querySelectorAll('#crumb .seg')];
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      districtId: (f.querySelector('h2')?.textContent ?? '').trim(),
      projectId: (segs[1]?.getAttribute('title') ?? segs[1]?.textContent ?? '').trim(),
    };
  });
  expect(front, 'a front district card should exist to press').not.toBeNull();
  expect(front!.districtId, 'the pressed card should name a district').not.toBe('');

  await page.mouse.move(front!.x, front!.y);
  await page.mouse.down();
  await page.waitForTimeout(750); // past LONG_PRESS_MS
  await page.mouse.up();
  await page.waitForTimeout(300);

  await expect(page.locator('#editModalBg')).toHaveClass(/open/);
  // Assert the INHERITED values, not merely "not empty". `not.toBe('')` was
  // satisfied by openCreateModal's own `|| 'practical_execution'` fallback, so
  // it passed identically whether the pressed card's context was inherited or
  // dropped on the floor -- and #editProject was never read at all, which is
  // half of what the test's name promises.
  expect(await page.locator('#editDistrict').inputValue(),
    'the modal should inherit the district of the card that was pressed').toBe(front!.districtId);
  expect(await page.locator('#editProject').inputValue(),
    'the modal should inherit the project being stood in').toBe(front!.projectId);
  // The press must not ALSO dive -- the click it would otherwise produce is
  // suppressed, so we are still at districts.
  expect(await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level)).toBe('districts');
});

// A slow, deliberate click on a real control is still an ordinary click -- the
// long-press gesture must not steal it. Rename… lives on the project card
// (the wall level), the one control that sits inside a create-eligible level.
test("long-pressing a project card's Rename control opens rename, not create", async ({ page }) => {
  test.slow();
  // Already at the wall (projects level) on load. settleLayout first: the
  // debounced buildDrum rebuild (see its own comment above) can still be
  // in flight right after load, and measuring the button's rect mid-settle
  // is exactly the trap that comment warns about -- the press would land
  // on wherever the card was BEFORE the rebuild finished, not the button.
  await settleLayout(page);
  const renameBtn = await page.evaluate(() => {
    const btn = document.querySelector('#drum .card3d.front [data-rename]') as HTMLElement | null;
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  expect(renameBtn, 'the front project card should have a Rename control to press').not.toBeNull();

  await page.mouse.move(renameBtn!.x, renameBtn!.y);
  await page.mouse.down();
  await page.waitForTimeout(750); // past LONG_PRESS_MS
  await page.mouse.up();
  await page.waitForTimeout(300);

  await expect(page.locator('#renameModalBg')).toHaveClass(/open/);
  await expect(page.locator('#editModalBg')).not.toHaveClass(/open/);
});

// The gesture arms on the level read at pointerdown but resolves the pressed
// card 500ms later, while a dive holds `transitioning` for ~1400ms and flips
// state.view a third of the way through it. A press begun inside that window
// armed at districts (where a long press means "create") and fired at memories
// (where routeGesture forbids it), opening a create modal over a memory card.
test('a long press begun during a dive does not create at the level it arrives in', async ({ page }) => {
  test.slow();
  const box = page.viewportSize()!;
  await settleLayout(page);
  await page.mouse.click(box.width / 2, box.height / 2); // wall -> districts
  await page.waitForTimeout(1700);
  expect(await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level)).toBe('districts');

  await settleLayout(page);
  await page.mouse.click(box.width / 2, box.height / 2); // districts -> memories, now in flight
  await page.waitForTimeout(300); // inside the 200-700ms window, before state.view flips
  await page.mouse.move(box.width / 2, box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(750); // past LONG_PRESS_MS, so it would fire after the flip
  await page.mouse.up();
  await page.waitForTimeout(1200); // let the rest of the dive land

  expect(await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level),
    'the dive should have completed normally').toBe('memories');
  await expect(page.locator('#editModalBg'),
    'a press armed mid-dive must not open a create modal in the level it lands in').not.toHaveClass(/open/);
});

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
  // THE assertion this test was missing. `lit + dimmed === total` and `lit > 0`
  // are both satisfied by lit === total, dimmed === 0 -- which is exactly what
  // shipped: search_memories returns the whole store at min_score 0, so every
  // card was lit and a query dimmed nothing. Without this line the feature can
  // be completely inert and the suite stays green.
  expect(dimmed, 'a query that matches SOME memories must dim the rest — if nothing dims, search is inert')
    .toBeGreaterThan(0);

  // Clearing restores everything.
  await page.locator('#searchInput').fill('');
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.querySelectorAll('#drum .card3d.search-dim').length)).toBe(0);
});

// The same query means something at every depth: one call, held once,
// re-interpreted one level deeper each time you dive.
test('a search at the wall survives a dive and lights the districts inside', async ({ page }) => {
  test.slow();
  await page.locator('#searchInput').fill('memory');
  await page.waitForTimeout(1200);
  const wall = await page.evaluate(() => ({
    lit: document.querySelectorAll('#drum .card3d.search-hit').length,
    dim: document.querySelectorAll('#drum .card3d.search-dim').length,
  }));
  expect(wall.lit, 'at least one project should contain a match').toBeGreaterThan(0);
  // Counted SEPARATELY from here down. The old version summed hits and dims,
  // which passes just as happily when isLit returns the same answer for every
  // card -- either all lit (what actually shipped) or all dim.
  expect(wall.dim, 'some projects must contain no match at all — otherwise the query discriminates nothing')
    .toBeGreaterThan(0);

  // Dive into the centred card, which the search left in place.
  const box = page.viewportSize()!;
  await page.mouse.click(box.width / 2, box.height / 2);
  await page.waitForTimeout(1700);

  expect(await page.locator('#searchInput').inputValue(), 'the query must survive the dive').toBe('memory');
  const inside = await page.evaluate(() => ({
    lit: document.querySelectorAll('#drum .card3d.search-hit').length,
    dim: document.querySelectorAll('#drum .card3d.search-dim').length,
    rendered: document.querySelectorAll('#drum .card3d').length,
  }));
  // The named property: the SAME query, re-read one level deeper, lights the
  // districts that contain the match. isLit's district branch returning false
  // for everything fails here; summing the two classes did not.
  expect(inside.lit, 'the districts holding the match should light without re-typing').toBeGreaterThan(0);
  expect(inside.lit + inside.dim, 'every card at the deeper level should be classified').toBe(inside.rendered);
  // Deliberately no `inside.dim > 0`: a project can honestly have a match in
  // every one of its (typically four) districts, so an all-lit district ring is
  // a legitimate answer. The dim assertion that guards against a degenerate
  // "everything lights" belongs at the wall above, where twenty projects give it
  // real margin.
});

// stepBy's search branch: while a query is active, stepping goes hit-to-hit
// rather than one card at a time. It is the largest deviation in this feature
// from the plan's prescribed code, and it shipped untested -- and inert, because
// with every card lit nextLitIndex just returns from + 1 and the branch is
// indistinguishable from ordinary stepping.
//
// Run at the WALL, deliberately. The two viewports do not dive into the same
// bucket (diveToMemories clicks the viewport centre, and the stage is inset by
// the chrome and hud, which are proportionally much taller on a phone), and on
// mobile-safari it lands in a three-card bucket -- which stepBy renders as a
// FAN, and the fan branch returns before the search branch is ever reached. The
// twenty-project wall is a cylinder on both engines and needs no navigation.
test('stepping during a search lands on hits, the short way round', async ({ page }) => {
  test.slow();
  await settleLayout(page);
  // Few enough projects hold a "rolodex" memory that ordinary stepping would
  // almost certainly land in the dark -- which is the whole point. 'memory'
  // lights most of the wall and would let plain stepping pass by luck.
  await page.locator('#searchInput').fill('rolodex');
  await page.waitForTimeout(1500); // 250ms debounce + daemon round trip

  const read = () => page.evaluate(() => {
    const f = document.querySelector('#drum .card3d.front');
    const m = /card (\d+) of (\d+)/.exec(document.querySelector('#position')?.textContent ?? '');
    return {
      card: m ? Number(m[1]) : NaN,
      count: m ? Number(m[2]) : NaN,
      rotation: Number(/rotateY\(([-\d.]+)deg\)/.exec((document.querySelector('#drum') as HTMLElement).style.transform)?.[1] ?? NaN),
      hit: !!f?.classList.contains('search-hit'),
      dim: !!f?.classList.contains('search-dim'),
      lit: document.querySelectorAll('#drum .card3d.search-hit').length,
      dark: document.querySelectorAll('#drum .card3d.search-dim').length,
    };
  });

  // A step eases toward its goal a frame at a time, so read the drum only once
  // its transform has stopped moving; a flat wait sampled mid-ease and reported
  // the card being left rather than the one arrived at. The generous budget is
  // not slack: Playwright's headless WebKit throttles requestAnimationFrame hard
  // enough that a single one-card step measured ~9 seconds to converge, against
  // well under one on desktop Chromium.
  const settleDrum = async () => {
    await page.evaluate(() => { (window as any).__lastDrumTransform = null; });
    await page.waitForFunction(() => {
      const t = (document.querySelector('#drum') as HTMLElement).style.transform;
      const w = window as any;
      if (w.__lastDrumTransform === t) return true;
      w.__lastDrumTransform = t;
      return false;
    }, null, { timeout: 20_000, polling: 300 });
  };

  let prev = await read();
  expect(prev.lit, 'the query should light at least one project').toBeGreaterThan(0);
  expect(prev.dark, 'this test is only meaningful if the query leaves some cards dark').toBeGreaterThan(0);

  // Two steps, not more: with only a couple of lit projects on the wall the
  // second already proves both halves (a long skip, then the short hop back),
  // and every extra step costs the WebKit run another ~9 seconds.
  const advances: number[] = [];
  for (let step = 1; step <= 2; step++) {
    await page.locator('#spinNext').click();
    await settleDrum();
    const now = await read();

    expect(now.hit, `step ${step} should land on a match, not simply the next card along`).toBe(true);
    expect(now.dim, `step ${step} must not leave a dimmed card centred`).toBe(false);
    // The deviation this branch exists for: the goal is computed relative to the
    // CURRENT rotation via shortestDelta, so a drum that has accumulated real
    // turns still takes the short way to a distant hit. Handing rotationForCard's
    // absolute small-range angle straight to stepTarget would spin whole laps.
    expect(Number.isFinite(now.rotation), 'the drum transform should carry a readable rotation').toBe(true);
    expect(Math.abs(now.rotation - prev.rotation),
      `step ${step} took the long way round the drum`).toBeLessThanOrEqual(180.5);

    advances.push(((now.card - prev.card) % now.count + now.count) % now.count);
    prev = now;
  }

  // The assertion ordinary stepping cannot satisfy: at least one of those steps
  // moved by MORE than one card, i.e. it skipped over dark ones. Without it, a
  // wall where the hits happen to sit next to each other would pass on hits
  // alone.
  expect(advances.some(d => d > 1),
    `every step advanced by exactly one card (${advances.join(', ')}) — stepping did not skip the dark cards`).toBe(true);
});

// Issue #172: with exactly one lit card at a level, the step arrow is a
// correct, deliberately-tested no-op (nextLitIndex resolves to the card you
// are already standing on) -- but nothing on screen said so, so a working
// control read as broken. The #position readout's search suffix is the fix.
// This test is anchored on real data, verified against this store with a
// probe script before being written here:
//   'rolodex' lights exactly 2 of the 20 projects -- 'neurodivergent-memory'
//   (index 0, the wall's default centered card on a cold load) and the
//   '(no project)' bucket (index 19, its circular neighbor -- so one
//   hit-to-hit step reaches it directly). Diving into '(no project)' lands on
//   its districts level, where the SAME query lights exactly one district,
//   'logical_analysis', which a fresh dive centers on by default (index 0)
//   -- the single-hit case the issue is about.
test('the position readout reports the match count, staying honest through a single-hit level', async ({ page }) => {
  test.slow();
  await settleLayout(page);

  await page.locator('#searchInput').fill('rolodex');
  await page.waitForTimeout(1200); // 250ms debounce + daemon round trip

  const wallText = await page.locator('#position').textContent();
  expect(wallText, 'the wall should report the 2-project match count')
    .toMatch(/^card 1 of 20 · 2 results$/);

  // Hit-to-hit stepping (pre-existing, unrelated behaviour) hops from index 0
  // directly to its only other lit neighbor, index 19.
  await page.locator('#spinPrev').click();
  // Poll for the exact expected reading rather than a fixed wait: headless
  // WebKit's rAF throttling can leave the drum mid-ease for several real
  // seconds (the neighboring "stepping during a search" test above measured
  // ~9s for one step), so a flat timeout races it on that engine.
  await page.waitForFunction(() =>
    document.querySelector('#position')?.textContent === 'card 20 of 20 · 2 results',
    null, { timeout: 20_000, polling: 300 });
  expect(await page.locator('#position').textContent(),
    'stepping to the other lit project must not change the reported count')
    .toBe('card 20 of 20 · 2 results');

  // Dive via Enter rather than a centre click: state.frontIndex (and this
  // readout) flips to the new card the instant the eased rotation crosses the
  // card boundary, well before the CSS transform finishes visually easing to
  // its target -- clicking in that window hit-tests against the still-mid-
  // flight rotation and can land on a different card entirely (observed on
  // WebKit). dive() reads the front card from state.frontIndex directly, so
  // it is correct the moment the readout above is, with no such race.
  // #spinPrev now holds focus, and Enter on a button activates IT instead of
  // reaching the global dive handler, so focus must move off it first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1700); // two ~700ms zoom halves, plus slack
  expect(await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level))
    .toBe('districts');
  expect(await page.locator('#searchInput').inputValue(), 'the query must survive the dive').toBe('rolodex');

  const districtsText = await page.locator('#position').textContent();
  expect(districtsText, 'a level with exactly one lit card must say so, singular, not "1 results"')
    .toMatch(/^card 1 of \d+ · 1 result$/);

  // THE property this test exists to pin: the arrow really is a no-op here,
  // and the readout must keep explaining that rather than going stale or
  // blank once the (silent, correct, out-of-scope) no-op fires.
  const before = await page.evaluate(() => (document.querySelector('#drum') as HTMLElement).style.transform);
  await page.locator('#spinNext').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => (document.querySelector('#drum') as HTMLElement).style.transform);
  expect(after, 'the single lit card is a correct, deliberate no-op — not something this issue changes')
    .toBe(before);
  expect(await page.locator('#position').textContent(),
    'the count must still read "1 result" after the dead-arrow press, not vanish')
    .toMatch(/^card 1 of \d+ · 1 result$/);
});

test('the match count disappears the moment the query is cleared', async ({ page }) => {
  test.slow();
  await settleLayout(page);
  await page.locator('#searchInput').fill('rolodex');
  await page.waitForTimeout(1200);
  expect(await page.locator('#position').textContent(), 'a precondition: the count must be showing first')
    .toMatch(/ · 2 results$/);

  await page.locator('#searchInput').fill('');
  await page.waitForTimeout(600);
  const cleared = await page.locator('#position').textContent();
  expect(cleared, 'clearing the query must drop the suffix entirely, not freeze it or show "0 results"')
    .not.toContain('result');
  expect(cleared).toMatch(/^card \d+ of 20$/);
});

// window's contextmenu handler predates the search box and only exempted
// modal text fields from its "right-click zooms out" behaviour -- #searchInput
// is a text field that lives outside any modal, so a right-click (or an iOS
// long-press) on it must keep the native menu instead of navigating away
// mid-query.
test('right-clicking the search input does not navigate the drum', async ({ page }) => {
  test.slow();
  expect(await diveToMemories(page)).toBe('memories');
  await page.locator('#searchInput').fill('memory');
  await page.waitForTimeout(1200);

  await page.locator('#searchInput').click({ button: 'right' });
  await page.waitForTimeout(1700); // zoomOut's transitionTo takes two ~700ms halves if it fires

  expect(await page.evaluate(() => (document.querySelector('#stage') as HTMLElement).dataset.level),
    'a right-click in the search box must not zoom the drum out').toBe('memories');
  expect(await page.locator('#searchInput').inputValue(), 'the query must survive a right-click').toBe('memory');
});

// A failed search and a search that matched nothing both arrive as an empty hit
// set and both render as "everything dimmed". Without a check on the response,
// a dead daemon or a store the bridge refuses to serve looked exactly like an
// honest miss -- silently, and with the coordinate still hidden behind the query.
test('a failing search says so instead of looking like no matches', async ({ page }) => {
  test.slow();
  // Shaped like the route's real failure: HTTP 500 carrying ok:false, which is
  // why res.ok alone would not have caught it.
  await page.route('**/search?*', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: 'daemon unreachable', query: 'memory' }),
  }));

  await page.locator('#searchInput').fill('memory');
  await page.waitForTimeout(1200); // 250ms debounce + the round trip

  await expect(page.locator('#toast')).toHaveClass(/show/);
  expect(await page.locator('#toast').textContent()).toMatch(/search failed/i);
  // And it must not silently classify the drum off an empty result set.
  expect(await page.evaluate(() => document.querySelectorAll('#drum .card3d.search-dim').length),
    'a failed search must not dim the whole drum as though nothing matched').toBe(0);
});

// A bridge process is long-lived; the page is served fresh from disk on every
// request. A bridge that was started before /search landed answers with
// Express's own default 404 -- an HTML page, not our {ok, hits} contract --
// which is a *reachable*, stale bridge, not an unreachable one. Mirrors
// Express's real default body so the regression this pins is the one that
// actually shipped, not a stand-in for it.
//
// The toast must not promise that restarting fixes it, either: a bridge that
// fails to bind its port can linger alive instead of exiting, so a user who
// restarts still has the same stale process answering on the port -- a real
// field case, not a hypothetical. Point at the bridge being out of date, not
// at an action that may not work.
test('a stale bridge (404 on /search) says so, not "could not reach"', async ({ page }) => {
  test.slow();
  await page.route('**/search?*', (route) => route.fulfill({
    status: 404,
    contentType: 'text/html; charset=utf-8',
    body: '<!DOCTYPE html>\n<html lang="en">\n<head><title>Error</title></head>\n<body><pre>Cannot GET /search</pre></body></html>',
  }));

  await page.locator('#searchInput').fill('memory');
  await page.waitForTimeout(1200); // 250ms debounce + the round trip

  await expect(page.locator('#toast')).toHaveClass(/show/);
  const toastText = await page.locator('#toast').textContent();
  expect(toastText, 'a stale bridge must name itself, not read as unreachable').not.toMatch(/could not reach/i);
  expect(toastText, 'a 404 on /search means an old bridge process, not a dead one').toMatch(/bridge/i);
  expect(toastText, 'a restart may not clear a bridge that lingered holding the port -- do not promise it fixes this')
    .not.toMatch(/restart it/i);
  expect(toastText, 'point at the bridge being out of date, since that survives a failed restart attempt')
    .toMatch(/out of date/i);
  // A stale-route response is not evidence the store stopped matching --
  // the previous classification (none yet, here) must stand, not be wiped.
  expect(await page.evaluate(() => document.querySelectorAll('#drum .card3d.search-dim').length),
    'a stale-bridge 404 must not dim the whole drum as though nothing matched').toBe(0);
});

// The genuinely unreachable case -- nothing answered at all -- must keep its
// own wording rather than being folded into the stale-bridge or generic
// failure messages now that all three are told apart.
test('a search with no bridge listening says it could not reach it', async ({ page }) => {
  test.slow();
  await page.route('**/search?*', (route) => route.abort('connectionrefused'));

  await page.locator('#searchInput').fill('memory');
  await page.waitForTimeout(1200); // 250ms debounce + the round trip

  await expect(page.locator('#toast')).toHaveClass(/show/);
  expect(await page.locator('#toast').textContent()).toMatch(/could not reach the bridge/i);
  expect(await page.evaluate(() => document.querySelectorAll('#drum .card3d.search-dim').length),
    'an unreachable bridge must not dim the whole drum as though nothing matched').toBe(0);
});
