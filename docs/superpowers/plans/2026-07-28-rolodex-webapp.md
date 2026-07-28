# Nested 3D Rolodex Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/rolodex` page on the bridge that browses the memory store as nested 3D cylinder carousels (Projects → Districts → Memories) with cyclic dive, history-stack zoom-out, wall bounce, a front-card reader, and edit-only writes.

**Architecture:** Pure CSS 3D transforms (perspective + `rotateY`/`translateZ` cylinder) in one new single-file HTML page, all navigation/derivation logic in a DOM-free ES module served by the bridge and unit-tested with node:test. The bridge gains two static GET routes via a consolidated static-file helper. The classic app is untouched except one cross-link.

**Tech Stack:** Vanilla JS ES modules, CSS 3D, Express (existing bridge), node:test + node:assert/strict.

**Spec:** `docs/superpowers/specs/2026-07-28-rolodex-webapp-design.md` — read it before starting any task.

## Global Constraints

- No new dependencies, no build step for any web asset. Plain JS — no TypeScript syntax in `.mjs`/`.html` files.
- New page served at `GET /rolodex`; helpers at `GET /nd-mem-rolodex-helpers.mjs`. Classic app stays at `/` and keeps working.
- All file paths in the bridge resolve off `SCRIPT_DIR` (import.meta.url), never `process.cwd()`.
- Derivation semantics must match the classic app: empty/null `project_id` → `(no project)`; empty `district` → `uncategorized`.
- Version stays 0.3.9; CHANGELOG entries go under `[Unreleased]`. No version bumps.
- Tests run with `node --test test/<file>` during development; the full `npm test` (which builds first) must pass at the end.
- Windows dev shell; commands below use `bash`-compatible syntax (Claude's Bash tool runs Git Bash).

---

### Task 1: Helpers module — snapshot derivations

**Files:**
- Create: `scripts/nd-mem-rolodex-helpers.mjs`
- Create: `test/rolodex-helpers.test.mjs`

**Interfaces:**
- Produces (used by every later task):
  - `UNASSIGNED = '(no project)'`, `UNCATEGORIZED = 'uncategorized'`, `CANONICAL_DISTRICTS: string[]`
  - `projectOf(memory) -> string`, `districtOf(memory) -> string`
  - `deriveProjects(snapshot) -> [{id, memoryCount, districtCount}]` — `(no project)` last, then count desc, then name asc
  - `deriveDistricts(snapshot, projectId) -> [{id, memoryCount, topTags}]` — canonical district order first, unknown districts alphabetical after; `topTags` = 3 most frequent string tags
  - `deriveMemories(snapshot, projectId, districtId) -> memory[]` — newest `created` first, id asc tiebreak; each memory has `.id`

- [ ] **Step 1: Write the failing tests**

Create `test/rolodex-helpers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNASSIGNED, UNCATEGORIZED, CANONICAL_DISTRICTS,
  projectOf, districtOf, deriveProjects, deriveDistricts, deriveMemories,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — cannot find module `nd-mem-rolodex-helpers.mjs`.

- [ ] **Step 3: Write the implementation**

Create `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// Pure, DOM-free logic for the 3D rolodex page (scripts/nd-mem-rolodex.html).
// Imported by the browser as an ES module (served by the bridge) and by the
// node:test suite directly. Keep this file free of DOM and network access.

export const UNASSIGNED = '(no project)';
export const UNCATEGORIZED = 'uncategorized';
export const CANONICAL_DISTRICTS = ['logical_analysis', 'emotional_processing', 'practical_execution', 'vigilant_monitoring', 'creative_synthesis'];

export function projectOf(memory) {
  const p = memory.project_id;
  return (p !== undefined && p !== null && String(p).trim() !== '') ? String(p) : UNASSIGNED;
}

export function districtOf(memory) {
  return memory.district || UNCATEGORIZED;
}

function allMemories(snapshot) {
  return Object.entries(snapshot?.memories || {}).map(([key, m]) => ({ ...m, id: String(m.id ?? key) }));
}

export function deriveProjects(snapshot) {
  const byProject = new Map();
  for (const m of allMemories(snapshot)) {
    const p = projectOf(m);
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p).push(m);
  }
  const ids = [...byProject.keys()].sort((a, b) =>
    (a === UNASSIGNED) - (b === UNASSIGNED) || byProject.get(b).length - byProject.get(a).length || a.localeCompare(b));
  return ids.map(id => ({
    id,
    memoryCount: byProject.get(id).length,
    districtCount: new Set(byProject.get(id).map(districtOf)).size,
  }));
}

export function deriveDistricts(snapshot, projectId) {
  const byDistrict = new Map();
  for (const m of allMemories(snapshot)) {
    if (projectOf(m) !== projectId) continue;
    const d = districtOf(m);
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d).push(m);
  }
  const present = [...byDistrict.keys()];
  const ordered = CANONICAL_DISTRICTS.filter(d => byDistrict.has(d))
    .concat(present.filter(d => !CANONICAL_DISTRICTS.includes(d)).sort());
  return ordered.map(id => {
    const items = byDistrict.get(id);
    const tagCounts = new Map();
    for (const m of items) for (const t of (m.tags || [])) {
      if (typeof t === 'string') tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3).map(([t]) => t);
    return { id, memoryCount: items.length, topTags };
  });
}

