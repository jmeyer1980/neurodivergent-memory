import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNASSIGNED, UNCATEGORIZED, CANONICAL_DISTRICTS,
  projectOf, districtOf, deriveProjects, deriveDistricts, deriveMemories,
  anglePerCard, drumRadius, normalizeAngle, shortestDelta,
  nearestIndex, rotationForIndex, snapTarget,
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
  // Clicks are level-dependent: memories cards are a reading surface.
  assert.equal(routeGesture('clickCentered', at('projects')), 'dive');
  assert.equal(routeGesture('clickCentered', at('districts')), 'dive');
  assert.equal(routeGesture('clickCentered', at('memories')), 'none');
  assert.equal(routeGesture('clickOther', at('projects')), 'centerThenDive');
  assert.equal(routeGesture('clickOther', at('memories')), 'centerOnly');
  assert.equal(routeGesture('arrowLeft', at('districts')), 'stepPrev');
  assert.equal(routeGesture('arrowRight', at('districts')), 'stepNext');
  assert.equal(routeGesture('bogus', at('projects')), 'none');
});
