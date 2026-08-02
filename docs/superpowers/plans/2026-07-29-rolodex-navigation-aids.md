# Rolodex Navigation Aids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the rolodex proprioception — a depth coordinate, an exploration-tree minimap, in-app project rename, a fan layout for small drums, and uniform click-to-dive at every level.

**Architecture:** All new logic lands as pure functions in the existing DOM-free helpers module (unit-tested with node:test); the page consumes them. The history stack is replaced by a navigation tree whose active path preserves today's wall/zoom-out/reconciliation semantics exactly. Drum geometry is unified behind one `drumLayout()` descriptor so fan and cylinder modes share every call site.

**Tech Stack:** Vanilla JS ES modules, CSS 3D, inline SVG, node:test + node:assert/strict, Playwright (dev-only, already installed under `node_modules`) driving installed Edge for browser checks.

**Spec:** `docs/superpowers/specs/2026-07-29-rolodex-navigation-aids-design.md` — read it before starting any task.

## Global Constraints

- No new runtime dependencies, no build step. Plain JS — no TypeScript syntax in `.mjs`/`.html`.
- `scripts/nd-mem-rolodex-helpers.mjs` stays pure: no DOM, no network, no timers.
- Version stays 0.3.9; CHANGELOG entries go under `[Unreleased]`. Never bump versions.
- Fan rule: **count ≤ 4 → fan, count ≥ 5 → cylinder**, at every level. Max card angle 60°. Cylinder wrap-around is preserved; the clamp is fan-only.
- `0^N`: N = active-path depth (total dives). One tree, one depth number — every dive gesture including the memories→projects wrap is a single `navPush`. There is no separate loop counter.
- Rotation is never trusted across a reconcile: always recompute from `centeredId` (precondition documented at `scripts/nd-mem-rolodex-helpers.mjs:135-148`).
- Minimap collapse state persists as `localStorage['ndmem.rolodex.minimap']` with values `'open'` / `'collapsed'`, default open.
- Run focused tests with `node --test test/rolodex-helpers.test.mjs`. Do NOT run `npm test` during tasks (it rebuilds and runs the whole suite); Task 10 runs it once.
- Two pre-existing failures in `test/agent-customization-wording.test.mjs` are known and unrelated — do not try to fix them.
- Browser checks: the bridge must be running (`node scripts/nd-mem-bridge-server.mjs --no-open`) and Playwright scripts import from `file:///C:/Users/jerio/RiderProjects/neurodivergent-memory/node_modules/playwright/index.mjs` with `chromium.launch({ channel: 'msedge' })`.

---

### Task 1: Drum layout — unified fan + cylinder geometry

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append after the cylinder-math section, before `// ---------- levels & history ----------`)
- Modify: `test/rolodex-helpers.test.mjs` (append; extend the existing import list)

**Interfaces:**
- Consumes: existing `drumRadius`, `shortestDelta`, `normalizeAngle`.
- Produces:
  - `FAN_MAX_CARDS = 4`
  - `isFanCount(count) -> boolean`
  - `fanStep(count) -> number` (degrees between adjacent fan cards)
  - `fanRadius(cardWidth, count, minRadius=260) -> number`
  - `drumLayout(cardWidth, count) -> { mode:'fan'|'cylinder', count, step, radius, angles:number[], minRotation, maxRotation }` — `angles[i]` is card *i*'s Y-rotation in degrees
  - `rotationForCard(index, layout) -> number` (rotation that centers card *index*; equals `-layout.angles[index]`)
  - `indexAtRotation(rotation, layout) -> number` (-1 when empty)
  - `snapRotation(rotation, layout) -> number`
  - `clampRotation(rotation, layout) -> number` (fan clamps, cylinder passthrough)

- [ ] **Step 1: Write the failing tests**

Append to `test/rolodex-helpers.test.mjs`, adding these names to the existing import from `'../scripts/nd-mem-rolodex-helpers.mjs'`:

```js
import {
  FAN_MAX_CARDS, isFanCount, fanStep, fanRadius, drumLayout,
  rotationForCard, indexAtRotation, snapRotation, clampRotation,
} from '../scripts/nd-mem-rolodex-helpers.mjs';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `does not provide an export named 'FAN_MAX_CARDS'`.

- [ ] **Step 3: Write the implementation**

Insert into `scripts/nd-mem-rolodex-helpers.mjs` immediately after `snapTarget` (i.e. after the `// ---------- cylinder math ----------` block ends, before `// ---------- levels & history ----------`):

```js
// ---------- drum layout: fan (<= 4 cards) vs cylinder (>= 5) ----------
// A 1-4 card cylinder is degenerate: two cards face away from each other, four
// make a cube showing one face. Small drums instead fan forward so every card
// is visible at once, which is how you see at a glance that a project has
// exactly three districts. Fan mode trades wrap-around for end clamping.

export const FAN_MAX_CARDS = 4;

// Total arc each count spreads over. Capped so no card passes 60 degrees,
// beyond which a card is edge-on and unreadable.
const FAN_SPREAD_DEG = { 1: 0, 2: 40, 3: 70, 4: 100 };

export function isFanCount(count) {
  return count > 0 && count <= FAN_MAX_CARDS;
}

export function fanStep(count) {
  if (count <= 1) return 0;
  return (FAN_SPREAD_DEG[count] ?? FAN_SPREAD_DEG[FAN_MAX_CARDS]) / (count - 1);
}

// Adjacent card centers sit a chord apart on the arc; the chord must be at
// least a card wide or the faces overlap and hide each other.
export function fanRadius(cardWidth, count, minRadius = 260) {
  const step = fanStep(count);
  if (step <= 0) return minRadius;
  const chordHalfAngle = (step / 2) * Math.PI / 180;
  return Math.max(minRadius, Math.ceil(cardWidth / (2 * Math.sin(chordHalfAngle))));
}

// One descriptor per drum build. Every geometry consumer (placement, hit
// testing, snapping, clamping) reads from this, so fan and cylinder never
// need branching at the call site.
export function drumLayout(cardWidth, count) {
  if (isFanCount(count)) {
    const step = fanStep(count);
    const mid = (count - 1) / 2;
    const angles = Array.from({ length: count }, (_, i) => (i - mid) * step);
    return {
      mode: 'fan', count, step,
      radius: fanRadius(cardWidth, count),
      angles,
      minRotation: -angles[count - 1],
      maxRotation: -angles[0],
    };
  }
  const step = count > 0 ? 360 / count : 0;
  return {
    mode: 'cylinder', count, step,
    radius: drumRadius(cardWidth, count),
    angles: Array.from({ length: count }, (_, i) => i * step),
    minRotation: -Infinity,
    maxRotation: Infinity,
  };
}

export function rotationForCard(index, layout) {
  if (!layout || !layout.count || index < 0 || index >= layout.count) return 0;
  return -layout.angles[index];
}

export function indexAtRotation(rotation, layout) {
  if (!layout || layout.count <= 0) return -1;
  if (layout.count === 1) return 0;
  if (layout.mode === 'fan') {
    const mid = (layout.count - 1) / 2;
    const raw = Math.round(mid - rotation / layout.step);
    return Math.min(layout.count - 1, Math.max(0, raw));
  }
  return Math.round(normalizeAngle(-rotation) / layout.step) % layout.count;
}

export function snapRotation(rotation, layout) {
  if (!layout || layout.count <= 0) return rotation;
  const target = rotationForCard(indexAtRotation(rotation, layout), layout);
  // Fan targets are absolute; a cylinder must keep the turns it has
  // accumulated, so approach the target the short way round instead.
  return layout.mode === 'fan' ? target : rotation + shortestDelta(rotation, target);
}

export function clampRotation(rotation, layout) {
  if (!layout || layout.mode !== 'fan') return rotation;
  return Math.min(layout.maxRotation, Math.max(layout.minRotation, rotation));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (25 tests: 18 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): unified drum layout with fan mode for small drums"
```

