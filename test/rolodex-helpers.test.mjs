import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNASSIGNED, UNCATEGORIZED, CANONICAL_DISTRICTS,
  projectOf, districtOf, deriveProjects, deriveDistricts, deriveMemories,
  anglePerCard, drumRadius, normalizeAngle, shortestDelta,
  nearestIndex, rotationForIndex, snapTarget,
  FAN_MAX_CARDS, isFanCount, fanStep, fanSpread, fanRadius, drumLayout,
  panForCard, liftForCard, fanProjectedHalfWidth, FAN_PERSPECTIVE,
  FAN_LIFT_MARGIN, FAN_MIN_CHORD_RATIO,
  rotationForCard, indexAtRotation, snapRotation, clampRotation,
  LEVELS, nextLevel, createHistory, pushView, popView, atWall,
  itemIdsForView, reconcileView, reconcilePop,
  routeGesture,
} from '../scripts/nd-mem-rolodex-helpers.mjs';

// Fixture: alpha has 3 memories in 2 districts, beta has 2 (one custom district),
// one memory has no project and no district.
const SNAP = { nextMemoryId: 7, memories: {
  mem_1: { id: 'mem_1', name: 'Alpha plan',    content: 'plan body',    district: 'practical_execution', project_id: 'alpha', tags: ['kind:plan', 'topic:x'],   created: '2026-07-01T10:00:00Z' },
  mem_2: { id: 'mem_2', name: 'Alpha risk',    content: 'risk body',    district: 'vigilant_monitoring', project_id: 'alpha', tags: ['kind:risk'],              created: '2026-07-02T10:00:00Z' },
  mem_3: { id: 'mem_3', name: 'Alpha insight', content: 'insight body', district: 'practical_execution', project_id: 'alpha', tags: ['kind:insight', 'topic:x'], created: '2026-07-03T10:00:00Z' },
  mem_4: { id: 'mem_4', name: 'Beta note',     content: 'note body',    district: 'weird_custom',        project_id: 'beta',                                    created: '2026-07-04T10:00:00Z' },
  mem_5: { id: 'mem_5', name: 'Loose thought', content: 'loose body',   district: '',                    project_id: '',                                        created: '2026-07-05T10:00:00Z' },
  mem_6: { id: 'mem_6', name: 'Beta more',     content: 'more body',    district: 'logical_analysis',    project_id: 'beta',                                    created: '2026-07-06T10:00:00Z' },
} };

test('projectOf and districtOf apply classic-app fallbacks', () => {
  assert.equal(projectOf({ project_id: 'alpha' }), 'alpha');
  assert.equal(projectOf({ project_id: '' }), UNASSIGNED);
  assert.equal(projectOf({}), UNASSIGNED);
  assert.equal(projectOf({ project_id: null }), UNASSIGNED);
  assert.equal(districtOf({ district: 'logical_analysis' }), 'logical_analysis');
  assert.equal(districtOf({ district: '' }), UNCATEGORIZED);
  assert.equal(districtOf({}), UNCATEGORIZED);
});

test('deriveProjects sorts by count desc, unassigned last, and counts districts', () => {
  const projects = deriveProjects(SNAP);
  assert.deepEqual(projects.map(p => p.id), ['alpha', 'beta', UNASSIGNED]);
  assert.deepEqual(projects.map(p => p.memoryCount), [3, 2, 1]);
  assert.equal(projects[0].districtCount, 2); // alpha: practical_execution + vigilant_monitoring
});

test('deriveDistricts orders canonical districts first, then custom alphabetical, with top tags', () => {
  const alpha = deriveDistricts(SNAP, 'alpha');
  assert.deepEqual(alpha.map(d => d.id), ['practical_execution', 'vigilant_monitoring']);
  assert.equal(alpha[0].memoryCount, 2);
  assert.deepEqual(alpha[0].topTags, ['topic:x', 'kind:insight', 'kind:plan']); // topic:x appears twice
  const beta = deriveDistricts(SNAP, 'beta');
  assert.deepEqual(beta.map(d => d.id), ['logical_analysis', 'weird_custom']);
  const none = deriveDistricts(SNAP, UNASSIGNED);
  assert.deepEqual(none.map(d => d.id), [UNCATEGORIZED]);
});

test('deriveMemories filters by project+district and sorts newest first', () => {
  const mems = deriveMemories(SNAP, 'alpha', 'practical_execution');
  assert.deepEqual(mems.map(m => m.id), ['mem_3', 'mem_1']);
  assert.deepEqual(deriveMemories(SNAP, UNASSIGNED, UNCATEGORIZED).map(m => m.id), ['mem_5']);
  assert.deepEqual(deriveMemories(SNAP, 'alpha', 'creative_synthesis'), []);
});

test('derivations tolerate an empty snapshot', () => {
  assert.deepEqual(deriveProjects({ memories: {} }), []);
  assert.deepEqual(deriveProjects({}), []);
  assert.equal(CANONICAL_DISTRICTS.length, 5);
});

test('anglePerCard and normalizeAngle basics', () => {
  assert.equal(anglePerCard(8), 45);
  assert.equal(anglePerCard(0), 0);
  assert.equal(normalizeAngle(370), 10);
  assert.equal(normalizeAngle(-90), 270);
  assert.equal(normalizeAngle(360), 0);
});