export function deriveMemories(snapshot, projectId, districtId) {
  return allMemories(snapshot)
    .filter(m => projectOf(m) === projectId && districtOf(m) === districtId)
    .sort((a, b) => new Date(b.created) - new Date(a.created) || a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): snapshot derivation helpers (projects/districts/memories)"
```

---

### Task 2: Helpers module — cylinder math

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append)
- Modify: `test/rolodex-helpers.test.mjs` (append)

**Interfaces:**
- Produces:
  - `anglePerCard(count) -> number` (360/count; 0 when count<=0)
  - `drumRadius(cardWidth, count, minRadius=260) -> number` — px; `minRadius` floor, and always `minRadius` when count<3
  - `normalizeAngle(deg) -> number` in `[0, 360)`
  - `shortestDelta(fromDeg, toDeg) -> number` in `(-180, 180]`
  - `nearestIndex(rotation, count) -> number` — index of the card facing the viewer for drum rotation `rotation`; -1 when count<=0
  - `rotationForIndex(index, count) -> number` — canonical drum rotation that centers card `index` (`-index * anglePerCard`)
  - `snapTarget(rotation, count) -> number` — nearest rotation (continuous, not normalized) that centers a card

- [ ] **Step 1: Write the failing tests**

Append to `test/rolodex-helpers.test.mjs` (add the new names to the existing import):

```js
import {
  anglePerCard, drumRadius, normalizeAngle, shortestDelta,
  nearestIndex, rotationForIndex, snapTarget,
} from '../scripts/nd-mem-rolodex-helpers.mjs';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `anglePerCard` not exported.

- [ ] **Step 3: Write the implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// ---------- cylinder math ----------

export function anglePerCard(count) {
  return count > 0 ? 360 / count : 0;
}

// Radius that keeps adjacent cards from overlapping; floored so 1-2 card
// drums never sit at radius 0 (which would z-fight the camera).
export function drumRadius(cardWidth, count, minRadius = 260) {
  if (count < 3) return minRadius;
  return Math.max(minRadius, Math.round((cardWidth / 2) / Math.tan(Math.PI / count)));
}

export function normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

export function shortestDelta(fromDeg, toDeg) {
  let d = normalizeAngle(toDeg - fromDeg);
  if (d > 180) d -= 360;
  return d;
}

export function nearestIndex(rotation, count) {
  if (count <= 0) return -1;
  const theta = 360 / count;
  return Math.round(normalizeAngle(-rotation) / theta) % count;
}

export function rotationForIndex(index, count) {
  if (count <= 0) return 0;
  return -index * (360 / count);
}

export function snapTarget(rotation, count) {
  if (count <= 0) return rotation;
  const idx = nearestIndex(rotation, count);
  return rotation + shortestDelta(rotation, rotationForIndex(idx, count));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): cylinder math (angles, radius floor, snap)"
```

---

### Task 3: Helpers module — level cycle and history stack

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append)
- Modify: `test/rolodex-helpers.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `LEVELS = ['projects', 'districts', 'memories']`
  - `nextLevel(level) -> string` — cyclic: memories wraps to projects
  - View shape (object literal used everywhere): `{ level, projectId, districtId, centeredId, rotation, itemIds }` — `itemIds` is the drum's item ids at push time (string[]), used later for pop validation.
  - `createHistory() -> array` (plain array used as a stack)
  - `pushView(history, view)` — pushes a shallow copy
  - `popView(history) -> view | null` — null means the wall
  - `atWall(history) -> boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/rolodex-helpers.test.mjs` (extend the import list):

```js
import {
  LEVELS, nextLevel, createHistory, pushView, popView, atWall,
} from '../scripts/nd-mem-rolodex-helpers.mjs';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `LEVELS` not exported.

- [ ] **Step 3: Write the implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// ---------- levels & history ----------
// A "view" is { level, projectId, districtId, centeredId, rotation, itemIds }.
// itemIds records the drum's item ids at push time so a later pop can find a
// nearest neighbor if the centered item has since been deleted.

export const LEVELS = ['projects', 'districts', 'memories'];

export function nextLevel(level) {
  return LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length];
}

export function createHistory() {
  return [];
}

export function pushView(history, view) {
  history.push({ ...view, itemIds: [...(view.itemIds || [])] });
}

export function popView(history) {
  return history.length ? history.pop() : null;
}

export function atWall(history) {
  return history.length === 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): level cycle and history stack with wall detection"
```

---

### Task 4: Helpers module — refresh and pop reconciliation

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append)
- Modify: `test/rolodex-helpers.test.mjs` (append)