---

### Task 2: Navigation tree helpers

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append after the reconciliation section)
- Modify: `test/rolodex-helpers.test.mjs` (append)

**Interfaces:**
- Consumes: `reconcileView` (existing).
- Produces:
  - `createNavTree(rootView) -> tree` where `tree = { nodes:[node], cursor:0, nextId:1 }` and `node = { id, parentId, view, childIds }`
  - `navNode(tree, id) -> node | null`
  - `navCursor(tree) -> node`
  - `navDepth(tree) -> number` (0 at root)
  - `navAtWall(tree) -> boolean`
  - `navSetCursorView(tree, view) -> void`
  - `navPush(tree, view) -> number` (node id; dedupes into a matching existing child)
  - `navBack(tree) -> view | null`
  - `navActivePath(tree) -> node[]` (root → cursor inclusive)
  - `navFindContext(tree, target) -> number | null` (deepest ancestor-or-cursor node whose view matches `{level, projectId, districtId}`)
  - `navJump(tree, nodeId) -> view | null`
  - `navReconcileBack(tree, snapshot) -> view | null`
  - `navReconcileJump(tree, nodeId, snapshot) -> view | null`
  - `navRemapProject(tree, oldId, newId) -> void`

- [ ] **Step 1: Write the failing tests**

Append to `test/rolodex-helpers.test.mjs` (extend the import list):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `does not provide an export named 'createNavTree'`.

- [ ] **Step 3: Write the implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// ---------- navigation tree ----------
// Supersedes the history stack. The cursor's ancestor chain plays exactly the
// role the stack played (wall, zoom-out, reconciliation), while abandoned
// branches are kept so the session's exploration can be drawn and revisited.
// EVERY dive gesture is one navPush — click, Enter, ctrl+wheel, pinch, and the
// memories->projects wrap alike. There is no separate lap or loop counter:
// wraps are ordinary projects-level children and depth just keeps climbing.

export function createNavTree(rootView) {
  return {
    nodes: [{ id: 0, parentId: null, view: { ...rootView }, childIds: [] }],
    cursor: 0,
    nextId: 1,
  };
}

export function navNode(tree, id) {
  return tree.nodes.find(n => n.id === id) ?? null;
}

export function navCursor(tree) {
  return navNode(tree, tree.cursor);
}

export function navActivePath(tree) {
  const path = [];
  for (let node = navCursor(tree); node; node = node.parentId === null ? null : navNode(tree, node.parentId)) {
    path.push(node);
  }
  return path.reverse();
}

export function navDepth(tree) {
  return navActivePath(tree).length - 1;
}

export function navAtWall(tree) {
  return tree.cursor === 0;
}

export function navSetCursorView(tree, view) {
  navCursor(tree).view = { ...view, itemIds: [...(view.itemIds || [])] };
}

function sameContext(a, b) {
  return a.level === b.level && a.projectId === b.projectId && a.districtId === b.districtId;
}

export function navPush(tree, view) {
  const parent = navCursor(tree);
  const existing = parent.childIds.map(id => navNode(tree, id)).find(child => sameContext(child.view, view));
  if (existing) { tree.cursor = existing.id; return existing.id; }
  const node = { id: tree.nextId++, parentId: parent.id, view: { ...view, itemIds: [...(view.itemIds || [])] }, childIds: [] };
  tree.nodes.push(node);
  parent.childIds.push(node.id);
  tree.cursor = node.id;
  return node.id;
}

export function navBack(tree) {
  if (navAtWall(tree)) return null;
  tree.cursor = navCursor(tree).parentId;
  return navCursor(tree).view;
}

export function navJump(tree, nodeId) {
  const node = navNode(tree, nodeId);
  if (!node) return null;
  tree.cursor = node.id;
  return node.view;
}

// Deepest node on the active path whose view matches the wanted context —
// the coordinate's clickable segments resolve through this, so a jump is
// always backward along the path you actually walked.
export function navFindContext(tree, target) {
  const path = navActivePath(tree);
  for (let i = path.length - 1; i >= 0; i--) {
    if (sameContext(path[i].view, target)) return path[i].id;
  }
  return null;
}

function reconcileAtCursor(tree, snapshot) {
  const view = navCursor(tree).view;
  const result = reconcileView(view, view.itemIds || [], snapshot);
  if (result.status === 'invalid') return null;
  navSetCursorView(tree, result.view);
  return result.view;
}

export function navReconcileBack(tree, snapshot) {
  while (!navAtWall(tree)) {
    navBack(tree);
    const view = reconcileAtCursor(tree, snapshot);
    if (view) return view;
  }
  return null;
}

export function navReconcileJump(tree, nodeId, snapshot) {
  if (!navJump(tree, nodeId)) return null;
  const view = reconcileAtCursor(tree, snapshot);
  return view ?? navReconcileBack(tree, snapshot);
}