test('drumRadius floors at minRadius and grows with count', () => {
  assert.equal(drumRadius(340, 1), 260);
  assert.equal(drumRadius(340, 2), 260);
  assert.equal(drumRadius(340, 3), 260); // computed ~98 < floor
  const r12 = drumRadius(340, 12);
  assert.ok(r12 > 600 && r12 < 700, `expected ~634, got ${r12}`); // (340/2)/tan(pi/12)
  assert.equal(drumRadius(340, 12, 700), 700);
});

test('shortestDelta picks the short way around', () => {
  assert.equal(shortestDelta(0, 90), 90);
  assert.equal(shortestDelta(0, 270), -90);
  assert.equal(shortestDelta(350, 10), 20);
  assert.equal(shortestDelta(10, 350), -20);
  assert.equal(shortestDelta(0, 180), 180);
});

test('nearestIndex / rotationForIndex / snapTarget agree', () => {
  // 4 cards, theta 90. Card i is centered when rotation ≈ -i*90 (mod 360).
  assert.equal(nearestIndex(0, 4), 0);
  assert.equal(nearestIndex(-90, 4), 1);
  assert.equal(nearestIndex(-100, 4), 1);
  assert.equal(nearestIndex(-44, 4), 0);
  assert.equal(nearestIndex(-46, 4), 1);
  assert.equal(nearestIndex(270, 4), 1); // 270 ≡ -90
  assert.equal(nearestIndex(0, 0), -1);
  assert.equal(rotationForIndex(2, 4), -180);
  // snapTarget stays near the continuous rotation, not the normalized one
  assert.equal(snapTarget(-449, 4), -450);
  assert.equal(snapTarget(-451, 4), -450);
  assert.equal(snapTarget(3601, 4), 3600);
});

test('fan applies to 1-4 cards only', () => {
  assert.equal(FAN_MAX_CARDS, 4);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 12].map(isFanCount), [false, true, true, true, true, false, false]);
});

test('fan angles are symmetric and never exceed 60 degrees', () => {
  for (const n of [1, 2, 3, 4]) {
    const { angles, mode } = drumLayout(340, n);
    assert.equal(mode, 'fan');
    assert.equal(angles.length, n);
    assert.ok(Math.max(...angles.map(Math.abs)) <= 60, `n=${n} exceeded 60deg`);
    // symmetric about 0: first and last are equal and opposite
    assert.ok(Math.abs(angles[0] + angles[n - 1]) < 1e-9, `n=${n} not symmetric`);
  }
  assert.deepEqual(drumLayout(340, 1).angles, [0]);
  assert.deepEqual(drumLayout(340, 2).angles.map(Math.round), [-15, 15]);
  assert.deepEqual(drumLayout(340, 3).angles.map(Math.round), [-24, 0, 24]);
  assert.deepEqual(drumLayout(340, 4).angles.map(Math.round), [-33, -11, 11, 33]);
});

test('a fan keeps every card face-on enough to be a real click target', () => {
  // The end cards of a fan are the ones a user most needs to hit, and clicking is
  // how you both select and dive. At +/-50deg they projected to 123px against the
  // middle card's 316px; the arc is capped much flatter now. cos(angle) is the
  // foreshortening factor, so it is the honest proxy for "how wide does this read".
  for (const n of [2, 3, 4]) {
    const { angles } = drumLayout(340, n);
    const worst = Math.max(...angles.map(Math.abs));
    assert.ok(worst <= 35, `n=${n} spreads to ${worst}deg, too steep to click comfortably`);
    assert.ok(Math.cos(worst * Math.PI / 180) >= 0.8, `n=${n} foreshortens the end card too far`);
  }
});

test('cylinder layout is unchanged from the old uniform math', () => {
  const layout = drumLayout(340, 12);
  assert.equal(layout.mode, 'cylinder');
  assert.equal(layout.step, 30);
  assert.deepEqual(layout.angles.slice(0, 3), [0, 30, 60]);
  assert.equal(layout.radius, drumRadius(340, 12));
  assert.equal(layout.minRotation, -Infinity);
  assert.equal(layout.maxRotation, Infinity);
});

test('fan radius keeps adjacent cards from overlapping, with the 260 floor', () => {
  assert.equal(fanRadius(340, 1), 260);           // single card: floor
  assert.ok(fanRadius(340, 2) > 490, 'two cards need room for a 340px chord');
  assert.ok(fanRadius(340, 4) > fanRadius(340, 2), 'tighter step needs more radius');
  assert.ok(fanRadius(560, 3) > fanRadius(340, 3), 'wider cards need more radius');
  assert.equal(fanRadius(10, 3), 260);            // tiny cards still respect the floor
  // Wide cards would otherwise need a radius that flings the outer cards off the
  // viewport. The old hard-coded cap (a 4th positional maxRadius argument) is gone
  // now that fanRadius is viewport-aware: a tight viewport budget (3rd argument)
  // does the same job, binding the radius below the unconstrained no-overlap ideal.
  const wideIdealRadius = fanRadius(560, 4); // unconstrained: no-overlap ideal
  assert.ok(fanRadius(560, 4, 900) < wideIdealRadius, 'a tight viewport shrinks a wide-card fan below its ideal radius');
  assert.ok(fanRadius(340, 4) < wideIdealRadius, 'a normal card is naturally smaller than a wide-card fan');
});

