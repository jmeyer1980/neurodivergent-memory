import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNASSIGNED, UNCATEGORIZED, CANONICAL_DISTRICTS,
  projectOf, districtOf, deriveProjects, deriveDistricts, deriveMemories,
  anglePerCard, drumRadius, normalizeAngle, shortestDelta,
  nearestIndex, rotationForIndex, snapTarget,
  FAN_MAX_CARDS, isFanCount, fanStep, fanRadius, drumLayout,
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
  assert.deepEqual(drumLayout(340, 2).angles.map(Math.round), [-20, 20]);
  assert.deepEqual(drumLayout(340, 3).angles.map(Math.round), [-35, 0, 35]);
  assert.deepEqual(drumLayout(340, 4).angles.map(Math.round), [-50, -17, 17, 50]);
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
  const fan = drumLayout(340, 3);            // angles -35, 0, 35 -> rotation range -35..35
  assert.equal(fan.maxRotation, 35);
  assert.equal(fan.minRotation, -35);
  assert.equal(clampRotation(200, fan), 35);
  assert.equal(clampRotation(-200, fan), -35);
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
  const fan = drumLayout(340, 2);     // angles -20, 20
  assert.equal(snapRotation(19, fan), 20);
  assert.equal(snapRotation(-19, fan), -20);
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