export function navRemapProject(tree, oldId, newId) {
  for (const node of tree.nodes) {
    if (node.view.projectId === oldId) node.view.projectId = newId;
    if (node.view.level === 'projects' && node.view.centeredId === oldId) node.view.centeredId = newId;
    node.view.itemIds = (node.view.itemIds || []).map(id => (id === oldId ? newId : id));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (36 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): navigation tree replacing the history stack"
```

---

### Task 3: Coordinate formatting and minimap tree layout

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append)
- Modify: `test/rolodex-helpers.test.mjs` (append)

**Interfaces:**
- Consumes: `navActivePath`, `navNode` (Task 2).
- Produces:
  - `coordinateOf(view, depth, centeredId) -> segment[]` where `segment = { kind:'depth'|'project'|'district'|'leaf', text, target|null }` and `target = { level, projectId, districtId }`
  - `navNodeLabel(node) -> string`
  - `layoutNavTree(tree) -> { nodes:[{id,x,y,depth,onPath,isCursor,label}], edges:[{x1,y1,x2,y2,onPath}], width, height }` — SVG coordinates, root at the bottom

- [ ] **Step 1: Write the failing tests**

Append to `test/rolodex-helpers.test.mjs` (extend the import list):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `does not provide an export named 'coordinateOf'`.

- [ ] **Step 3: Write the implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// ---------- coordinate + minimap geometry ----------

// `0^N > project > district > centered-card`. N is total dives, so the badge
// alone answers "how deep am I in the fractal" without a second counter.
export function coordinateOf(view, depth, centeredId) {
  const segments = [{ kind: 'depth', text: `0^${depth}`, target: null }];
  if (view.projectId != null) {
    segments.push({
      kind: 'project',
      text: String(view.projectId),
      target: { level: 'districts', projectId: view.projectId, districtId: null },
    });
  }
  if (view.districtId != null) {
    segments.push({
      kind: 'district',
      text: String(view.districtId),
      target: { level: 'memories', projectId: view.projectId, districtId: view.districtId },
    });
  }
  if (centeredId != null) segments.push({ kind: 'leaf', text: String(centeredId), target: null });
  return segments;
}

export function navNodeLabel(node) {
  const { level, projectId, districtId } = node.view;
  if (node.parentId === null) return 'start';
  if (level === 'districts') return String(projectId);
  if (level === 'memories') return String(districtId);
  return 'wrap';
}

const MINIMAP_COL = 26;   // px between sibling columns
const MINIMAP_ROW = 34;   // px between depth rows
const MINIMAP_PAD = 14;

// Tidy-ish layout: every leaf takes the next column, every parent centers over
// its children, and depth maps to a row counted UP from the bottom so the tree
// grows the way it is drawn — root on the floor.
export function layoutNavTree(tree) {
  const depthOf = new Map();
  const xOf = new Map();
  let nextColumn = 0;
  let maxDepth = 0;

  const walk = (node, depth) => {
    depthOf.set(node.id, depth);
    if (depth > maxDepth) maxDepth = depth;
    const children = node.childIds.map(id => navNode(tree, id));
    if (!children.length) {
      xOf.set(node.id, nextColumn++);
      return;
    }
    for (const child of children) walk(child, depth + 1);
    const first = xOf.get(children[0].id);
    const last = xOf.get(children[children.length - 1].id);
    xOf.set(node.id, (first + last) / 2);
  };
  walk(navNode(tree, 0), 0);

  const onPath = new Set(navActivePath(tree).map(n => n.id));
  const height = MINIMAP_PAD * 2 + maxDepth * MINIMAP_ROW;
  const px = id => MINIMAP_PAD + xOf.get(id) * MINIMAP_COL;
  const py = id => height - MINIMAP_PAD - depthOf.get(id) * MINIMAP_ROW;

  const nodes = tree.nodes.map(node => ({
    id: node.id,
    x: px(node.id),
    y: py(node.id),
    depth: depthOf.get(node.id),
    onPath: onPath.has(node.id),
    isCursor: node.id === tree.cursor,
    label: navNodeLabel(node),
  }));

  const edges = [];
  for (const node of tree.nodes) {
    if (node.parentId === null) continue;
    edges.push({
      x1: px(node.parentId), y1: py(node.parentId),
      x2: px(node.id), y2: py(node.id),
      onPath: onPath.has(node.id) && onPath.has(node.parentId),
    });
  }

  return { nodes, edges, width: MINIMAP_PAD * 2 + Math.max(0, nextColumn - 1) * MINIMAP_COL, height };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (41 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): coordinate formatting and minimap tree layout"
```

---

### Task 4: Uniform click-to-dive routing

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs:187-201` (the `routeGesture` switch)
- Modify: `test/rolodex-helpers.test.mjs` (the existing `routeGesture` test)
- Modify: `scripts/nd-mem-rolodex.html` (click handler guard + HUD hint)

**Interfaces:**
- Consumes: nothing new.
- Produces: `routeGesture('clickCentered', ctx) -> 'dive'` and `routeGesture('clickOther', ctx) -> 'centerThenDive'` at every level.

- [ ] **Step 1: Update the failing test**

In `test/rolodex-helpers.test.mjs`, inside the existing test named `routeGesture implements the spec input map`, replace these four assertions:

```js
  assert.equal(routeGesture('clickCentered', at('memories')), 'none');
  assert.equal(routeGesture('clickOther', at('memories')), 'centerOnly');
```

with:

```js
  // Clicks dive at EVERY level, memories included: the reader scrolls, it does
  // not swallow clicks. Only real controls (Edit, links) are exempt, and that
  // exemption lives in the page's DOM guard, not here.
  assert.equal(routeGesture('clickCentered', at('memories')), 'dive');
  assert.equal(routeGesture('clickOther', at('memories')), 'centerThenDive');
  assert.equal(routeGesture('clickCentered', at('memories', true)), 'dive');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `Expected values to be strictly equal: 'none' !== 'dive'`.

- [ ] **Step 3: Simplify the routing table**

In `scripts/nd-mem-rolodex-helpers.mjs`, replace these two lines inside `routeGesture`:

```js
    case 'clickCentered': return level === 'memories' ? 'none' : 'dive';
    case 'clickOther': return level === 'memories' ? 'centerOnly' : 'centerThenDive';
```

with:

```js
    case 'clickCentered': return 'dive';
    case 'clickOther': return 'centerThenDive';
```

`level` is now unused inside the function body — leave the destructure as
`const { level, insideReader } = ctx;` so the ctx contract is unchanged, and
update the comment above the function to read:

```js
// ---------- gesture routing (spec input map) ----------
// insideReader is only true when the pointer is inside the front card's
// scrollable reader area (memories level, content actually overflowing).
// It gates SCROLLING only: clicks dive at every level, because a reader that
// eats clicks reads as a broken app. Controls inside a card (Edit, links) are
// exempted by the page's DOM guard before this is ever consulted.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (41 tests).

- [ ] **Step 5: Let the page's click handler through the reader**

In `scripts/nd-mem-rolodex.html`, find this line in the card click handler:

```js
      if (hit && hit.closest('button, a, .reader-scroll')) return;
```

Replace it with:

```js
      // `.reader-scroll` is deliberately NOT exempt any more: clicking the
      // memory text dives onward like clicking anywhere else on the card.
      // Reading is still safe — wheel-inside-the-reader scrolls (see
      // insideReader), and a text-selection drag exceeds the click threshold
      // and suppresses its own click.
      if (hit && hit.closest('button, a')) return;
```

- [ ] **Step 6: Update the memories-level HUD hint**

In `scripts/nd-mem-rolodex.html`, in `updateChrome()`, replace:

```js
      // At the memories level a click reads, never dives — advertising "click
      // to dive" there sent people clicking a reading surface and concluding
      // the app was broken.
      els.hudHint.textContent = level === 'memories'
        ? 'Scroll to spin · scroll inside the card to read · Ctrl+scroll up dives onward · right-click / Esc goes back'
        : 'Scroll to spin · click a card to dive · right-click / Esc to zoom out · Ctrl+scroll zooms';
```

with:

```js
      els.hudHint.textContent = level === 'memories'
        ? 'Scroll to spin · scroll inside the card to read · click to dive onward · right-click / Esc goes back'
        : 'Scroll to spin · click a card to dive · right-click / Esc to zoom out · Ctrl+scroll zooms';
```

- [ ] **Step 7: Verify in a browser**

Start the bridge if it is not already running: `node scripts/nd-mem-bridge-server.mjs --no-open`

Write `scratch-click-through.mjs` (do not commit) and run it with `node`:

```js
import { chromium } from 'file:///C:/Users/jerio/RiderProjects/neurodivergent-memory/node_modules/playwright/index.mjs';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:3737/rolodex');
await page.waitForSelector('.card3d.front', { timeout: 15000 });
await page.waitForTimeout(500);
const level = async () => (await page.textContent('#levelName')).trim();
const front = async () => { const b2 = await page.locator('.card3d.front').boundingBox(); return { x: b2.x + b2.width / 2, y: b2.y + b2.height / 2 }; };
// dive down to memories
for (let i = 0; i < 2; i++) { const p = await front(); await page.mouse.click(p.x, p.y); await page.waitForTimeout(1900); }
console.log('at:', await level());
// clicking the reader text must dive onward (wrap to projects)
const p = await front();
await page.mouse.click(p.x, p.y);
await page.waitForTimeout(1900);
console.log('after clicking the card body:', await level(), '(expected Projects)');
await b.close();
```

Expected: `at: Memories` then `after clicking the card body: Projects`.

- [ ] **Step 8: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): clicks dive at every level, reader no longer swallows them"
```

---

### Task 5: Page adopts the navigation tree

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` (state, `dive`, `zoomOut`, `refreshAndReconcile`, `updateChrome`)

**Interfaces:**
- Consumes: `createNavTree`, `navPush`, `navSetCursorView`, `navAtWall`, `navDepth`, `navReconcileBack`, `navCursor` (Task 2).
- Produces: `state.tree` (the nav tree), `depthNow()` returning the current depth — consumed by Tasks 6 and 7.

- [ ] **Step 1: Replace the history stack in state**

In `scripts/nd-mem-rolodex.html`, in the `state` object literal, replace:

```js
      history: H.createHistory(),
```

with:

```js
      // Supersedes the history stack: the cursor's ancestor chain behaves
      // exactly as the stack did, and abandoned branches stay for the minimap.
      tree: H.createNavTree({ level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] }),
```

- [ ] **Step 2: Route dive through the tree**

Replace the entire `dive()` function — from `function dive(){` through its
closing `}` — with:

```js
    function dive(){
      if (state.transitioning || !state.items.length) return;
      const front = centeredItem();
      if (!front) return;
      // Record where we are leaving from before descending, so backing out
      // returns to this exact rotation and centered card.
      H.navSetCursorView(state.tree, currentViewSnapshot());
      const level = H.nextLevel(state.view.level);
      let next;
      if (state.view.level === 'projects') next = { level, projectId: front.id, districtId: null, centeredId: null, rotation: 0, itemIds: [] };
      else if (state.view.level === 'districts') next = { level, projectId: state.view.projectId, districtId: front.id, centeredId: null, rotation: 0, itemIds: [] };
      else next = { level, projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] }; // memories wraps to projects
      // The wrap is an ordinary child: one tree, one depth, no loop counter.
      H.navPush(state.tree, next);
      transitionTo(next, 'in');
    }