// The three responses to a narrow viewport are GRADED, not exclusive: shrink the
// arc first, spending up to (1 - FAN_MIN_CHORD_RATIO) of overlap, and pan on top
// of that if even the maximum-overlap arc still overflows. This test used to be
// called "a fan shrinks to fit a narrow viewport before it resorts to panning",
// which read as if a shrunk fan never pans — but its own 340/3 @820 case does
// both, so the name described behaviour the assertions never checked. Renamed,
// and the actual `panning` value pinned at each of the three regimes.
test('a fan that fits does neither; a tight one shrinks; a too-tight one shrinks AND pans', () => {
  const roomy = drumLayout(340, 3, 1600);
  assert.equal(roomy.mode, 'fan');
  assert.equal(roomy.panning, false, 'a fan that fits stays symmetric about centre');
  assert.ok(roomy.pans.every(p => p === 0));
  assert.ok(roomy.overlapRatio <= 0.001, 'and it spends no overlap');

  // Shrinking alone is enough here: the arc tightens, some overlap is spent, and
  // the selected card still fits without any pan.
  const shrunk = drumLayout(340, 3, 1024);
  assert.equal(shrunk.mode, 'fan');
  assert.ok(shrunk.radius < roomy.radius, 'the arc tightens to fit');
  assert.ok(shrunk.overlapRatio > 0, 'which necessarily costs some overlap');
  assert.equal(shrunk.panning, false, 'and at 1024px that alone is enough — no pan');
  assert.ok(shrunk.pans.every(p => p === 0));

  // iPad portrait. Three 340px cards do not fit 820px even at maximum overlap, so
  // this case shrinks to the floor AND pans — the two responses compose.
  const tight = drumLayout(340, 3, 820);
  assert.equal(tight.mode, 'fan');
  assert.ok(tight.radius < shrunk.radius, 'a narrower viewport tightens the arc further');
  assert.ok(tight.overlapRatio > shrunk.overlapRatio, 'spending more overlap to do it');
  assert.ok(tight.overlapRatio <= 1 - FAN_MIN_CHORD_RATIO + 1e-6,
    'but never more overlap than FAN_MIN_CHORD_RATIO permits');
  assert.equal(tight.panning, true, 'and it still overflows at that floor, so it pans too');
});

test('a fan pans so the selection is centred when even the tightest arc overflows', () => {
  const phone = drumLayout(340, 4, 390);
  assert.equal(phone.mode, 'fan');
  assert.equal(phone.panning, true, 'a 4-card fan cannot fit 390px, so it must pan');
  // Panning centres the selected card: the pan for card i cancels its own x offset.
  assert.equal(panForCard(1, phone), phone.pans[1]);
  assert.ok(panForCard(0, phone) > 0, 'the leftmost card pans right to reach centre');
  assert.ok(panForCard(3, phone) < 0, 'the rightmost card pans left');
  assert.ok(Math.abs(panForCard(0, phone) + panForCard(3, phone)) <= 1, 'and the ends mirror');
  // The selected card is lifted, which shifts its own screen-x by lift*sin(angle);
  // the pan must cancel THAT (lifted-radius) offset, not the unlifted one, or the
  // steepest cards land short of centre. Pin the magnitude so this can't regress.
  const steep = phone.angles[0] * Math.PI / 180;
  assert.ok(Math.abs(panForCard(0, phone)) > Math.abs(phone.radius * Math.sin(steep)),
    'the pan must include the lifted radius, not just the base radius');
});

test('the selected card is lifted to a constant depth whatever its angle', () => {
  // The old fixed 40px lift under-compensated: an angled card sat further back
  // than a flat one, so the selection could render smaller than its neighbours.
  const fan = drumLayout(340, 4, 1600);
  const lift = i => liftForCard(i, fan);
  assert.ok(lift(0) > lift(1), 'a steeper card needs more lift to reach the same depth');
  for (let i = 0; i < fan.count; i++) {
    const a = fan.angles[i] * Math.PI / 180;
    const faceZ = (fan.radius + lift(i)) * Math.cos(a) - fan.radius;
    assert.ok(Math.abs(faceZ - 40) < 1.5, `card ${i} face should land at z~40, got ${faceZ}`);
  }
});

test('a cylinder reports zeroed pan and lift so callers stay branch-free', () => {
  const cyl = drumLayout(340, 12, 390);
  assert.equal(cyl.mode, 'cylinder');
  assert.equal(cyl.panning, false);
  assert.equal(panForCard(3, cyl), 0);
  assert.equal(liftForCard(3, cyl), 0);
});