**Interfaces:**
- Consumes: `deriveProjects/deriveDistricts/deriveMemories` (Task 1), view shape (Task 3).
- Produces:
  - `itemIdsForView(snapshot, view) -> string[]` — drum item ids for the view's level+context
  - `reconcileView(view, prevIds, snapshot) -> { status: 'kept'|'neighbor'|'invalid', view: view|null, ids: string[] }` — spec rules 1–3: kept if centeredId survives; nearest surviving neighbor by prior ordering otherwise; invalid when the context has no items
  - `reconcilePop(history, snapshot) -> view | null` — pops until a valid view (applying reconcileView with the view's stored itemIds); null when the stack exhausts (caller shows the Projects root, no bounce)

- [ ] **Step 1: Write the failing tests**

Append to `test/rolodex-helpers.test.mjs` (extend the import list):

```js
import {
  itemIdsForView, reconcileView, reconcilePop,
} from '../scripts/nd-mem-rolodex-helpers.mjs';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `itemIdsForView` not exported.

- [ ] **Step 3: Write the implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// ---------- refresh & pop reconciliation (spec rules 1-4) ----------

export function itemIdsForView(snapshot, view) {
  if (view.level === 'projects') return deriveProjects(snapshot).map(p => p.id);
  if (view.level === 'districts') return deriveDistricts(snapshot, view.projectId).map(d => d.id);
  return deriveMemories(snapshot, view.projectId, view.districtId).map(m => m.id);
}

export function reconcileView(view, prevIds, snapshot) {
  const ids = itemIdsForView(snapshot, view);
  if (!ids.length) return { status: 'invalid', view: null, ids };
  if (view.centeredId != null && ids.includes(view.centeredId)) {
    return { status: 'kept', view: { ...view, itemIds: ids }, ids };
  }
  let neighbor = null;
  const prevIndex = (prevIds || []).indexOf(view.centeredId);
  if (prevIndex !== -1) {
    for (let offset = 1; offset < prevIds.length && neighbor === null; offset++) {
      for (const cand of [prevIds[prevIndex - offset], prevIds[prevIndex + offset]]) {
        if (cand != null && ids.includes(cand)) { neighbor = cand; break; }
      }
    }
  }
  return { status: 'neighbor', view: { ...view, centeredId: neighbor ?? ids[0], itemIds: ids }, ids };
}

export function reconcilePop(history, snapshot) {
  while (history.length) {
    const candidate = history.pop();
    const result = reconcileView(candidate, candidate.itemIds || [], snapshot);
    if (result.status !== 'invalid') return result.view;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): refresh and pop reconciliation rules"
```

---

### Task 5: Helpers module — gesture routing

**Files:**
- Modify: `scripts/nd-mem-rolodex-helpers.mjs` (append)
- Modify: `test/rolodex-helpers.test.mjs` (append)

**Interfaces:**
- Produces:
  - `routeGesture(kind, ctx) -> action`
  - `kind`: `'wheel' | 'ctrlWheelUp' | 'ctrlWheelDown' | 'pinchSpread' | 'pinchTogether' | 'clickCentered' | 'clickOther' | 'hdrag' | 'vswipe' | 'rightClick' | 'esc' | 'back' | 'arrowLeft' | 'arrowRight' | 'enter'`
  - `ctx`: `{ level: string, insideReader: boolean }` — `insideReader` is only ever true for the front card's scroll area at the memories level
  - action: `'spin' | 'scrollContent' | 'dive' | 'zoomOut' | 'centerOnly' | 'centerThenDive' | 'stepPrev' | 'stepNext' | 'none'`

- [ ] **Step 1: Write the failing tests**

Append to `test/rolodex-helpers.test.mjs` (extend the import list with `routeGesture`):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: FAIL — `routeGesture` not exported.

- [ ] **Step 3: Write the implementation**

Append to `scripts/nd-mem-rolodex-helpers.mjs`:

```js
// ---------- gesture routing (spec input map) ----------
// insideReader is only true when the pointer is inside the front card's
// scrollable reader area, which only exists at the memories level.

export function routeGesture(kind, ctx) {
  const { level, insideReader } = ctx;
  switch (kind) {
    case 'wheel': return insideReader ? 'scrollContent' : 'spin';
    case 'vswipe': return insideReader ? 'scrollContent' : 'spin';
    case 'hdrag': return 'spin';
    case 'ctrlWheelUp': case 'pinchSpread': case 'enter': return 'dive';
    case 'ctrlWheelDown': case 'pinchTogether': case 'rightClick': case 'esc': case 'back': return 'zoomOut';
    case 'clickCentered': return level === 'memories' ? 'none' : 'dive';
    case 'clickOther': return level === 'memories' ? 'centerOnly' : 'centerThenDive';
    case 'arrowLeft': return 'stepPrev';
    case 'arrowRight': return 'stepNext';
    default: return 'none';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rolodex-helpers.test.mjs`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex-helpers.mjs test/rolodex-helpers.test.mjs
git commit -m "feat(rolodex): gesture routing table"
```

---

### Task 6: Bridge — consolidated static routes + rolodex endpoints (with page stub)

**Files:**
- Modify: `scripts/nd-mem-bridge-server.mjs` (replace the two existing static handlers, add two routes)
- Create: `scripts/nd-mem-rolodex.html` (minimal stub; Task 7 replaces it)
- Create: `test/bridge-rolodex-routes.test.mjs`

**Interfaces:**
- Consumes: existing bridge structure — `SCRIPT_DIR`, `app`, the `HTML_PATH`/`HELPERS_PATH` handlers being replaced.
- Produces: `GET /rolodex` (text/html), `GET /nd-mem-rolodex-helpers.mjs` (text/javascript); `GET /` and `GET /nd-mem-app-helpers.mjs` keep exact behavior.

- [ ] **Step 1: Create the page stub**

Create `scripts/nd-mem-rolodex.html`:

```html
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <title>ND-Mem Rolodex</title>
</head>
<body>
  <p>ND-Mem Rolodex — under construction. <a href="/">Classic view</a></p>
</body>
</html>
```

- [ ] **Step 2: Write the failing test**

Create `test/bridge-rolodex-routes.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

test('bridge serves the rolodex page, its helpers, and still serves the classic app', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndm-rolodex-routes-'));
  const bridgePort = await getFreePort();
  const daemonPort = await getFreePort();
  const bridge = spawn(process.execPath, ['scripts/nd-mem-bridge-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ND_MEM_BRIDGE_PORT: String(bridgePort),
      ND_MEM_FILE: path.join(tempDir, 'memories.json'),
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitFor(`http://127.0.0.1:${bridgePort}/health`);

    const page = await fetch(`http://127.0.0.1:${bridgePort}/rolodex`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /rolodex/i);

    const mod = await fetch(`http://127.0.0.1:${bridgePort}/nd-mem-rolodex-helpers.mjs`);
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get('content-type'), /javascript/);
    assert.match(await mod.text(), /export function/);

    const classic = await fetch(`http://127.0.0.1:${bridgePort}/`);
    assert.equal(classic.status, 200);
    assert.match(await classic.text(), /ND-Mem MCP App/);

    const classicHelpers = await fetch(`http://127.0.0.1:${bridgePort}/nd-mem-app-helpers.mjs`);
    assert.equal(classicHelpers.status, 200);
  } finally {
    bridge.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/bridge-rolodex-routes.test.mjs`
Expected: FAIL — `/rolodex` returns 404.

- [ ] **Step 4: Consolidate static serving in the bridge**

In `scripts/nd-mem-bridge-server.mjs`, replace the two blocks — the `HTML_PATH` block (`const HTML_PATH = ...` through the end of its `app.get('/', ...)` handler) and the `HELPERS_PATH` block (`const HELPERS_PATH = ...` through the end of its handler) — with:

```js
// One handler shape for every sibling file the bridge serves. Paths resolve
// off SCRIPT_DIR so launching the bridge from any cwd works.
function serveSibling(route, filename, contentType) {
  const filePath = path.join(SCRIPT_DIR, filename);
  app.get(route, (_req, res) => {
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(fs.readFileSync(filePath, 'utf-8'));
    } else {
      res.status(404).send(`${filename} not found. Ensure scripts/${filename} exists.`);
    }
  });
}
const HTML_PATH = path.join(SCRIPT_DIR, 'nd-mem-mcp-app-bridge.html'); // openBridgeUI checks this
serveSibling('/', 'nd-mem-mcp-app-bridge.html', 'text/html');
serveSibling('/nd-mem-app-helpers.mjs', 'nd-mem-app-helpers.mjs', 'text/javascript');
serveSibling('/rolodex', 'nd-mem-rolodex.html', 'text/html');
serveSibling('/nd-mem-rolodex-helpers.mjs', 'nd-mem-rolodex-helpers.mjs', 'text/javascript');
```

Keep the `HTML_PATH` constant — `maybeOpenBridgeUI()` at the bottom of the file references it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/bridge-rolodex-routes.test.mjs test/bridge-daemon.test.mjs test/bridge-project-reassign.test.mjs`
Expected: PASS — new route test plus the two pre-existing bridge suites (proves consolidation broke nothing). These spawn the daemon; `build/` must exist (`npm run build` if needed).

- [ ] **Step 6: Commit**

```bash
git add scripts/nd-mem-bridge-server.mjs scripts/nd-mem-rolodex.html test/bridge-rolodex-routes.test.mjs
git commit -m "feat(rolodex): bridge serves /rolodex and its helpers via consolidated static routes"
```

---

### Task 7: Page — skeleton, data load, drum render, spin

**Files:**
- Modify: `scripts/nd-mem-rolodex.html` (replace the stub with the full skeleton)

**Interfaces:**
- Consumes: helpers module (Tasks 1–5) via `import`; bridge `GET /health`, `GET /memories`.
- Produces (page-internal, later tasks build on these exact names): `state`, `els`, `H` (helpers namespace), `esc()`, `showToast()`, `currentViewSnapshot()`, `buildDrum()`, `applyDrumTransform()`, `updateFrontCard()`, `centeredItem()`, `stepBy(n)`, `dive()`, `zoomOut()` (stubs in this task), `REDUCED` (prefers-reduced-motion boolean).

- [ ] **Step 1: Replace the stub with the full skeleton**

Replace the entire content of `scripts/nd-mem-rolodex.html` with:

```html
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ND-Mem Rolodex</title>
  <link rel="preconnect" href="https://api.fontshare.com">
  <link href="https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,700,900&f[]=clash-display@400,500,600,700&display=swap" rel="stylesheet">
  <style>
    :root,[data-theme="light"]{--bg:#f7f6f2;--border:#d4d1ca;--text:#28251d;--muted:#7a7974;--faint:#bab9b4;--primary:#01696f;--cardW:340px;--cardH:230px;--font-display:'Clash Display','Inter',sans-serif;--font-body:'Satoshi','Inter',sans-serif}
    [data-theme="dark"]{--bg:#111318;--border:#37404b;--text:#edf2f4;--muted:#a3b0b8;--faint:#6e7a84;--primary:#60d7d2}
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%;overflow:hidden;overscroll-behavior:none}
    body{font-family:var(--font-body);color:var(--text);background:radial-gradient(circle at top left,rgba(96,215,210,.1),transparent 24%),linear-gradient(180deg,var(--bg),#0d0f13);user-select:none}
    button{font:inherit;color:inherit;cursor:pointer}
    #chrome{position:fixed;inset:0 0 auto 0;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;pointer-events:none}
    #chrome .cluster{display:flex;gap:10px;align-items:center;pointer-events:auto}
    .pill{padding:9px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(16,20,24,.72);backdrop-filter:blur(10px);font-size:.82rem;color:var(--muted)}
    .pill strong{color:var(--text);font-weight:500}
    a.pill{text-decoration:none}
    #backBtn{font-size:1rem;line-height:1}
    #levelName{font-family:var(--font-display);text-transform:uppercase;letter-spacing:.14em;font-size:.74rem}
    #stage{position:fixed;inset:0;perspective:1400px;overflow:hidden;touch-action:none}
    #stage.bounce::after{content:'';position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 120px rgba(96,215,210,.35);animation:edgeflash .45s ease}
    @keyframes edgeflash{from{opacity:1}to{opacity:0}}
    #scene{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform-style:preserve-3d;transition:transform .7s cubic-bezier(.4,0,.2,1),opacity .55s ease}
    #scene.zoom-in{transform:translateZ(900px);opacity:0}
    #scene.zoom-out{transform:translateZ(-700px) scale(.6);opacity:0}
    #scene.bouncing{animation:wallbounce .45s ease}
    @keyframes wallbounce{0%{transform:translateZ(0)}35%{transform:translateZ(-90px)}100%{transform:translateZ(0)}}
    #drum{position:relative;width:var(--cardW);height:var(--cardH);transform-style:preserve-3d}
    #stage[data-level="memories"]{--cardH:460px}
    .card3d{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:24px;border:1px solid rgba(255,255,255,.09);background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.03)),radial-gradient(circle at top right,rgba(96,215,210,.16),transparent 38%),rgba(20,25,31,.92);box-shadow:0 18px 40px rgba(0,0,0,.35);backface-visibility:hidden;transition:opacity .3s,box-shadow .3s,border-color .3s;opacity:.55}
    .card3d.front{opacity:1;border-color:rgba(96,215,210,.4);box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 30px rgba(96,215,210,.12)}
    .card3d .kicker{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--faint)}
    .card3d h2{font-family:var(--font-display);font-size:1.15rem;line-height:1.2}
    .card3d p{color:var(--muted);line-height:1.5;font-size:.9rem;overflow:hidden}
    .chips{display:flex;gap:8px;flex-wrap:wrap}
    .chip{padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);font-size:.74rem;color:var(--muted)}
    #hud{position:fixed;inset:auto 0 0 0;z-index:10;display:flex;justify-content:center;padding:16px;pointer-events:none}
    #overlay{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:rgba(7,10,12,.7)}
    #overlay.open{display:flex}
    #overlay .box{max-width:420px;text-align:center;padding:28px;border-radius:24px;background:rgba(20,24,29,.96);border:1px solid rgba(255,255,255,.1)}
    #overlay h2{font-family:var(--font-display);margin-bottom:10px}
    #overlay p{color:var(--muted);margin-bottom:16px;line-height:1.55}
    .btn{padding:11px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05)}
    .btn.primary{background:linear-gradient(180deg,rgba(96,215,210,.24),rgba(96,215,210,.12));border-color:rgba(96,215,210,.3)}
    #toast{position:fixed;right:16px;bottom:16px;z-index:30;display:none;max-width:360px;padding:13px 16px;border-radius:16px;background:rgba(16,20,24,.94);border:1px solid rgba(96,215,210,.26)}
    #toast.show{display:block}
    @media (prefers-reduced-motion: reduce){#scene{transition:none}#scene.bouncing,#stage.bounce::after{animation:none}.card3d{transition:none}}
  </style>
</head>
<body>
  <div id="chrome">
    <div class="cluster">
      <button class="pill" id="backBtn" title="Zoom out (Esc / right-click)">⤺</button>
      <span class="pill" id="crumb"><strong>All projects</strong></span>
      <span class="pill" id="levelName">Projects</span>
    </div>
    <div class="cluster">
      <span class="pill" id="position">—</span>
      <span class="pill" id="connState">Connecting…</span>
      <button class="pill" id="themeBtn" title="Toggle theme">◐</button>
      <a class="pill" href="/">Classic view</a>
    </div>
  </div>
  <div id="stage" data-level="projects"><div id="scene"><div id="drum"></div></div></div>
  <div id="hud"><span class="pill">Scroll to spin · click to dive · right-click / Esc to zoom out · Ctrl+scroll zooms</span></div>
  <div id="overlay"><div class="box"><h2>Bridge offline</h2><p id="overlayMsg">Could not reach the bridge. Start it with <code>node scripts/nd-mem-bridge-server.mjs</code> and retry.</p><button class="btn primary" id="retryBtn">Retry</button></div></div>
  <div id="toast"></div>

  <script type="module">
    const BRIDGE = location.protocol.startsWith('http') ? location.origin : 'http://localhost:3737';
    const H = await import(BRIDGE + '/nd-mem-rolodex-helpers.mjs');
    const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CARD_W = 340;

    const $ = s => document.querySelector(s);
    const els = { stage: $('#stage'), scene: $('#scene'), drum: $('#drum'), crumb: $('#crumb'), levelName: $('#levelName'), position: $('#position'), connState: $('#connState'), backBtn: $('#backBtn'), overlay: $('#overlay'), overlayMsg: $('#overlayMsg'), retryBtn: $('#retryBtn'), toast: $('#toast') };

    const state = {
      snapshot: { memories: {} },
      view: { level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] },
      history: H.createHistory(),
      items: [],           // [{id, kind, data}] for the current drum
      rotation: 0,         // live continuous rotation (deg)
      velocity: 0,
      radius: 260,
      dragging: false,
      transitioning: false,
      frontIndex: -1,
      lastBounceAt: 0,
    };

    function esc(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function showToast(msg){ els.toast.textContent = msg; els.toast.classList.add('show'); clearTimeout(showToast.t); showToast.t = setTimeout(() => els.toast.classList.remove('show'), 3200); }
    function fmt(v){ try { return new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return '—'; } }

    function itemsForView(view){
      if (view.level === 'projects') return H.deriveProjects(state.snapshot).map(p => ({ id: p.id, kind: 'project', data: p }));
      if (view.level === 'districts') return H.deriveDistricts(state.snapshot, view.projectId).map(d => ({ id: d.id, kind: 'district', data: d }));
      return H.deriveMemories(state.snapshot, view.projectId, view.districtId).map(m => ({ id: m.id, kind: 'memory', data: m }));
    }

    function currentViewSnapshot(){
      return { ...state.view, centeredId: centeredItem()?.id ?? null, rotation: state.rotation, itemIds: state.items.map(i => i.id) };
    }
    function centeredItem(){ return state.frontIndex >= 0 ? state.items[state.frontIndex] : null; }

    function cardFace(item){
      const d = item.data;
      if (item.kind === 'project') return `<span class="kicker">Project</span><h2>${esc(d.id)}</h2><div class="chips"><span class="chip">${d.memoryCount} memories</span><span class="chip">${d.districtCount} district${d.districtCount === 1 ? '' : 's'}</span></div>`;
      if (item.kind === 'district') return `<span class="kicker">District</span><h2>${esc(d.id)}</h2><div class="chips"><span class="chip">${d.memoryCount} memories</span>${d.topTags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>`;
      return `<span class="kicker">${esc(d.id)}</span><h2>${esc(d.name || '(untitled)')}</h2><p>${esc(d.content)}</p><div class="chips">${(d.tags || []).slice(0, 3).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>`;
    }

    function buildDrum(){
      state.items = itemsForView(state.view);
      const n = state.items.length;
      state.radius = H.drumRadius(CARD_W, n);
      els.stage.dataset.level = state.view.level;
      const theta = H.anglePerCard(n);
      if (!n) {
        els.drum.innerHTML = `<div class="card3d front placeholder"><span class="kicker">Empty</span><h2>${state.view.level === 'projects' ? 'No memories yet' : 'Nothing here'}</h2><p>Store a memory through MCP or the classic app and it will appear.</p></div>`;
        state.rotation = 0; state.velocity = 0; state.frontIndex = -1;
        applyDrumTransform(); updateChrome(); return;
      }
      els.drum.innerHTML = state.items.map((item, i) =>
        `<div class="card3d" data-idx="${i}" style="transform:rotateY(${i * theta}deg) translateZ(${state.radius}px)">${cardFace(item)}</div>`).join('');
      const idx = Math.max(0, state.items.findIndex(i => i.id === state.view.centeredId));
      state.rotation = H.rotationForIndex(idx, n);
      state.velocity = 0;
      applyDrumTransform();
      updateFrontCard(true);
    }

    function applyDrumTransform(){
      els.drum.style.transform = `translateZ(${-state.radius}px) rotateY(${state.rotation}deg)`;
    }

    function updateFrontCard(force = false){
      const n = state.items.length;
      const idx = H.nearestIndex(state.rotation, n);
      if (!force && idx === state.frontIndex) return;
      state.frontIndex = idx;
      els.drum.querySelectorAll('.card3d').forEach((el, i) => el.classList.toggle('front', i === idx));
      state.view.centeredId = centeredItem()?.id ?? null;
      updateChrome();
    }

    function updateChrome(){
      const { level, projectId, districtId } = state.view;
      els.levelName.textContent = level[0].toUpperCase() + level.slice(1);
      els.crumb.innerHTML = level === 'projects' ? '<strong>All projects</strong>'
        : level === 'districts' ? `<strong>${esc(projectId)}</strong>`
        : `<strong>${esc(projectId)}</strong> ▸ ${esc(districtId)}`;
      els.position.textContent = state.items.length ? `card ${state.frontIndex + 1} / ${state.items.length}` : '—';
    }

    function stepBy(n){
      const count = state.items.length;
      if (!count || state.transitioning) return;
      const target = H.rotationForIndex(((state.frontIndex + n) % count + count) % count, count);
      state.rotation += H.shortestDelta(state.rotation, target);
      if (REDUCED) applyDrumTransform();
      state.velocity = 0;
    }

    // Stubs — Task 8 implements these.
    function dive(){ }
    function zoomOut(){ }

    // ---------- animation loop ----------
    function tick(){
      if (!state.transitioning && !state.dragging && state.items.length) {
        if (Math.abs(state.velocity) > 0.02) {
          state.rotation += state.velocity;
          state.velocity *= 0.93;
        } else {
          state.velocity = 0;
          const target = H.snapTarget(state.rotation, state.items.length);
          const d = target - state.rotation;
          if (Math.abs(d) > 0.05) state.rotation += REDUCED ? d : d * 0.14;
          else state.rotation = target;
        }
        applyDrumTransform();
        updateFrontCard();
      }
      requestAnimationFrame(tick);
    }

    // ---------- input: wheel ----------
    function insideReader(target){
      return state.view.level === 'memories' && !!(target instanceof Element && target.closest('.reader-scroll'));
    }
    els.stage.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        (H.routeGesture(e.deltaY < 0 ? 'ctrlWheelUp' : 'ctrlWheelDown', ctx(e)) === 'dive' ? dive : zoomOut)();
        return;
      }
      const action = H.routeGesture('wheel', ctx(e));
      if (action === 'scrollContent') return; // native scroll of the reader div
      e.preventDefault();
      state.velocity += e.deltaY * 0.02;
    }, { passive: false });
    function ctx(e){ return { level: state.view.level, insideReader: insideReader(e.target) }; }

    // ---------- input: pointer (drag spin, pinch, long-press) ----------
    const pointers = new Map();
    let pinchStart = 0, dragMoved = 0;
    els.stage.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      } else if (pointers.size === 1) {
        dragMoved = 0;
        if (!insideReader(e.target)) { state.dragging = true; state.velocity = 0; }
      }
    });
    els.stage.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchStart > 0) {
        const [a, b] = [...pointers.values()];
        const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinchStart;
        if (ratio > 1.25) { pinchStart = 0; dive(); }
        else if (ratio < 0.8) { pinchStart = 0; zoomOut(); }
        return;
      }
      if (state.dragging) {
        dragMoved += Math.abs(dx) + Math.abs(dy);
        state.rotation += dx * 0.22;
        state.velocity = dx * 0.22;
        applyDrumTransform();
        updateFrontCard();
      }
    });
    function releasePointer(e){
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = 0;
      if (!pointers.size) state.dragging = false;
    }
    els.stage.addEventListener('pointerup', releasePointer);
    els.stage.addEventListener('pointercancel', releasePointer);

    // ---------- input: click, context menu, keys ----------
    els.stage.addEventListener('click', (e) => {
      if (dragMoved > 8 || state.transitioning) return; // a drag, not a click
      const card = e.target instanceof Element ? e.target.closest('.card3d[data-idx]') : null;
      if (!card || e.target.closest('button, a, .reader-scroll')) return;
      const idx = Number(card.dataset.idx);
      const kind = idx === state.frontIndex ? 'clickCentered' : 'clickOther';
      const action = H.routeGesture(kind, { level: state.view.level, insideReader: false });
      if (action === 'none') return;
      if (idx !== state.frontIndex) {
        const target = H.rotationForIndex(idx, state.items.length);
        state.rotation += H.shortestDelta(state.rotation, target);
        state.velocity = 0;
        applyDrumTransform(); updateFrontCard();
      }
      if (action === 'dive' || action === 'centerThenDive') dive();
    });
    window.addEventListener('contextmenu', (e) => {
      if (document.querySelector('.modalbg.open')) return; // modal text fields keep the native menu
      e.preventDefault();
      if (!state.transitioning) zoomOut();
    });
    $('#themeBtn').addEventListener('click', () => document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('.modalbg.open')) return; // modal owns keys (Task 9)
      const map = { Escape: 'esc', Backspace: 'back', ArrowLeft: 'arrowLeft', ArrowRight: 'arrowRight', Enter: 'enter' };
      const kind = map[e.key];
      if (!kind) return;
      e.preventDefault();
      const action = H.routeGesture(kind, { level: state.view.level, insideReader: false });
      if (action === 'zoomOut') zoomOut();
      else if (action === 'dive') dive();
      else if (action === 'stepPrev') stepBy(-1);
      else if (action === 'stepNext') stepBy(1);
    });
    els.backBtn.addEventListener('click', () => zoomOut());

    // ---------- data ----------
    async function loadSnapshot(){
      const res = await fetch(`${BRIDGE}/memories`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.snapshot = await res.json();
    }
    async function init(){
      try {
        const health = await (await fetch(`${BRIDGE}/health`)).json();
        await loadSnapshot();
        els.connState.textContent = `Bridge :${health.port}`;
        els.overlay.classList.remove('open');
        buildDrum();
      } catch {
        els.connState.textContent = 'Offline';
        els.overlay.classList.add('open');
      }
    }
    els.retryBtn.addEventListener('click', init);
    await init();
    tick();
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify the bridge tests still pass**

Run: `node --test test/bridge-rolodex-routes.test.mjs`
Expected: PASS (the page still contains "rolodex" in its title).

- [ ] **Step 3: Manual verification**

1. Start the bridge: `node scripts/nd-mem-bridge-server.mjs --no-open` (real store is fine — this page only reads).
2. Open `http://localhost:3737/rolodex`.
3. Confirm: projects drum renders as a 3D cylinder; wheel spins with inertia and snaps a card to front; the front card is brighter; drag spins; ← / → step one card; position pill shows "card N / M"; breadcrumb shows "All projects"; Ctrl+wheel does NOT browser-zoom; right-click shows no context menu. Dive/zoom-out do nothing yet (stubs).

- [ ] **Step 4: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): page skeleton with 3D drum render and spin input"
```

---

### Task 8: Page — dive, zoom-out, history, wall bounce

**Files:**
- Modify: `scripts/nd-mem-rolodex.html`

**Interfaces:**
- Consumes: `H.pushView/popView/atWall/nextLevel/reconcilePop`, `currentViewSnapshot()`, `buildDrum()`, state fields from Task 7.
- Produces: working `dive()` and `zoomOut()`; `transitionTo(view, dir)` used by Task 10.

- [ ] **Step 1: Replace the stubs**

In `scripts/nd-mem-rolodex.html`, replace:

```js
    // Stubs — Task 8 implements these.
    function dive(){ }
    function zoomOut(){ }
```

with:

```js
    // ---------- dive / zoom out ----------
    const ZOOM_MS = 700;

    function transitionTo(view, dir){ // dir: 'in' pushes camera through the card, 'out' pulls it back
      state.transitioning = true;
      const enterCls = dir === 'in' ? 'zoom-in' : 'zoom-out';
      const exitCls = dir === 'in' ? 'zoom-out' : 'zoom-in';
      els.scene.classList.add(enterCls);
      setTimeout(() => {
        state.view = { ...view };
        buildDrum();
        els.scene.classList.remove(enterCls);
        els.scene.classList.add(exitCls);
        void els.scene.offsetWidth; // reflow so the exit state applies before removal animates it
        els.scene.classList.remove(exitCls);
        setTimeout(() => { state.transitioning = false; }, REDUCED ? 0 : ZOOM_MS);
      }, REDUCED ? 0 : ZOOM_MS);
    }

    function dive(){
      if (state.transitioning || !state.items.length) return;
      const front = centeredItem();
      if (!front) return;
      H.pushView(state.history, currentViewSnapshot());
      const level = H.nextLevel(state.view.level);
      let next;
      if (state.view.level === 'projects') next = { level, projectId: front.id, districtId: null, centeredId: null, rotation: 0, itemIds: [] };
      else if (state.view.level === 'districts') next = { level, projectId: state.view.projectId, districtId: front.id, centeredId: null, rotation: 0, itemIds: [] };
      else next = { level, projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] }; // memories wraps to projects
      transitionTo(next, 'in');
    }

    function bounce(){
      const now = performance.now();
      if (now - state.lastBounceAt < 500) return;
      state.lastBounceAt = now;
      if (REDUCED) { showToast('This is the first view — nothing further back.'); return; }
      els.scene.classList.add('bouncing');
      els.stage.classList.add('bounce');
      setTimeout(() => { els.scene.classList.remove('bouncing'); els.stage.classList.remove('bounce'); }, 460);
    }

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

- [ ] **Step 2: Manual verification**

With the bridge running, on `http://localhost:3737/rolodex`:

1. Click a project card → camera pushes through, districts drum appears; breadcrumb shows the project.
2. Dive a district → memories drum; breadcrumb `project ▸ district`.
3. Ctrl+wheel-up (or Enter) at memories → wraps to Projects.
4. Zoom out once (Esc) → the exact memory you left returns centered.
5. Keep zooming out (right-click, ⤺, Backspace) → district view, project view, then at the root: the bounce animation + edge flash, and nothing else.
6. Arrow keys and click-to-center still work at every level; clicking a memory card does NOT dive.

- [ ] **Step 3: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): dive/zoom-out with history stack and wall bounce"
```

---

### Task 9: Page — front-card reader and edit modal

**Files:**
- Modify: `scripts/nd-mem-rolodex.html`

**Interfaces:**
- Consumes: `cardFace()`, `updateFrontCard()`, bridge `POST /update` (same body contract as the classic app: `{memoryId, content, district, visibility, intensity, projectId, tags, epistemicStatus?}`).
- Produces: `.reader-scroll` element on the front memory card (the `insideReader()` target that already routes wheel/touch), `openEditModal(memory)`, `submitEdit()`.

- [ ] **Step 1: Add reader + modal CSS**

In the `<style>` block, add after the `.chip{...}` rule:

```css
    .card3d .reader-scroll{display:none;flex:1;min-height:0;overflow:auto;padding-right:6px;line-height:1.6;color:var(--text);font-size:.92rem;white-space:pre-wrap;user-select:text;touch-action:pan-y;overscroll-behavior:contain}
    .card3d.front .reader-scroll{display:block}
    .card3d.front .preview{display:none}
    .card3d .meta{display:none;grid-template-columns:repeat(2,1fr);gap:8px}
    .card3d.front .meta{display:grid}
    .mini{padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)}
    .mini label{display:block;font-size:.66rem;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}
    .mini span{font-size:.8rem}
    .card3d .actions{display:none;justify-content:flex-end}
    .card3d.front .actions{display:flex}
    .modalbg{position:fixed;inset:0;z-index:40;background:rgba(7,10,12,.66);backdrop-filter:blur(10px);display:none;align-items:center;justify-content:center;padding:16px}
    .modalbg.open{display:flex}
    .modal{width:min(680px,100%);max-height:88vh;overflow:auto;border-radius:26px;background:linear-gradient(180deg,rgba(27,30,35,.98),rgba(17,19,22,.98));border:1px solid rgba(255,255,255,.09);padding:22px;user-select:text}
    .modal h2{font-family:var(--font-display);margin-bottom:12px}
    .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
    .field label{display:block;margin-bottom:6px;font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
    .field input,.field select,.field textarea{width:100%;padding:11px 13px;border-radius:13px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);font:inherit;color:inherit}
    .field textarea{min-height:140px}
    .span2{grid-column:span 2}
    .foot{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
```

- [ ] **Step 2: Add the modal markup**

Before `<div id="toast"></div>`, add:

```html
  <div class="modalbg" id="editModalBg">
    <div class="modal">
      <h2>Edit memory</h2>
      <div class="grid">
        <div class="field span2"><label>Content</label><textarea id="editContent"></textarea></div>
        <div class="field"><label>District</label><select id="editDistrict"></select></div>
        <div class="field"><label>Project (blank clears)</label><input id="editProject" /></div>
        <div class="field"><label>Visibility</label><select id="editVisibility"><option>private</option><option>shared</option><option>global</option></select></div>
        <div class="field"><label>Intensity (0–1)</label><input id="editIntensity" type="number" min="0" max="1" step="0.1" /></div>
        <div class="field"><label>Epistemic status</label><select id="editEpistemic"><option value="">(leave unchanged)</option><option value="draft">draft</option><option value="validated">validated</option><option value="outdated">outdated</option></select></div>
        <div class="field"><label>Tags (comma separated)</label><input id="editTags" /></div>
      </div>
      <div class="foot"><button class="btn" id="editCancelBtn">Cancel</button><button class="btn primary" id="editSaveBtn">Save changes</button></div>
    </div>
  </div>
```

- [ ] **Step 3: Upgrade the memory card face and wire the modal**

In the page script, replace the memory branch of `cardFace` (the final `return` statement) with:

```js
      const metaRow = (label, value) => `<div class="mini"><label>${label}</label><span>${esc(value)}</span></div>`;
      return `<span class="kicker">${esc(d.id)} · ${esc(d.district || 'uncategorized')}</span>`
        + `<h2>${esc(d.name || '(untitled)')}</h2>`
        + `<p class="preview">${esc(d.content)}</p>`
        + `<div class="reader-scroll">${esc(d.content)}</div>`
        + `<div class="meta">${metaRow('Intensity', d.intensity ?? '—')}${metaRow('Visibility', d.visibility || 'private')}${metaRow('Created', fmt(d.created))}${metaRow('Tags', (d.tags || []).length)}</div>`
        + `<div class="chips">${(d.tags || []).slice(0, 4).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>`
        + `<div class="actions"><button class="btn" data-edit="${esc(d.id)}">Edit</button></div>`;
```

Then add after the `els.backBtn.addEventListener(...)` line:

```js
    // ---------- edit modal ----------
    const CANONICAL = H.CANONICAL_DISTRICTS;
    function openEditModal(m){
      state.editingId = m.id;
      const districts = CANONICAL.includes(m.district) || !m.district ? CANONICAL : [m.district, ...CANONICAL];
      $('#editDistrict').innerHTML = districts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      $('#editContent').value = m.content || '';
      $('#editDistrict').value = m.district || 'practical_execution';
      $('#editProject').value = m.project_id ?? '';
      $('#editVisibility').value = m.visibility || 'private';
      $('#editIntensity').value = m.intensity ?? 0.5;
      $('#editEpistemic').value = ['draft', 'validated', 'outdated'].includes(m.epistemic_status) ? m.epistemic_status : '';
      $('#editTags').value = (m.tags || []).join(', ');
      $('#editModalBg').classList.add('open');
    }
    async function submitEdit(){
      const content = $('#editContent').value.trim();
      if (!content) { showToast('Content cannot be empty.'); return; }
      const project = $('#editProject').value.trim();
      const body = {
        memoryId: state.editingId,
        content,
        district: $('#editDistrict').value,
        visibility: $('#editVisibility').value,
        intensity: Number($('#editIntensity').value),
        projectId: project === '' ? null : project,
        tags: $('#editTags').value.split(',').map(s => s.trim()).filter(Boolean),
      };
      const epistemic = $('#editEpistemic').value;
      if (epistemic) body.epistemicStatus = epistemic;
      try {
        const res = await fetch(`${BRIDGE}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error('update failed');
        $('#editModalBg').classList.remove('open');
        showToast('Update routed through the bridge.');
      } catch {
        showToast('Update failed — the modal is untouched, fix and retry.');
      }
    }
    els.stage.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-edit]') : null;
      if (!btn) return;
      const m = H.deriveMemories(state.snapshot, state.view.projectId, state.view.districtId).find(x => x.id === btn.dataset.edit);
      if (m) openEditModal(m);
    });
    $('#editCancelBtn').addEventListener('click', () => $('#editModalBg').classList.remove('open'));
    $('#editSaveBtn').addEventListener('click', submitEdit);
    $('#editModalBg').addEventListener('click', (e) => { if (e.target.id === 'editModalBg') $('#editModalBg').classList.remove('open'); });
```

Finally, extend the keydown guard so Esc closes the modal instead of zooming out — replace the line `if (document.querySelector('.modalbg.open')) return; // modal owns keys (Task 9)` with:

```js
      const openModal = document.querySelector('.modalbg.open');
      if (openModal) { if (e.key === 'Escape') openModal.classList.remove('open'); return; }
```

Add `editingId: null,` to the `state` object literal (after `lastBounceAt: 0,`).

- [ ] **Step 4: Manual verification**

1. Navigate to a memories drum. The front card shows full scrollable content; wheel **inside** the text scrolls it, wheel outside spins the drum; text is selectable; clicking the card body does not dive.
2. Click **Edit** on the front card → modal opens pre-filled. Esc closes the modal (and does not zoom out). Reopen, change content, Save → toast confirms; the change lands in `memories.json` (verify in the classic view or the file).
3. Kill the bridge, try Save → failure toast, modal stays open with your text.

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): front-card reader and edit modal"
```

---

### Task 10: Page — SSE live refresh with reconciliation

**Files:**
- Modify: `scripts/nd-mem-rolodex.html`

**Interfaces:**
- Consumes: `H.reconcileView`, `H.reconcilePop`, `currentViewSnapshot()`, `buildDrum()`, bridge `GET /events` (SSE: `hello`, `memory-change`).
- Produces: live-updating page that preserves navigation state across external writes.

- [ ] **Step 1: Add SSE wiring**

In the page script, add before `els.retryBtn.addEventListener('click', init);`:

```js
    // ---------- live refresh (spec: preserve level, rotation, history, centered-by-id) ----------
    function connectEvents(){
      const es = new EventSource(`${BRIDGE}/events`);
      es.addEventListener('memory-change', async () => {
        try { await loadSnapshot(); } catch { return; }
        if (state.transitioning) { buildDrum(); return; }
        const prevIds = state.items.map(i => i.id);
        const result = H.reconcileView(currentViewSnapshot(), prevIds, state.snapshot);
        if (result.status === 'invalid') {
          const restored = H.reconcilePop(state.history, state.snapshot);
          state.view = restored ?? { level: 'projects', projectId: null, districtId: null, centeredId: null, rotation: 0, itemIds: [] };
          showToast(restored ? 'This view emptied — zoomed out to the last valid one.' : 'This view emptied — back to all projects.');
        } else {
          state.view = result.view;
          if (result.status === 'neighbor') showToast('The centered card was removed — showing its neighbor.');
        }
        buildDrum();
      });
      es.onerror = () => { els.connState.textContent = 'Stream lost — retrying…'; };
      es.addEventListener('hello', () => { els.connState.textContent = 'Live'; });
    }
    connectEvents();
```

- [ ] **Step 2: Manual verification**

1. Open `/rolodex` on a memories drum; in another tab open the classic app (`/`).
2. Edit the centered memory's content in the classic app → the rolodex card updates in place, still centered (rule 1), toast appears.
3. Move the centered memory to another project in the classic app → the drum re-renders on a neighbor (rule 2).
4. Move ALL memories out of the current district → auto-zoom-out with toast (rule 3).
5. Confirm history zoom-out still restores sensible views afterward (rule 4).

- [ ] **Step 3: Commit**

```bash
git add scripts/nd-mem-rolodex.html
git commit -m "feat(rolodex): SSE live refresh preserving navigation state"
```

---

### Task 11: Cross-links, docs, full suite

**Files:**
- Modify: `scripts/nd-mem-mcp-app-bridge.html` (one button)
- Modify: `README.md` (Web App section)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)

**Interfaces:** none new.

- [ ] **Step 1: Add the classic → rolodex link**

In `scripts/nd-mem-mcp-app-bridge.html`, in the header button row, change:

```html
<button class="btn" id="refreshBtn">Reload snapshot</button>
```

to:

```html
<a class="btn" href="/rolodex" style="text-decoration:none">Rolodex view</a>
          <button class="btn" id="refreshBtn">Reload snapshot</button>
```

(The rolodex → classic link already exists in the chrome from Task 7.)

- [ ] **Step 2: README**

In `README.md`'s "Web App (Bridge UI)" section, after the paragraph that ends with the env-var sentence about `ND_MEM_BRIDGE_OPEN`, add:

```markdown
### Rolodex view

`http://localhost:3737/rolodex` is an alternative, navigation-first UI: 3D
rolodex carousels nested three deep. Spin through projects, dive into one to
spin its districts, dive again to read memories card by card — the front card
is the reader (scroll inside it to read, outside it to spin). Diving past the
memories level wraps back to project selection; zooming out (right-click,
Esc/Backspace, the ⤺ button, Ctrl+scroll-down, or pinch) walks back through
the exact views you came from, and bounces off the wall when you reach the
first view of the session. Editing the front card routes through the same
bridge `/update` endpoint as the classic app; creating memories and project
rename/merge stay in the classic view.
```

- [ ] **Step 3: CHANGELOG**

In `CHANGELOG.md` under `[Unreleased]` → `### Added`, append:

```markdown
- **Rolodex view.** `GET /rolodex` on the web-app bridge serves a second,
  navigation-first UI: nested 3D rolodex carousels (projects → districts →
  memories) with cyclic dive, history-stack zoom-out that restores the exact
  prior view, a wall-bounce at the first view, a front-card reader with
  pointer-aware scroll routing, and edit routed through `/update`. Pure
  CSS 3D + vanilla JS (`scripts/nd-mem-rolodex.html`), logic unit-tested in
  `scripts/nd-mem-rolodex-helpers.mjs`. The bridge's static file handlers are
  consolidated into one helper.
```

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: full suite passes (build + all node:test files, including the 17 helper tests and the new bridge route test).

Run: `npm run lint:md`
Expected: clean.

Then walk the spec's 10-item manual smoke checklist end to end (spec § Testing) with `node scripts/nd-mem-bridge-server.mjs --open`, navigating to `/rolodex`. Use browser DevTools device emulation for the touch items (swipe, pinch, long-press).

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-mcp-app-bridge.html README.md CHANGELOG.md
git commit -m "docs(rolodex): cross-link from classic app, README and CHANGELOG entries"
```