```

- [ ] **Step 3: Route zoomOut through the tree**

Replace the whole of `zoomOut()`:

```js
    function zoomOut(){
      if (state.transitioning) return;
      if (H.atWall(state.history)) { bounce(); return; }
      const restored = H.reconcilePop(state.history, state.snapshot);
      if (!restored) {
        transitionTo({ level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] }, 'out');
        showToast('Earlier views no longer exist — back to all projects.');
        return;
      }
      transitionTo(restored, 'out');
    }
```

with:

```js
    function zoomOut(){
      if (state.transitioning) return;
      if (H.navAtWall(state.tree)) { bounce(); return; }
      // Keep this view current before leaving it, so re-diving here later
      // restores the card you were on rather than the one you arrived on.
      H.navSetCursorView(state.tree, currentViewSnapshot());
      const restored = H.navReconcileBack(state.tree, state.snapshot);
      if (!restored) {
        transitionTo({ level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] }, 'out');
        showToast('Earlier views no longer exist — back to all projects.');
        return;
      }
      transitionTo(restored, 'out');
    }
```

- [ ] **Step 4: Route reconciliation through the tree**

In `refreshAndReconcile()`, replace:

```js
      const result = H.reconcileView(before, prevIds, state.snapshot);
      if (result.status === 'invalid') {
        const restored = H.reconcilePop(state.history, state.snapshot);
        state.view = restored ?? { level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] };
        if (hadItems) showToast(restored ? 'This view emptied — zoomed out to the last valid one.' : 'This view emptied — back to all projects.');
      } else {
        state.view = result.view;
        if (result.status === 'neighbor' && hadCentered) showToast('The centered card was removed — showing its neighbor.');
      }
      buildDrum();
```

with:

```js
      const result = H.reconcileView(before, prevIds, state.snapshot);
      if (result.status === 'invalid') {
        const restored = H.navReconcileBack(state.tree, state.snapshot);
        state.view = restored ?? { level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] };
        if (hadItems) showToast(restored ? 'This view emptied — zoomed out to the last valid one.' : 'This view emptied — back to all projects.');
      } else {
        state.view = result.view;
        H.navSetCursorView(state.tree, result.view);
        if (result.status === 'neighbor' && hadCentered) showToast('The centered card was removed — showing its neighbor.');
      }
      buildDrum();
```

- [ ] **Step 5: Show the depth in the level pill**

In `updateChrome()`, add a `depthNow` helper directly above the function and use it:

```js
    function depthNow(){ return H.navDepth(state.tree); }
```

and in `updateChrome()` replace:

```js
      els.levelName.textContent = level[0].toUpperCase() + level.slice(1);
```

with:

```js
      els.levelName.textContent = `${level[0].toUpperCase() + level.slice(1)} · 0^${depthNow()}`;
```

- [ ] **Step 6: Verify nothing regressed and depth tracks dives**

Run: `node --test test/rolodex-helpers.test.mjs test/bridge-rolodex-routes.test.mjs`
Expected: PASS (41 tests total).

Extract the inline module and syntax-check it:

```bash
node -e "const fs=require('fs');const m=fs.readFileSync('scripts/nd-mem-rolodex.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync(process.env.TEMP+'/rolodex-inline.mjs',m[1]);console.log('extracted',m[1].length)"
node --check "$TEMP/rolodex-inline.mjs"
```

Expected: no output from `--check` (success).

Then in a browser (bridge running), with `scratch-depth.mjs`:

```js
import { chromium } from 'file:///C:/Users/jerio/RiderProjects/neurodivergent-memory/node_modules/playwright/index.mjs';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:3737/rolodex');
await page.waitForSelector('.card3d.front', { timeout: 15000 });
await page.waitForTimeout(500);
const badge = async () => (await page.textContent('#levelName')).trim();
const dive = async () => { const bb = await page.locator('.card3d.front').boundingBox(); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(1900); };
console.log('start:', await badge());          // expect "Projects · 0^0"
await dive(); console.log('dive 1:', await badge());  // "Districts · 0^1"
await dive(); console.log('dive 2:', await badge());  // "Memories · 0^2"
await dive(); console.log('wrap:  ', await badge());  // "Projects · 0^3"  <- wrap counts
await page.keyboard.press('Escape'); await page.waitForTimeout(1900);
console.log('back:  ', await badge());          // "Memories · 0^2"
await b.close();
```

Expected: exactly the commented values, proving the wrap is an ordinary dive.

- [ ] **Step 7: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): page navigates by tree; depth badge counts every dive"
```

---

### Task 6: Coordinate display with clickable segments

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` (CSS, `updateChrome`, new click handler)

**Interfaces:**
- Consumes: `coordinateOf` (Task 3), `navFindContext`, `navReconcileJump` (Task 2), `depthNow` (Task 5), `transitionTo`.
- Produces: `jumpToNode(nodeId)` — reused by Task 7's minimap.

- [ ] **Step 1: Style the coordinate**

In the `<style>` block, add after the `#levelName{...}` rule:

```css
    #crumb{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.78rem;letter-spacing:.02em;max-width:52vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #crumb .seg{background:none;border:0;padding:0 2px;font:inherit;color:var(--muted);cursor:pointer;border-radius:4px}
    #crumb .seg:hover{color:var(--text);background:rgba(96,215,210,.14)}
    #crumb .seg.depth{color:var(--primary);font-weight:600}
    #crumb .seg.leaf,#crumb .seg:disabled{color:var(--text);cursor:default}
    #crumb .seg:disabled:hover{background:none}
    #crumb .sep{color:var(--faint);padding:0 1px}
```

- [ ] **Step 2: Render the coordinate**

In `updateChrome()`, replace:

```js
      els.crumb.innerHTML = level === 'projects' ? '<strong>All projects</strong>'
        : level === 'districts' ? `<strong>${esc(projectId)}</strong>`
        : `<strong>${esc(projectId)}</strong> ▸ ${esc(districtId)}`;
```