// fanSelectedHalfWidth (internal to helpers.mjs, not exported — measures the
// outermost card's projected half-width AS SELECTED, i.e. lifted) replaced the
// bare-arc fanProjectedHalfWidth inside fanRadius's bisection predicate. The
// bisection's correctness depends entirely on that predicate being monotone in
// radius over the range it searches; re-derive the same formula here (it isn't
// exported, matching the sanctioned diff) and sample it rather than assume.
// The re-derivation below deliberately mirrors helpers.mjs's own formula, so every
// number in it comes from an EXPORTED constant (FAN_LIFT_MARGIN, FAN_MIN_CHORD_RATIO)
// or an exported function (fanSpread, fanStep). Inlining 40 / 0.62 / {2:30,3:48,4:66}
// as literals — as this test originally did — meant a future change to any of those
// constants would leave the test silently validating the OLD formula while the
// implementation moved on, which is the one failure mode a pinning test must not have.
test('fanSelectedHalfWidth is monotone in radius over the range fanRadius bisects', () => {
  const fanSelectedHalfWidth = (radius, count, cardWidth) => {
    const spreadHalf = (fanSpread(count) / 2) * Math.PI / 180;
    const lift = (radius + FAN_LIFT_MARGIN) / Math.cos(spreadHalf) - radius;
    return fanProjectedHalfWidth(radius + lift, count, cardWidth, undefined, radius);
  };
  for (const count of [2, 3, 4]) {
    for (const cardWidth of [340, 560]) {
      const step = fanStep(count);
      const halfChordAngle = Math.sin((step / 2) * Math.PI / 180);
      const floor = (FAN_MIN_CHORD_RATIO * cardWidth) / (2 * halfChordAngle);
      const ideal = cardWidth / (2 * halfChordAngle);
      let prev = -Infinity;
      for (let i = 0; i <= 20; i++) {
        const r = floor + (ideal - floor) * (i / 20);
        const v = fanSelectedHalfWidth(r, count, cardWidth);
        assert.ok(v >= prev - 1e-6,
          `count=${count} cardWidth=${cardWidth}: fanSelectedHalfWidth decreased at r=${r.toFixed(1)} (${v} < ${prev})`);
        prev = v;
      }
    }
  }
});

// The upper-bound regression guard that used to live in the old `fanRadius`
// (a hard `maxRadius` cap) is gone now that the radius is viewport-derived, and
// nothing else pinned an upper bound on how far a selected, lifted end card can
// project. Deciding `panning`/the shrink budget from the BARE arc instead of the
// SELECTED (lifted) card under-estimated the true on-screen extent by up to
// several hundred pixels at wide viewports, silently skipping panning exactly
// when it was needed — this test is the containment guard that would have
// caught it. It derives the outermost card's projected box from only the
// public layout fields (radius, angles, pans, lifts) using the SAME composition
// the renderer's cardIndexAtPoint uses: origin + (pan + x) * scale, pan
// composed with x BEFORE the perspective divide, not added to an
// already-projected screen coordinate.
// WHY THIS SWEEPS EVERY CARD AT EVERY SELECTION, and not just the outermost card
// as selected: this test used to measure only card `count-1`, on the assumption
// that the steepest angle projects furthest. That is true of an UNPANNED fan, but
// false of a panning one, and a panning fan is exactly the case this guard exists
// to protect. In pan mode the drum's translateX cancels the selected card's own x
// offset, so its edges project to
//     localX * cos(a) * P / (P - FAN_LIFT_MARGIN + localX * sin(a))
// whose magnitude peaks at sin(a) = (cardWidth/2) / (P - FAN_LIFT_MARGIN), i.e.
// ~11.9deg -- NOT at the outermost angle. Measured: for cardWidth 560 at count 4
// the +/-11deg card projects 294.9px from centre against the outermost card's
// 272.2px (for 340px cards: 175.7 vs 157.4), so the old single-card guard was
// ~20px looser than its name implied and a regression of that size would pass.
//
// WHY THE REQUIREMENT DIFFERS BY MODE -- this is a deliberate, ruled-on
// distinction, not a loosened bar:
//   * A fan that FITS (panning === false) must show every card fully, at every
//     selection. That is the property Task 13 established, and it still holds
//     whenever the geometry allows it.
//   * A PANNING fan cannot show every card at once -- the cards genuinely span
//     more screen than exists (see the note at the top of the fan section in
//     helpers.mjs: the arc can never be more compact than the same cards laid
//     flat side by side). For it the requirement is that the SELECTED card is
//     fully on screen, which is what panning buys. Simultaneous visibility is
//     the fan's preference; REACHABILITY is its requirement, and reachability
//     follows directly from the selected-card assertion below: card i is fully
//     contained at selection i, so stepping reaches every card. The original
//     field complaint was cards that could neither be seen NOR brought into
//     view by any gesture; that is what must not regress.
// Verified in a driven browser at 1600x1000 and 390x844 (see task-14-report.md):
// the boxes the browser renders match this projection to within a pixel.
test('every card stays within the viewport at every selection, across counts, card widths and common breakpoints', () => {
  const widths = [390, 820, 1024, 1180, 1280, 1366, 1440, 1600, 1920];
  for (const count of [2, 3, 4]) {
    for (const cardWidth of [340, 560]) {
      for (const width of widths) {
        // Out of drumLayout's contract, not a geometry bug: cardWidth is a GIVEN, not
        // something this function may shrink, so a card wider than the viewport cannot
        // be made to fit by any arc/pan/lift choice -- even a single flat, unrotated,
        // perfectly centred card of that width overflows both edges. The page never
        // asks for this: the memories level's cardWidth is always
        // Math.min(560, Math.round(innerWidth*0.92)), which is always < innerWidth.
        // Measured (before this exclusion): the only 3 of 54 combinations that failed
        // were exactly cardWidth=560 at width=390 (count 2/3/4) -- every other
        // combination, including 560 at width=820, passed.
        if (cardWidth > width) continue;
        const layout = drumLayout(cardWidth, count, width);
        const origin = width / 2;
        for (let sel = 0; sel < count; sel++) {
          // One translateX on the drum, chosen by the selection, moves every card
          // together — so the pan is the SELECTED card's pan for all of them.
          const pan = panForCard(sel, layout);
          for (let idx = 0; idx < count; idx++) {
            if (layout.panning && idx !== sel) continue; // see the mode note above
            const a = layout.angles[idx] * Math.PI / 180;
            // The page lifts exactly one card (setCardLift is called with
            // `lifted = (i === idx)`), so only the selected card's radius grows.
            const r = layout.radius + (idx === sel ? liftForCard(idx, layout) : 0);
            // Same composition the renderer and cardIndexAtPoint use:
            // origin + (pan + x) * s, with pan composed with x BEFORE the single
            // perspective divide — not added to an already-projected coordinate.
            const project = (localX) => {
              const x = localX * Math.cos(a) + r * Math.sin(a);
              const z = -localX * Math.sin(a) + r * Math.cos(a) - layout.radius;
              const s = FAN_PERSPECTIVE / (FAN_PERSPECTIVE - z);
              return (pan + x) * s;
            };
            const edges = [project(-cardWidth / 2), project(cardWidth / 2)].map(v => origin + v);
            const left = Math.min(...edges), right = Math.max(...edges);
            assert.ok(left >= -0.5 && right <= width + 0.5,
              `count=${count} cardWidth=${cardWidth} width=${width} panning=${layout.panning} `
              + `selection=${sel} card=${idx}: [${left.toFixed(1)}..${right.toFixed(1)}] must be within 0..${width}`);
          }
        }
      }
    }
  }
});