with:

```js
      // `0^N > project > district > card`: N answers "how deep", the path
      // answers "where", and each segment is a way back to that view.
      const segs = H.coordinateOf(state.view, depthNow(), centeredItem()?.id ?? null);
      els.crumb.innerHTML = segs.map((s, i) => {
        const sep = i ? '<span class="sep">&gt;</span>' : '';
        const jumpable = s.kind === 'depth' || s.target != null;
        return sep + `<button class="seg ${s.kind}" data-seg="${i}"${jumpable ? '' : ' disabled'}>${esc(s.text)}</button>`;
      }).join('');
      els.crumb.dataset.segments = JSON.stringify(segs.map(s => s.target));
```

- [ ] **Step 3: Add the shared jump helper and the coordinate click handler**

Add directly below `zoomOut()`:

```js
    // One animated hop, however far back the target is — replaying a
    // transition per level would make a seven-deep jump take ten seconds.
    function jumpToNode(nodeId){
      if (state.transitioning) return;
      H.navSetCursorView(state.tree, currentViewSnapshot());
      const view = H.navReconcileJump(state.tree, nodeId, state.snapshot);
      if (!view) {
        transitionTo({ level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] }, 'out');
        showToast('That view no longer exists — back to all projects.');
        return;
      }
      transitionTo(view, 'out');
    }

    els.crumb.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('.seg') : null;
      if (!btn || btn.disabled || state.transitioning) return;
      const targets = JSON.parse(els.crumb.dataset.segments || '[]');
      const target = targets[Number(btn.dataset.seg)];
      if (target === null || target === undefined) {
        // The depth badge is the origin: go all the way home.
        if (btn.classList.contains('depth') && !H.navAtWall(state.tree)) jumpToNode(0);
        return;
      }
      const nodeId = H.navFindContext(state.tree, target);
      if (nodeId === null) { showToast('That step is not on the path you walked.'); return; }
      jumpToNode(nodeId);
    });
```

- [ ] **Step 4: Verify**

Run: `node --test test/rolodex-helpers.test.mjs test/bridge-rolodex-routes.test.mjs`
Expected: PASS (42 tests: 41 helpers + 1 bridge route).

Extract + `node --check` the inline module as in Task 5 Step 6. Expected: success.

Browser check with `scratch-coord.mjs` (bridge running):

```js
import { chromium } from 'file:///C:/Users/jerio/RiderProjects/neurodivergent-memory/node_modules/playwright/index.mjs';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:3737/rolodex');
await page.waitForSelector('.card3d.front', { timeout: 15000 });
await page.waitForTimeout(500);
const coord = async () => (await page.textContent('#crumb')).replace(/\s+/g, ' ').trim();
const dive = async () => { const bb = await page.locator('.card3d.front').boundingBox(); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(1900); };
console.log('depth 0:', await coord());
await dive(); await dive();
console.log('depth 2:', await coord());   // expect 0^2 > <project> > <district> > <memory id>
await page.locator('#crumb .seg.project').click();
await page.waitForTimeout(1900);
console.log('after clicking project segment:', await coord(), '(expect 0^1)');
await page.locator('#crumb .seg.depth').click();
await page.waitForTimeout(1900);
console.log('after clicking depth badge:', await coord(), '(expect 0^0)');
await b.close();
```

Expected: depth climbs to `0^2` with three path segments, clicking the project segment returns to `0^1`, clicking the badge returns to `0^0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): clickable 0^N coordinate replaces the breadcrumb"
```

---

### Task 7: Exploration-tree minimap

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` (CSS, markup, render function, click + toggle handlers)

**Interfaces:**
- Consumes: `layoutNavTree` (Task 3), `jumpToNode` (Task 6).
- Produces: `renderMinimap()` — called from `updateChrome()`.

- [ ] **Step 1: Add the minimap CSS**

Add to the `<style>` block after the `#hud{...}` rule:

```css
    #minimap{position:fixed;left:0;top:64px;bottom:64px;z-index:9;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;gap:8px;padding:10px;pointer-events:none}
    #minimap>*{pointer-events:auto}
    #mapToggle{font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;padding:6px 10px}
    #mapBody{max-height:100%;overflow:auto;border-radius:16px;border:1px solid var(--surfaceBorder);background:var(--surface);backdrop-filter:blur(10px);padding:6px}
    #minimap.collapsed #mapBody{display:none}
    #mapBody svg{display:block}
    #mapBody .edge{stroke:var(--faint);stroke-width:1.5;opacity:.45}
    #mapBody .edge.on{stroke:var(--primary);opacity:.9}
    #mapBody .node{fill:var(--surface);stroke:var(--faint);stroke-width:1.5;cursor:pointer}
    #mapBody .node.on{stroke:var(--primary)}
    #mapBody .node.cursor{fill:var(--primary);stroke:var(--primary)}
    #mapBody .node:hover{stroke:var(--text)}
    @media (prefers-reduced-motion: no-preference){#mapBody .node.cursor{animation:pulse 1.8s ease-in-out infinite}}
    @keyframes pulse{0%,100%{r:5}50%{r:7}}
```

- [ ] **Step 2: Add the minimap markup**

Directly after the `<div id="hud">…</div>` line, add:

```html
  <div id="minimap"><div id="mapBody"></div><button class="pill" id="mapToggle" title="Toggle the exploration map">Map 0^0</button></div>
```

- [ ] **Step 3: Register the elements**

In the `els` object literal, add these two entries:

```js
minimap: $('#minimap'), mapBody: $('#mapBody'), mapToggle: $('#mapToggle'),
```

- [ ] **Step 4: Render the tree**

Add directly above `updateChrome()`:

```js
    // The map is drawn from the tree itself, never from a parallel record, so
    // it cannot drift out of sync with where you can actually go. A layout
    // failure must not take navigation down with it — the rail hides instead.
    function renderMinimap(){
      els.mapToggle.textContent = `Map 0^${depthNow()}`;
      if (els.minimap.classList.contains('collapsed')) return;
      try {
        const laid = H.layoutNavTree(state.tree);
        const edges = laid.edges.map(e =>
          `<line class="edge${e.onPath ? ' on' : ''}" x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" />`).join('');
        const nodes = laid.nodes.map(n =>
          `<circle class="node${n.onPath ? ' on' : ''}${n.isCursor ? ' cursor' : ''}" data-node="${n.id}" cx="${n.x}" cy="${n.y}" r="5"><title>${esc(n.label)} (0^${n.depth})</title></circle>`).join('');
        els.mapBody.innerHTML = `<svg width="${laid.width}" height="${laid.height}" viewBox="0 0 ${laid.width} ${laid.height}">${edges}${nodes}</svg>`;
        els.mapBody.scrollTop = 0; // deepest row is at the top; keep the frontier in view
      } catch (err) {
        console.error('minimap layout failed', err);
        els.minimap.style.display = 'none';
      }
    }
```

- [ ] **Step 5: Call it and wire the interactions**

At the end of `updateChrome()`, add as the final statement:

```js
      renderMinimap();
```

Then add below the `els.crumb.addEventListener('click', …)` handler from Task 6:

```js
    els.mapBody.addEventListener('click', (e) => {
      const circle = e.target instanceof Element ? e.target.closest('[data-node]') : null;
      if (!circle) return;
      const id = Number(circle.dataset.node);
      if (id === state.tree.cursor) return;
      jumpToNode(id);
    });
    const MAP_KEY = 'ndmem.rolodex.minimap';
    els.mapToggle.addEventListener('click', () => {
      const collapsed = els.minimap.classList.toggle('collapsed');
      try { localStorage.setItem(MAP_KEY, collapsed ? 'collapsed' : 'open'); } catch {}
      renderMinimap();
    });
    try { if (localStorage.getItem(MAP_KEY) === 'collapsed') els.minimap.classList.add('collapsed'); } catch {}
```

- [ ] **Step 6: Verify**

Run: `node --test test/rolodex-helpers.test.mjs test/bridge-rolodex-routes.test.mjs`
Expected: PASS (42 tests: 41 helpers + 1 bridge route).

Extract + `node --check` the inline module. Expected: success.

Browser check with `scratch-map.mjs` (bridge running):

```js
import { chromium } from 'file:///C:/Users/jerio/RiderProjects/neurodivergent-memory/node_modules/playwright/index.mjs';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:3737/rolodex');
await page.waitForSelector('.card3d.front', { timeout: 15000 });
await page.waitForTimeout(500);
const dive = async () => { const bb = await page.locator('.card3d.front').boundingBox(); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(1900); };
const nodes = () => page.locator('#mapBody [data-node]').count();
await dive(); await dive();
console.log('nodes after 2 dives:', await nodes(), '(expect 3)');
await page.keyboard.press('Escape'); await page.waitForTimeout(1900);
await page.keyboard.press('Escape'); await page.waitForTimeout(1900);
await page.locator('.card3d:not(.front)').first().click(); await page.waitForTimeout(2600); // fork elsewhere
console.log('nodes after forking:', await nodes(), '(expect 4 — the dead branch survives)');
const dead = page.locator('#mapBody [data-node]:not(.on)').first();
await dead.click(); await page.waitForTimeout(1900);
console.log('jumped to dead branch, depth badge:', (await page.textContent('#levelName')).trim());
await page.locator('#mapToggle').click(); await page.waitForTimeout(200);
console.log('collapsed:', await page.locator('#minimap.collapsed').count(), '(expect 1)');
await b.close();
```

Expected: 3 nodes after two dives, 4 after forking (dead branch retained), clicking a dead node navigates, and the toggle collapses the rail.

- [ ] **Step 7: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): exploration-tree minimap with click-to-jump"
```

---

### Task 8: Fan layout wiring

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` (`buildDrum`, `applyDrumTransform`, `updateFrontCard`, `stepBy`, `tick`, `cardIndexAtPoint`, click-to-center)

**Interfaces:**
- Consumes: `drumLayout`, `rotationForCard`, `indexAtRotation`, `snapRotation`, `clampRotation` (Task 1).
- Produces: `state.layout` — the single geometry descriptor every consumer reads.

- [ ] **Step 1: Build the layout once per drum**

Four replacements inside `buildDrum()`. First, replace:

```js
      state.radius = H.drumRadius(cardW, n);
      els.stage.dataset.level = state.view.level;
      const theta = H.anglePerCard(n);
```

with:

```js
      // One descriptor drives placement, hit-testing, snapping and clamping,
      // so fan and cylinder never need a branch at the call site. It is
      // assigned before the empty-drum return below, because updateFrontCard
      // reads it even when there is nothing to show.
      state.layout = H.drumLayout(cardW, n);
      state.radius = state.layout.radius;
      els.stage.dataset.level = state.view.level;
      els.stage.dataset.layout = state.layout.mode;
```

Second, `theta` no longer exists, so replace the gesture-gain line:

```js
      state.gestureGain = Math.min(3, Math.max(0.2, theta / 30));
```

with:

```js
      state.gestureGain = Math.min(3, Math.max(0.2, state.layout.step / 30));
```

Third, replace the card-emitting line and the rotation that follows it:

```js
      els.drum.innerHTML = state.items.map((item, i) =>
        `<div class="card3d" data-idx="${i}" style="transform:rotateY(${i * theta}deg) translateZ(${state.radius}px)">${cardFace(item)}</div>`).join('');
      const idx = Math.max(0, state.items.findIndex(i => i.id === state.view.centeredId));
      state.rotation = H.rotationForIndex(idx, n);
```

with:

```js
      els.drum.innerHTML = state.items.map((item, i) =>
        `<div class="card3d" data-idx="${i}" style="transform:rotateY(${state.layout.angles[i]}deg) translateZ(${state.radius}px)">${cardFace(item)}</div>`).join('');
      const idx = Math.max(0, state.items.findIndex(i => i.id === state.view.centeredId));
      state.rotation = H.rotationForCard(idx, state.layout);
```

Fourth, add `layout: H.drumLayout(340, 0),` to the `state` object literal,
directly below `radius: 260,`.

- [ ] **Step 2: Use the layout for front-card detection**

In `updateFrontCard()`, replace these two lines:

```js
      const n = state.items.length;
      const idx = H.nearestIndex(state.rotation, n);
```

with:

```js
      const idx = H.indexAtRotation(state.rotation, state.layout);
```

(`n` was only ever used by that one call, so it goes with it.)

- [ ] **Step 3: Use the layout for arrow steps**

Replace the first two statements of `stepBy()`:

```js
      const target = H.rotationForIndex(((state.frontIndex + n) % count + count) % count, count);
      const goal = state.rotation + H.shortestDelta(state.rotation, target);
```

with:

```js
      // A fan has ends: stepping past them is a no-op rather than a wrap.
      const raw = state.frontIndex + n;
      const idx = state.layout.mode === 'fan'
        ? Math.min(count - 1, Math.max(0, raw))
        : ((raw % count) + count) % count;
      if (idx === state.frontIndex) return;
      const target = H.rotationForCard(idx, state.layout);
      const goal = state.layout.mode === 'fan' ? target : state.rotation + H.shortestDelta(state.rotation, target);