test('rotationForCard centers each card in both modes', () => {
  for (const n of [1, 2, 3, 4, 7, 12]) {
    const layout = drumLayout(340, n);
    for (let i = 0; i < n; i++) {
      const rot = rotationForCard(i, layout);
      assert.equal(indexAtRotation(rot, layout), i, `mode=${layout.mode} n=${n} i=${i}`);
    }
  }
});

test('fan rotation clamps at the ends; cylinder wraps freely', () => {
  // These angles track FAN_SPREAD_DEG[3] (currently 48, step 24) — if that
  // constant moves, the expected values below must move with it.
  const fan = drumLayout(340, 3);            // angles -24, 0, 24 -> rotation range -24..24
  assert.equal(fan.maxRotation, 24);
  assert.equal(fan.minRotation, -24);
  assert.equal(clampRotation(200, fan), 24);
  assert.equal(clampRotation(-200, fan), -24);
  assert.equal(clampRotation(10, fan), 10);
  // out-of-range rotations still resolve to the end cards, never past them
  assert.equal(indexAtRotation(-999, fan), 2);
  assert.equal(indexAtRotation(999, fan), 0);

  const cyl = drumLayout(340, 12);
  assert.equal(clampRotation(5000, cyl), 5000, 'cylinder must not clamp');
  assert.equal(clampRotation(-5000, cyl), -5000);
});

test('snapRotation stays near the continuous rotation on a cylinder', () => {
  const cyl = drumLayout(340, 12); // step 30
  assert.equal(snapRotation(-359, cyl), -360);
  assert.equal(snapRotation(3601, cyl), 3600);
  // These angles track FAN_SPREAD_DEG[2] (currently 30) — if that constant
  // moves, the expected values below must move with it.
  const fan = drumLayout(340, 2);     // angles -15, 15
  assert.equal(snapRotation(19, fan), 15);
  assert.equal(snapRotation(-19, fan), -15);
});

test('nextLevel cycles projects -> districts -> memories -> projects', () => {
  assert.deepEqual(LEVELS, ['projects', 'districts', 'memories']);
  assert.equal(nextLevel('projects'), 'districts');
  assert.equal(nextLevel('districts'), 'memories');
  assert.equal(nextLevel('memories'), 'projects');
});

test('history stack: push copies, pop restores exact view, empty stack is the wall', () => {
  const h = createHistory();
  assert.equal(atWall(h), true);
  assert.equal(popView(h), null);
  const view = { level: 'memories', projectId: 'alpha', districtId: 'practical_execution', centeredId: 'mem_3', rotation: -180, itemIds: ['mem_3', 'mem_1'] };
  pushView(h, view);
  view.centeredId = 'mutated-after-push';
  assert.equal(atWall(h), false);
  const popped = popView(h);
  assert.equal(popped.centeredId, 'mem_3'); // copy, not reference
  assert.equal(popped.rotation, -180);
  assert.equal(atWall(h), true);
});

const memView = { level: 'memories', projectId: 'alpha', districtId: 'practical_execution', centeredId: 'mem_1', rotation: -180, itemIds: ['mem_3', 'mem_1'] };

test('itemIdsForView derives per level', () => {
  assert.deepEqual(itemIdsForView(SNAP, { level: 'projects' }), ['alpha', 'beta', UNASSIGNED]);
  assert.deepEqual(itemIdsForView(SNAP, { level: 'districts', projectId: 'beta' }), ['logical_analysis', 'weird_custom']);
  assert.deepEqual(itemIdsForView(SNAP, memView), ['mem_3', 'mem_1']);
});

test('reconcileView keeps a surviving centered item (rule 1)', () => {
  const r = reconcileView(memView, memView.itemIds, SNAP);
  assert.equal(r.status, 'kept');
  assert.equal(r.view.centeredId, 'mem_1');
});

test('reconcileView snaps to nearest prior neighbor when centered item vanished (rule 2)', () => {
  const snap2 = structuredClone(SNAP);
  delete snap2.memories.mem_1;
  const r = reconcileView(memView, ['mem_3', 'mem_1'], snap2);
  assert.equal(r.status, 'neighbor');
  assert.equal(r.view.centeredId, 'mem_3');
  // Unknown prior ordering still lands on something valid.
  const r2 = reconcileView({ ...memView, itemIds: [] }, [], snap2);
  assert.equal(r2.status, 'neighbor');
  assert.equal(r2.view.centeredId, 'mem_3');
});

test('reconcileView carries rotation through unchanged and refreshes itemIds', () => {
  // Documented precondition: rotation is a hint, NOT reconciled. It may point at
  // the wrong card once the drum's count/ordering changes, so consumers must
  // recompute it from centeredId. Pin the pass-through so a future "helpful"
  // rotation fix-up can't land silently.
  const snap2 = structuredClone(SNAP);
  delete snap2.memories.mem_1;
  const r = reconcileView(memView, memView.itemIds, snap2);
  assert.equal(r.status, 'neighbor');
  assert.equal(r.view.rotation, memView.rotation); // -180, stale for a 1-card drum
  assert.deepEqual(r.view.itemIds, ['mem_3']); // refreshed to the surviving ids
  assert.deepEqual(r.ids, ['mem_3']);
});

test('reconcileView reports an emptied context (rule 3)', () => {
  const snap3 = structuredClone(SNAP);
  delete snap3.memories.mem_1;
  delete snap3.memories.mem_3;
  const r = reconcileView(memView, memView.itemIds, snap3);
  assert.equal(r.status, 'invalid');
  assert.equal(r.view, null);
});

test('reconcilePop skips dead views and repairs survivors (rule 4)', () => {
  const snap4 = structuredClone(SNAP);
  delete snap4.memories.mem_4; // kills beta/weird_custom
  const h = createHistory();
  pushView(h, { level: 'projects', projectId: null, districtId: null, centeredId: 'beta', rotation: -90, itemIds: ['alpha', 'beta', UNASSIGNED] });
  pushView(h, { level: 'memories', projectId: 'beta', districtId: 'weird_custom', centeredId: 'mem_4', rotation: 0, itemIds: ['mem_4'] });
  const restored = reconcilePop(h, snap4);
  assert.equal(restored.level, 'projects'); // memories view was dead, popped through
  assert.equal(restored.centeredId, 'beta'); // beta still exists (mem_6 remains)
  assert.equal(atWall(h), true);
  assert.equal(reconcilePop(h, snap4), null); // exhausted stack -> caller shows root
});

test('routeGesture implements the spec input map', () => {
  const at = (level, insideReader = false) => ({ level, insideReader });
  assert.equal(routeGesture('wheel', at('projects')), 'spin');
  assert.equal(routeGesture('wheel', at('memories', true)), 'scrollContent');
  assert.equal(routeGesture('vswipe', at('memories', true)), 'scrollContent');
  assert.equal(routeGesture('vswipe', at('memories')), 'spin');
  assert.equal(routeGesture('hdrag', at('memories', true)), 'spin');
  for (const zoomIn of ['ctrlWheelUp', 'pinchSpread', 'enter']) {
    assert.equal(routeGesture(zoomIn, at('memories', true)), 'dive', zoomIn);
  }
  for (const out of ['ctrlWheelDown', 'pinchTogether', 'rightClick', 'esc', 'back']) {
    assert.equal(routeGesture(out, at('projects')), 'zoomOut', out);
    assert.equal(routeGesture(out, at('memories', true)), 'zoomOut', out);
  }
  assert.equal(routeGesture('clickCentered', at('projects')), 'dive');
  assert.equal(routeGesture('clickCentered', at('districts')), 'dive');
  // Clicks dive at EVERY level, memories included: the reader scrolls, it does
  // not swallow clicks. Only real controls (Edit, links) are exempt, and that
  // exemption lives in the page's DOM guard, not here.
  assert.equal(routeGesture('clickCentered', at('memories')), 'dive');
  assert.equal(routeGesture('clickOther', at('memories')), 'centerThenDive');
  assert.equal(routeGesture('clickCentered', at('memories', true)), 'dive');
  assert.equal(routeGesture('clickOther', at('projects')), 'centerThenDive');
  assert.equal(routeGesture('arrowLeft', at('districts')), 'stepPrev');
  assert.equal(routeGesture('arrowRight', at('districts')), 'stepNext');
  assert.equal(routeGesture('bogus', at('projects')), 'none');
});

import {
  createNavTree, navNode, navCursor, navDepth, navAtWall, navSetCursorView,
  navPush, navBack, navActivePath, navFindContext, navJump,
  navReconcileBack, navReconcileJump, navRemapProject,
} from '../scripts/nd-mem-rolodex-helpers.mjs';

const ROOT_VIEW = { level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] };
const v = (level, projectId, districtId, centeredId = null, itemIds = []) =>
  ({ level, projectId, districtId, centeredId, rotation: 0, itemIds });

test('a fresh tree is one root node at the wall', () => {
  const t = createNavTree(ROOT_VIEW);
  assert.equal(t.nodes.length, 1);
  assert.equal(t.cursor, 0);
  assert.equal(navDepth(t), 0);
  assert.equal(navAtWall(t), true);
  assert.equal(navBack(t), null);
  assert.equal(navCursor(t).view.level, 'projects');
});

test('createNavTree copies the root view, caller mutations do not leak in', () => {
  const ids = ['alpha', 'beta'];
  const t = createNavTree({ ...ROOT_VIEW, centeredId: 'alpha', itemIds: ids });
  ids.push('gamma');
  assert.deepEqual(navNode(t, 0).view.itemIds, ['alpha', 'beta']);
});