```

- [ ] **Step 4: Clamp the animation loop**

In `tick()`, replace:

```js
        } else if (Math.abs(state.velocity) > 0.02) {
          state.rotation += state.velocity;
```

with:

```js
        } else if (Math.abs(state.velocity) > 0.02) {
          state.rotation += state.velocity;
          // A fan cannot spin past its end cards; kill the momentum at the
          // rail so it settles instead of grinding against the clamp.
          const clamped = H.clampRotation(state.rotation, state.layout);
          if (clamped !== state.rotation) { state.rotation = clamped; state.velocity = 0; }
```

and replace the snap branch:

```js
          state.velocity = 0;
          const target = H.snapTarget(state.rotation, state.items.length);
```

with:

```js
          state.velocity = 0;
          const target = H.snapRotation(state.rotation, state.layout);
```

- [ ] **Step 5: Clamp the drag path**

In the `pointermove` drag branch, replace:

```js
        const spin = dx * 0.22 * state.gestureGain;
        state.rotation += spin;
```

with:

```js
        const spin = dx * 0.22 * state.gestureGain;
        state.rotation = H.clampRotation(state.rotation + spin, state.layout);
```

- [ ] **Step 6: Teach the geometric hit-test about fan angles**

In `cardIndexAtPoint()`, replace:

```js
      const theta = H.anglePerCard(n);
```

with:

```js
      const angles = state.layout.angles;
```

and replace:

```js
        const a = (state.rotation + i * theta) * Math.PI / 180;
```

with:

```js
        const a = (state.rotation + angles[i]) * Math.PI / 180;
```

- [ ] **Step 7: Use the layout when centering a clicked card**

In the card click handler, replace:

```js
        const target = H.rotationForIndex(idx, state.items.length);
        state.rotation += H.shortestDelta(state.rotation, target);
```

with:

```js
        const target = H.rotationForCard(idx, state.layout);
        state.rotation = state.layout.mode === 'fan' ? target : state.rotation + H.shortestDelta(state.rotation, target);
```

- [ ] **Step 8: Verify**

Run: `node --test test/rolodex-helpers.test.mjs test/bridge-rolodex-routes.test.mjs`
Expected: PASS (42 tests: 41 helpers + 1 bridge route).

Extract + `node --check` the inline module. Expected: success.

Browser check with `scratch-fan.mjs` (bridge running). It dives into projects
until it finds a drum of ≤ 4 cards and asserts every card is visible:

```js
import { chromium } from 'file:///C:/Users/jerio/RiderProjects/neurodivergent-memory/node_modules/playwright/index.mjs';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:3737/rolodex');
await page.waitForSelector('.card3d.front', { timeout: 15000 });
await page.waitForTimeout(500);
// find a project whose district drum is small, by diving into each in turn
for (let i = 0; i < 6; i++) {
  const bb = await page.locator('.card3d.front').boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForTimeout(1900);
  const count = await page.locator('.card3d[data-idx]').count();
  const mode = await page.getAttribute('#stage', 'data-layout');
  console.log(`districts drum: ${count} cards, layout=${mode}`);
  if (count <= 4) {
    const widths = await page.locator('.card3d[data-idx]').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().width)));
    console.log('  card widths on screen:', widths, '(all should be > 100 — every card faces forward)');
    // rotation must clamp: spin hard right, the first card stays centered
    await page.mouse.move(800, 500);
    for (let k = 0; k < 12; k++) await page.mouse.wheel(0, -400);
    await page.waitForTimeout(1200);
    console.log('  position after over-spinning:', (await page.textContent('#position')).trim(), '(expect card 1 / N)');
    break;
  }
  await page.keyboard.press('Escape'); await page.waitForTimeout(1900);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(700);
}
await b.close();
```

Expected: a ≤4-card drum reports `layout=fan`, every card has a real on-screen
width (none edge-on at ~0px), and over-spinning parks at `card 1 / N` instead of
wrapping.

- [ ] **Step 9: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): fan layout for drums of four cards or fewer"
```

---

### Task 9: In-app project rename

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` (helpers import, CSS reuse, modal markup, `cardFace`, handlers)

**Interfaces:**
- Consumes: `normalizeProjectId`, `nearMissOf` from `/nd-mem-app-helpers.mjs`; `navRemapProject` (Task 2); `deriveProjects`, `deriveMemories` (existing).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Import the classic app's rename helpers**

In `scripts/nd-mem-rolodex.html`, directly below the existing helpers import:

```js
    const H = await import(BRIDGE + '/nd-mem-rolodex-helpers.mjs');
```

add:

```js
    // Rename/merge semantics are the classic app's; import them rather than
    // reimplement, so both UIs always agree on what counts as a collision.
    let RENAME_HELPERS = null;
    try { RENAME_HELPERS = await import(BRIDGE + '/nd-mem-app-helpers.mjs'); } catch { /* rename button explains when clicked */ }
```

- [ ] **Step 2: Add the rename modal markup**

Directly after the closing `</div>` of `#editModalBg` (before `<div id="toast">`), add:

```html
  <div class="modalbg" id="renameModalBg">
    <div class="modal">
      <h2>Rename project</h2>
      <div class="grid">
        <div class="field span2"><label>New project id</label><input id="renameInput" /></div>
      </div>
      <p class="hint" id="renameHint"></p>
      <div class="foot"><button class="btn" id="renameCancelBtn">Cancel</button><button class="btn primary" id="renameGoBtn">Rename</button></div>
    </div>
  </div>
```

Add this CSS rule next to the other modal rules:

```css
    .hint{color:var(--muted);font-size:.82rem;line-height:1.5;margin-top:10px}
```

- [ ] **Step 3: Put a Rename button on project cards**

In `cardFace()`, replace the project branch:

```js
      if (item.kind === 'project') return `<span class="kicker">Project</span><h2>${esc(d.id)}</h2><div class="chips"><span class="chip">${d.memoryCount} memories</span><span class="chip">${d.districtCount} district${d.districtCount === 1 ? '' : 's'}</span></div>`;
```

with:

```js
      if (item.kind === 'project') {
        // Only the front card shows actions (see `.card3d .actions`), and the
        // unassigned bucket is not a project you can rename.
        const canRename = d.id !== H.UNASSIGNED;
        return `<span class="kicker">Project</span><h2>${esc(d.id)}</h2>`
          + `<div class="chips"><span class="chip">${d.memoryCount} memories</span><span class="chip">${d.districtCount} district${d.districtCount === 1 ? '' : 's'}</span></div>`
          + (canRename ? `<div class="actions"><button class="btn" data-rename="${esc(d.id)}">Rename…</button></div>` : '');
      }
```

- [ ] **Step 4: Implement the rename flow**

Add directly above the `els.stage.addEventListener('click', …)` handler that
opens the edit modal:

```js
    // ---------- project rename ----------
    function openRenameModal(projectId){
      if (!RENAME_HELPERS) { showToast('Rename helpers unavailable — is the bridge running?'); return; }
      state.renamingProject = projectId;
      $('#renameInput').value = projectId;
      $('#renameHint').textContent = 'Renaming onto an existing project merges into it.';
      $('#renameModalBg').classList.add('open');
      $('#renameInput').focus();
      $('#renameInput').select();
    }

    // Sequential, not parallel: every write goes through the single-writer
    // daemon, and a partial run must leave a coherent store the user can
    // finish by re-running the rename.
    async function bulkReassign(ids, target, source){
      setWritesDisabled(true);
      let moved = 0;
      try {
        for (const id of ids) {
          showToast(`Moving ${moved + 1}/${ids.length} into ${target}…`);
          let ok = false;
          try {
            const res = await fetch(`${BRIDGE}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memoryId: id, projectId: target }) });
            const data = await res.json();
            ok = res.ok && data.ok;
          } catch { ok = false; }
          if (!ok) { showToast(`Moved ${moved} of ${ids.length}. Re-run the rename to move the rest.`); return false; }
          moved++;
        }
        // Only a complete run may remap the tree: a partial one leaves both
        // ids real, and rewriting history to a half-existing project would
        // strand every node that referenced it.
        H.navRemapProject(state.tree, source, target);
        if (state.view.projectId === source) state.view.projectId = target;
        if (state.view.level === 'projects' && state.view.centeredId === source) state.view.centeredId = target;
        showToast(`Moved ${moved} card${moved === 1 ? '' : 's'} from ${source} to ${target}.`);
        return true;
      } finally {
        setWritesDisabled(false);
      }
    }

    function setWritesDisabled(disabled){
      for (const id of ['renameGoBtn', 'editSaveBtn']) { const el = $('#' + id); if (el) el.disabled = disabled; }
    }

    async function submitRename(){
      const source = state.renamingProject;
      const typed = $('#renameInput').value.trim();
      if (!source || !typed || typed === source) { $('#renameModalBg').classList.remove('open'); return; }
      const { normalizeProjectId, nearMissOf } = RENAME_HELPERS;
      if (normalizeProjectId(typed) === normalizeProjectId(H.UNASSIGNED)) { showToast('That name is reserved for unassigned cards.'); return; }

      const others = H.deriveProjects(state.snapshot).filter(p => p.id !== H.UNASSIGNED && p.id !== source);
      const collision = others.find(o => normalizeProjectId(o.id) === normalizeProjectId(typed));
      // Every memory in the project, across all its districts. Keyed the same
      // way the helpers read the snapshot, so a record without its own `id`
      // field still resolves.
      const ids = Object.entries(state.snapshot.memories || {})
        .filter(([, m]) => H.projectOf(m) === source)
        .map(([key, m]) => String(m.id ?? key));

      let target = typed;
      if (collision) {
        if (!confirm(`Project "${collision.id}" already exists (${collision.memoryCount} cards). Move all ${ids.length} cards from "${source}" into it?`)) return;
        target = collision.id; // the existing spelling is canonical
      } else {
        const near = nearMissOf(typed, others.map(o => o.id));
        if (near && confirm(`Did you mean "${near}"? OK moves all ${ids.length} cards into "${near}"; Cancel keeps "${typed}".`)) target = near;
      }

      $('#renameModalBg').classList.remove('open');
      const ok = await bulkReassign(ids, target, source);
      try { await loadSnapshot(); refreshAndReconcile(); } catch {}
      if (ok) state.renamingProject = null;
    }

    $('#renameCancelBtn').addEventListener('click', () => $('#renameModalBg').classList.remove('open'));
    $('#renameGoBtn').addEventListener('click', submitRename);
    $('#renameModalBg').addEventListener('click', (e) => { if (e.target.id === 'renameModalBg') $('#renameModalBg').classList.remove('open'); });
    $('#renameModalBg').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); $('#renameModalBg').classList.remove('open'); return; }
      if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); submitRename(); }
    });
    els.stage.addEventListener('click', (e) => {
      if (dragMoved > 8 || state.transitioning) return;
      let hit = (pressTarget && pressTarget.isConnected) ? pressTarget : (e.target instanceof Element ? e.target : null);
      if (!hit || !hit.closest('[data-rename]')) {
        const under = document.elementFromPoint(e.clientX, e.clientY);
        if (under instanceof Element) hit = under;
      }
      const btn = hit ? hit.closest('[data-rename]') : null;
      if (btn) openRenameModal(btn.dataset.rename);
    });