test('dive appends a child and advances the cursor; depth counts ancestors', () => {
  const t = createNavTree(ROOT_VIEW);
  navPush(t, v('districts', 'alpha', null));
  assert.equal(navDepth(t), 1);
  assert.equal(navAtWall(t), false);
  navPush(t, v('memories', 'alpha', 'practical_execution'));
  assert.equal(navDepth(t), 2);
  // the wrap back to projects is an ordinary dive: depth keeps climbing
  navPush(t, v('projects', null, null));
  assert.equal(navDepth(t), 3);
  assert.equal(navCursor(t).view.level, 'projects');
  assert.equal(t.nodes.length, 4);
});

test('re-diving the same decision re-enters the existing child, no duplicate sibling', () => {
  const t = createNavTree(ROOT_VIEW);
  const first = navPush(t, v('districts', 'alpha', null));
  navBack(t);
  const again = navPush(t, v('districts', 'alpha', null));
  assert.equal(again, first);
  assert.equal(t.nodes.length, 2);
  // a different project forks a real sibling
  navBack(t);
  const other = navPush(t, v('districts', 'beta', null));
  assert.notEqual(other, first);
  assert.equal(t.nodes.length, 3);
  assert.equal(navNode(t, 0).childIds.length, 2);
});

test('the same district name under different projects stays two distinct nodes', () => {
  const t = createNavTree(ROOT_VIEW);
  navPush(t, v('districts', 'alpha', null));
  const a = navPush(t, v('memories', 'alpha', 'logical_analysis'));
  navBack(t); navBack(t);
  navPush(t, v('districts', 'beta', null));
  const b = navPush(t, v('memories', 'beta', 'logical_analysis'));
  assert.notEqual(a, b);
});

test('dead branches survive backing out and diving elsewhere', () => {
  const t = createNavTree(ROOT_VIEW);
  navPush(t, v('districts', 'alpha', null));
  navPush(t, v('memories', 'alpha', 'practical_execution'));
  navBack(t); navBack(t);
  navPush(t, v('districts', 'beta', null));
  assert.equal(t.nodes.length, 4);              // nothing pruned
  assert.equal(navDepth(t), 1);
  assert.deepEqual(navActivePath(t).map(n => n.id), [0, 3]);
});

test('navSetCursorView records leave-time state, navBack restores it', () => {
  const t = createNavTree(ROOT_VIEW);
  navSetCursorView(t, { ...ROOT_VIEW, centeredId: 'alpha', rotation: -120, itemIds: ['alpha', 'beta'] });
  navPush(t, v('districts', 'alpha', null));
  const back = navBack(t);
  assert.equal(back.centeredId, 'alpha');
  assert.equal(back.rotation, -120);
  assert.deepEqual(back.itemIds, ['alpha', 'beta']);
});

test('navFindContext locates an ancestor by level and context', () => {
  const t = createNavTree(ROOT_VIEW);
  const d = navPush(t, v('districts', 'alpha', null));
  navPush(t, v('memories', 'alpha', 'practical_execution'));
  assert.equal(navFindContext(t, { level: 'districts', projectId: 'alpha', districtId: null }), d);
  assert.equal(navFindContext(t, { level: 'districts', projectId: 'nope', districtId: null }), null);
  assert.equal(navJump(t, d).level, 'districts');
  assert.equal(navDepth(t), 1);
});

test('navReconcileBack stops at the first view that still has cards', () => {
  const t = createNavTree({ ...ROOT_VIEW, centeredId: 'beta', itemIds: ['alpha', 'beta', UNASSIGNED] });
  navPush(t, { ...v('districts', 'beta', null), centeredId: 'weird_custom', itemIds: ['weird_custom'] });
  navPush(t, { ...v('memories', 'beta', 'weird_custom'), centeredId: 'mem_4', itemIds: ['mem_4'] });
  const snap = structuredClone(SNAP);
  delete snap.memories.mem_4;                  // kills beta/weird_custom, but mem_6 keeps beta alive
  const restored = navReconcileBack(t, snap);
  assert.equal(restored.level, 'districts');   // beta's district drum survives, so we stop there
  assert.equal(restored.centeredId, 'logical_analysis'); // weird_custom is gone; neighbor picked
  assert.equal(navDepth(t), 1);
});

test('navReconcileBack walks all the way past a fully dead branch', () => {
  const t = createNavTree({ ...ROOT_VIEW, centeredId: 'beta', itemIds: ['alpha', 'beta', UNASSIGNED] });
  navPush(t, { ...v('districts', 'beta', null), centeredId: 'weird_custom', itemIds: ['weird_custom'] });
  navPush(t, { ...v('memories', 'beta', 'weird_custom'), centeredId: 'mem_4', itemIds: ['mem_4'] });
  const snap = structuredClone(SNAP);
  delete snap.memories.mem_4;
  delete snap.memories.mem_6;                  // now beta has no memories at all
  const restored = navReconcileBack(t, snap);
  assert.equal(restored.level, 'projects');    // both dead views were walked past
  assert.equal(restored.centeredId, 'alpha');  // 'beta' is gone; nearest surviving neighbor
  assert.equal(navAtWall(t), true);
});

test('navReconcileJump validates the target and falls back to a live ancestor', () => {
  const t = createNavTree({ ...ROOT_VIEW, centeredId: 'alpha', itemIds: ['alpha', 'beta', UNASSIGNED] });
  const dead = navPush(t, { ...v('districts', 'beta', null), centeredId: 'weird_custom', itemIds: ['weird_custom'] });
  const snap = structuredClone(SNAP);
  delete snap.memories.mem_4;
  delete snap.memories.mem_6;                 // beta is now gone completely
  const landed = navReconcileJump(t, dead, snap);
  assert.equal(landed.level, 'projects');
  assert.equal(navAtWall(t), true);
});

test('navRemapProject rewrites the id across every node, dead branches included', () => {
  // Only a projects-level view's centeredId is a project id; a districts-level
  // view's centeredId is a district name and must be left alone.
  const t = createNavTree({ ...ROOT_VIEW, centeredId: 'alpha', itemIds: ['alpha', 'beta'] });
  navPush(t, v('districts', 'alpha', null));                  // id 1
  navPush(t, v('memories', 'alpha', 'practical_execution'));  // id 2
  navBack(t); navBack(t);
  navPush(t, v('districts', 'beta', null));                   // id 3
  navRemapProject(t, 'alpha', 'ALPHA');
  assert.equal(navNode(t, 0).view.centeredId, 'ALPHA', 'a centered project id is remapped');
  assert.deepEqual(navNode(t, 0).view.itemIds, ['ALPHA', 'beta']);
  assert.equal(navNode(t, 1).view.projectId, 'ALPHA');
  assert.equal(navNode(t, 2).view.projectId, 'ALPHA', 'the abandoned branch is remapped too');
  assert.equal(navNode(t, 3).view.projectId, 'beta', 'other projects untouched');
});

import { coordinateOf, navNodeLabel, layoutNavTree } from '../scripts/nd-mem-rolodex-helpers.mjs';

test('coordinateOf builds a depth-prefixed path with jump targets', () => {
  const projects = coordinateOf(v('projects', null, null), 0, 'alpha');
  assert.deepEqual(projects.map(s => s.kind), ['depth', 'leaf']);
  assert.equal(projects[0].text, '0^0');
  assert.equal(projects[0].target, null);
  assert.equal(projects[1].text, 'alpha');

  const memories = coordinateOf(v('memories', 'alpha', 'practical_execution'), 7, 'mem_3');
  assert.deepEqual(memories.map(s => s.kind), ['depth', 'project', 'district', 'leaf']);
  assert.equal(memories[0].text, '0^7');
  assert.deepEqual(memories[1].target, { level: 'districts', projectId: 'alpha', districtId: null });
  assert.deepEqual(memories[2].target, { level: 'memories', projectId: 'alpha', districtId: 'practical_execution' });
  assert.equal(memories[3].target, null, 'the leaf is where you already are');
  assert.equal(memories[3].text, 'mem_3');
});

test('coordinateOf tolerates an empty drum', () => {
  const segs = coordinateOf(v('districts', 'alpha', null), 1, null);
  assert.deepEqual(segs.map(s => s.kind), ['depth', 'project']);
  assert.equal(segs[0].text, '0^1');
});

test('navNodeLabel names a node by what you dove into', () => {
  assert.equal(navNodeLabel({ id: 0, parentId: null, view: v('projects', null, null) }), 'start');
  assert.equal(navNodeLabel({ id: 3, parentId: 2, view: v('projects', null, null) }), 'wrap');
  assert.equal(navNodeLabel({ id: 1, parentId: 0, view: v('districts', 'alpha', null) }), 'alpha');
  assert.equal(navNodeLabel({ id: 2, parentId: 1, view: v('memories', 'alpha', 'logical_analysis') }), 'logical_analysis');
});

test('layoutNavTree grows upward from a bottom root and marks the active path', () => {
  const t = createNavTree(ROOT_VIEW);
  navPush(t, v('districts', 'alpha', null));      // id 1
  navPush(t, v('memories', 'alpha', 'practical_execution')); // id 2
  navBack(t); navBack(t);
  navPush(t, v('districts', 'beta', null));       // id 3, cursor here

  const laid = layoutNavTree(t);
  const byId = Object.fromEntries(laid.nodes.map(n => [n.id, n]));
  assert.equal(laid.nodes.length, 4);
  assert.equal(byId[0].depth, 0);
  assert.equal(byId[2].depth, 2);
  assert.ok(byId[0].y > byId[1].y, 'root sits below its children (SVG y grows downward)');
  assert.ok(byId[1].y > byId[2].y, 'deeper nodes sit higher');
  assert.ok(byId[1].x !== byId[3].x, 'siblings are spread apart');
  assert.equal(byId[3].isCursor, true);
  assert.equal(byId[3].onPath, true);
  assert.equal(byId[0].onPath, true);
  assert.equal(byId[2].onPath, false, 'the abandoned branch is off the active path');
  assert.equal(laid.edges.length, 3);
  assert.ok(laid.width > 0 && laid.height > 0);
  assert.ok(laid.nodes.every(n => n.x >= 0 && n.y >= 0), 'coordinates stay inside the viewbox');
});

test('layoutNavTree handles a lone root', () => {
  const laid = layoutNavTree(createNavTree(ROOT_VIEW));
  assert.equal(laid.nodes.length, 1);
  assert.equal(laid.edges.length, 0);
  assert.equal(laid.nodes[0].isCursor, true);
});