```

Add `renamingProject: null,` to the `state` object literal, below `editingDistrict`.

Note on `confirm()`: the merge and near-miss steps use the native dialog, exactly
as the classic app does, so both UIs ask the same questions in the same words.
Only the new-name entry gets a modal, because a text `prompt()` is the part that
felt cheap.

- [ ] **Step 5: Verify**

Run: `node --test test/rolodex-helpers.test.mjs test/bridge-rolodex-routes.test.mjs`
Expected: PASS (42 tests: 41 helpers + 1 bridge route).

Extract + `node --check` the inline module. Expected: success.

Browser check with `scratch-rename.mjs` — this one **writes to the real store**,
so it renames a scratch project back and forth. Create the scratch memory first:

```bash
node -e "
const body = JSON.stringify({ content: 'rename smoke test card', district: 'practical_execution', projectId: 'rolodex_rename_probe', tags: ['kind:test'] });
fetch('http://localhost:3737/save', { method:'POST', headers:{'Content-Type':'application/json'}, body }).then(r=>r.json()).then(d=>console.log(d.ok));
"
```

Then:

```js
import { chromium } from 'file:///C:/Users/jerio/RiderProjects/neurodivergent-memory/node_modules/playwright/index.mjs';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('dialog', d => d.accept());
await page.goto('http://localhost:3737/rolodex');
await page.waitForSelector('.card3d.front', { timeout: 15000 });
await page.waitForTimeout(600);
// spin until the probe project is centered
for (let i = 0; i < 60; i++) {
  const title = (await page.locator('.card3d.front h2').textContent()).trim();
  if (title === 'rolodex_rename_probe') break;
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(320);
}
console.log('centered:', (await page.locator('.card3d.front h2').textContent()).trim());
await page.locator('.card3d.front [data-rename]').click();
await page.waitForTimeout(300);
await page.fill('#renameInput', 'rolodex_rename_probe2');
await page.locator('#renameGoBtn').click();
await page.waitForTimeout(4000);
console.log('after rename, coordinate:', (await page.textContent('#crumb')).replace(/\s+/g,' ').trim());
console.log('front card now:', (await page.locator('.card3d.front h2').textContent()).trim(), '(expect rolodex_rename_probe2)');
await b.close();
```

Expected: the front card title becomes `rolodex_rename_probe2` and no
"view emptied" toast fires. Clean up afterwards by deleting the probe memory
through the classic app at `http://localhost:3737/`.

- [ ] **Step 6: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): rename projects without leaving the rolodex"
```

---

### Task 10: Docs and full-suite verification

**Files:**
- Modify: `README.md` (the `### Rolodex view` subsection)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)

**Interfaces:** none.

- [ ] **Step 1: Extend the README subsection**

In `README.md`, at the end of the `### Rolodex view` paragraph, add:

```markdown

Navigation aids:

- **Coordinate** — the top-left readout is `0^N > project > district > card`,
  where `N` counts every dive you have made this session (the wrap from
  memories back to projects counts too). Click any segment to jump back to
  that view; click `0^N` to return to where you started.
- **Exploration map** — the left rail draws your session as a tree growing up
  from the floor. Branches you abandoned stay, dimmed; the path you are on
  glows. Click any node — live or abandoned — to jump straight there. The
  `Map` chip collapses the rail, and the choice is remembered.
- **Small drums fan out** — a drum of four cards or fewer spreads into a
  forward-facing arc so every card is readable at once instead of hiding
  around the back of a cylinder; five or more keeps the rotating cylinder.
- **Rename projects in place** — the front project card has a `Rename…`
  button with the same merge and "did you mean" behavior as the classic app.
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `[Unreleased]` → `### Added`, append:

```markdown
- **Rolodex navigation aids.** The rolodex view gained a `0^N` coordinate
  readout (depth plus project/district/card path, every segment clickable), a
  collapsible left-rail minimap that draws the session's exploration as a
  bottom-rooted tree — abandoned branches included, every node a one-hop jump
  — in-app project rename reusing the classic app's merge/near-miss helpers,
  and a fan layout that spreads drums of four cards or fewer into a
  forward-facing arc instead of a degenerate cylinder. Clicks now dive at
  every level, memories included. Internally the history stack became a
  navigation tree whose active path preserves the previous wall, zoom-out and
  reconciliation semantics. See
  `docs/superpowers/specs/2026-07-29-rolodex-navigation-aids-design.md`.
```

- [ ] **Step 3: Run the full suite and lint**

Run: `npm test`
Expected: all tests pass except the two known pre-existing failures in
`test/agent-customization-wording.test.mjs` (agent-kit template wording drift,
unrelated to this branch). Report the exact counts.

Run: `npm run lint:md`
Expected: clean, exit 0.

- [ ] **Step 4: Walk the spec's manual checklist**

With the bridge running (`node scripts/nd-mem-bridge-server.mjs --open`), open
`http://localhost:3737/rolodex` and confirm by hand:

1. The coordinate reads `0^0` at the start and climbs with every dive,
   including the memories→projects wrap.
2. Clicking a coordinate segment and a minimap node each take one animation.
3. A dead branch stays drawn after backing out and diving elsewhere.
4. The `Map` chip collapses the rail; a reload keeps it collapsed.
5. A project with ≤ 4 districts fans out with every district readable; a
   project with ≥ 5 keeps the cylinder and still wraps past the ends.
6. Clicking a memory card's body dives onward; the Edit button still opens the
   modal; wheel inside a long memory still scrolls it.
7. Renaming a project updates the coordinate and the map without a spurious
   "view emptied" toast.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(rolodex): document the navigation aids"
```
