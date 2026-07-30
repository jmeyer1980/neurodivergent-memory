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

// A 1-4 card cylinder is degenerate: two cards face away from each other, four
// make a cube showing one face. Small drums instead fan forward so every card
// is visible at once, which is how you see at a glance that a project has
// exactly three districts. Fan mode trades wrap-around for end clamping.
//
// WHY THIS SECTION CHANGED — the fan's radius was derived from card width alone
// and capped by a constant, so it never knew how wide the screen was. A 3-card
// district fan projects ~887px wide; on an iPad in portrait (820px) the end
// cards hang 58px off each edge, and on a phone 273px. Since a fan never
// rotates, there was also no mechanism that could ever bring an off-screen card
// back. Three things fix it, in this order of preference:
//
//   1. Shrink the arc to fit the viewport, spending overlap to do it.
//   2. If even the maximum-overlap arc is wider than the screen, PAN the drum
//      (translateX) so the selection is centred. Panning, not rotating: a
//      forward-facing card that is merely displaced still renders at full width,
//      whereas rotating the arc to centre an end card swings the opposite end
//      toward edge-on and re-creates the sliver problem FAN_SPREAD_DEG was
//      tuned to avoid.
//   3. Lift the selection by however much the arc set it back, so "selected"
//      never renders smaller than its unselected neighbours.
//
// A note on what is NOT achievable: for a non-overlapping arc of forward-facing
// cards, the projected width tends to count * cardWidth as the spread narrows —
// the arc can never be more compact than the same cards laid flat side by side,
// whatever spread you choose. Perspective foreshortening buys back roughly
// 15-20%, and that is all. So three 340px cards genuinely cannot all be shown
// un-overlapped below ~890px of viewport. Overlap or panning is not a shortcut
// here; it is the only remaining move.

export const FAN_MAX_CARDS = 4;

// Total arc each count spreads over. Kept deliberately shallow: a card's readable
// (and clickable) width shrinks with cos(angle), so the end cards of a wide arc
// become slivers. At a 100deg spread the end cards of a 4-card fan measured 123px
// against the middle card's 316px, and users could not reliably hit them — which
// matters because a click is how you both select and dive. The widest angle here is
// 33deg (cos 0.84), so no card reads much narrower than the one facing you.
const FAN_SPREAD_DEG = { 1: 0, 2: 30, 3: 48, 4: 66 };

// Keep in sync with #stage{perspective:1400px} and the PERSPECTIVE constant in
// nd-mem-rolodex.html. Geometry that decides what fits on screen has to agree
// with the projection the browser actually performs.
export const FAN_PERSPECTIVE = 1400;

// How much of a card may be hidden by its neighbour before we stop shrinking the
// arc and start panning instead. At 0.62, adjacent centres sit 62% of a card
// apart, so ~38% of a side card is occluded — enough to still read its heading
// and land a tap, which is all a non-selected card needs to do. Below ~0.5 the
// side cards stop being independently clickable.
export const FAN_MIN_CHORD_RATIO = 0.62;

// Breathing room left between the outermost card edge and the viewport edge.
export const FAN_VIEWPORT_MARGIN = 24;

// Baseline z the selected card is raised to. At angle 0 this reproduces the old
// fixed FAN_LIFT_PX exactly, so the flat case looks and feels unchanged.
export const FAN_LIFT_MARGIN = 40;

export function isFanCount(count) {
  return count > 0 && count <= FAN_MAX_CARDS;
}

export function fanStep(count) {
  if (count <= 1) return 0;
  return (FAN_SPREAD_DEG[count] ?? FAN_SPREAD_DEG[FAN_MAX_CARDS]) / (count - 1);
}

export function fanSpread(count) {
  return count <= 1 ? 0 : (FAN_SPREAD_DEG[count] ?? FAN_SPREAD_DEG[FAN_MAX_CARDS]);
}

/**
 * Projected distance from stage centre to the outer edge of the outermost card,
 * using the same transform chain the renderer uses: the card is
 * rotateY(a) translateZ(radius) inside a drum at translateZ(-radius), so the
 * front card's face sits on the camera plane at z=0 and everything else recedes.
 *
 * `radius` is the CARD's own distance from the drum axis (which is larger than
 * the drum's own radius when the card is lifted — see `fanSelectedHalfWidth`);
 * `drumRadius` is what the drum itself is pulled back by (translateZ(-drumRadius)),
 * which stays the bare radius regardless of any one card's lift. They default to
 * the same value, which keeps every existing caller and test — none of which
 * measure a lifted card — byte-for-byte unchanged.
 */
export function fanProjectedHalfWidth(radius, count, cardWidth, perspective = FAN_PERSPECTIVE, drumRadius = radius) {
  const a = (fanSpread(count) / 2) * Math.PI / 180;
  const sin = Math.sin(a), cos = Math.cos(a);
  const x = (cardWidth / 2) * cos + radius * sin;
  const z = -(cardWidth / 2) * sin + radius * cos - drumRadius; // <= 0, away from viewer
  return x * (perspective / (perspective - z));
}

/**
 * The outermost card's projected half-width AS SELECTED — i.e. lifted. A
 * selected card is pulled toward the camera by `liftForCard`'s amount, which
 * pushes its outer edge both further out (lift*sin(angle)) and nearer the lens
 * (larger perspective scale), so it projects substantially wider than the bare
 * arc `fanProjectedHalfWidth(radius, ...)` reports. Measuring the bare arc
 * under-estimated the true on-screen extent by up to several hundred pixels at
 * wide viewports, which meant `fanRadius` and `drumLayout` could both decide
 * panning was unnecessary when the selected card would in fact hang off the
 * edge of the screen — under-panning, not over-panning: the dangerous
 * direction, since it silently fails to invoke the mechanism this whole file
 * exists to provide.
 */
function fanSelectedHalfWidth(radius, count, cardWidth, perspective = FAN_PERSPECTIVE) {
  const a = (fanSpread(count) / 2) * Math.PI / 180;
  const lift = (radius + FAN_LIFT_MARGIN) / Math.cos(a) - radius;
  return fanProjectedHalfWidth(radius + lift, count, cardWidth, perspective, radius);
}

/**
 * Adjacent card centres sit a chord apart on the arc. A chord of one full card
 * width means no overlap; FAN_MIN_CHORD_RATIO of one is the most overlap we
 * accept. Between those two radii we take the largest that still fits the
 * viewport.
 *
 * `viewportWidth` defaults to Infinity, which makes the budget unbounded and
 * returns the no-overlap radius — byte-for-byte the old behaviour, so existing
 * callers and tests that pass two arguments are unaffected.
 */
export function fanRadius(cardWidth, count, viewportWidth = Infinity, options = {}) {
  const step = fanStep(count);
  if (step <= 0) return options.minRadius ?? 260;
  const perspective = options.perspective ?? FAN_PERSPECTIVE;
  const margin = options.margin ?? FAN_VIEWPORT_MARGIN;
  const chordRatio = options.minChordRatio ?? FAN_MIN_CHORD_RATIO;

  const halfChordAngle = Math.sin((step / 2) * Math.PI / 180);
  const ideal = cardWidth / (2 * halfChordAngle);            // zero overlap
  const floor = (chordRatio * cardWidth) / (2 * halfChordAngle); // max overlap

  const minRadius = options.minRadius ?? 260;
  const budget = viewportWidth / 2 - margin;
  // The card that has to fit is the SELECTED (lifted) one, not the bare arc —
  // measuring the bare arc under-estimated the true extent and let this return
  // "fits" when the selected card would in fact hang off the screen.
  if (!Number.isFinite(budget) || fanSelectedHalfWidth(ideal, count, cardWidth, perspective) <= budget) {
    return Math.ceil(Math.max(minRadius, ideal));
  }

  // fanSelectedHalfWidth is monotonically increasing in radius (verified by
  // sampling — see "fanSelectedHalfWidth is monotone in radius over the range
  // fanRadius bisects" in the test suite), so bisection finds the fitting
  // radius without the algebra needed to invert the perspective divide — and
  // stays correct if the projection model is ever refined.
  let lo = floor, hi = ideal;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fanSelectedHalfWidth(mid, count, cardWidth, perspective) <= budget) lo = mid;
    else hi = mid;
  }
  return Math.ceil(Math.max(minRadius, floor, lo));
}

// One descriptor per drum build. Every geometry consumer (placement, hit
// testing, snapping, clamping, panning, lifting) reads from this, so fan and
// cylinder never need branching at the call site.
export function drumLayout(cardWidth, count, viewportWidth = Infinity) {
  if (isFanCount(count)) {
    const step = fanStep(count);
    const mid = (count - 1) / 2;
    const angles = Array.from({ length: count }, (_, i) => (i - mid) * step);
    const radius = fanRadius(cardWidth, count, viewportWidth);
    // The selected card is the one that must stay on screen, and it renders
    // lifted — nearer the camera and pushed outward by lift*sin(angle) — so it
    // projects wider than the bare arc. Deciding `panning` from the bare arc's
    // half-width under-estimated the true extent (by up to several hundred
    // pixels at wide viewports) and could leave `panning` false while the
    // selected card actually hung off the edge of the screen.
    const halfWidth = fanSelectedHalfWidth(radius, count, cardWidth);
    const budget = viewportWidth / 2 - FAN_VIEWPORT_MARGIN;
    // Only pan when the arc genuinely overflows. A fan that fits stays
    // symmetric about centre, which is the composition the design wants.
    const panning = Number.isFinite(budget) && halfWidth > budget + 0.5;
    // Extra translateZ that puts the selected card's face at
    // z = FAN_LIFT_MARGIN regardless of its angle. Without this the fixed
    // 40px lift under-compensated: the selected end card of a 4-fan landed at
    // z=-110 while an unselected middle card sat at z=-16, so the selection
    // rendered ~6% smaller AND painted behind its own neighbour.
    const lifts = angles.map(a => {
      const cos = Math.cos(a * Math.PI / 180);
      return Math.round((radius + FAN_LIFT_MARGIN) / cos - radius);
    });
    // Precomputed per card, like `angles`, so consumers never redo trig.
    // Centring card i needs translateX(-radius*sin(angle_i)): the drum's own
    // translateZ is unchanged by an X shift, so the perspective scale cancels
    // and the correction is exact at any depth.
    //
    // The pan has to cancel the SELECTED card's x offset, and a selected card is
    // lifted — so its face sits at (radius + lift) * sin(angle), not radius *
    // sin(angle). Ignoring the lift term left the steepest cards short of centre by
    // lift * sin(angle): zero at 0deg, ~29px at 33deg, which is exactly the residual
    // overflow measured on a 390px viewport.
    const pans = angles.map((a, i) => (panning
      ? -Math.round((radius + lifts[i]) * Math.sin(a * Math.PI / 180))
      : 0));
    return {
      mode: 'fan', count, step, radius, angles,
      minRotation: -angles[count - 1],
      maxRotation: -angles[0],
      pans,
      lifts,
      panning,
      overlapRatio: 1 - (2 * radius * Math.sin((step / 2) * Math.PI / 180)) / cardWidth,
    };
  }
  const step = count > 0 ? 360 / count : 0;
  return {
    mode: 'cylinder', count, step,
    radius: drumRadius(cardWidth, count),
    angles: Array.from({ length: count }, (_, i) => i * step),
    minRotation: -Infinity,
    maxRotation: Infinity,
    // A cylinder centres by rotating, so the front card is already at x~0 and
    // needs no shift. Present as zeros so callers stay branch-free.
    pans: Array.from({ length: count }, () => 0),
    lifts: Array.from({ length: count }, () => 0),
    panning: false,
    overlapRatio: 0,
  };
}

/** Camera-space X shift that centres card `index`. 0 whenever the arc fits. */
export function panForCard(index, layout) {
  if (!layout || !layout.pans || index < 0 || index >= layout.count) return 0;
  return layout.pans[index] || 0;
}

/** translateZ to add to a selected card's own radius. 0 in cylinder mode. */
export function liftForCard(index, layout) {
  if (!layout || !layout.lifts || index < 0 || index >= layout.count) return 0;
  return layout.lifts[index] || 0;
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

// ---------- refresh & pop reconciliation (spec rules 1-4) ----------
//
// PRECONDITION FOR CONSUMERS: reconcileView/reconcilePop carry the view's
// `rotation` through unchanged, as a hint only. It is NOT reconciled and may
// contradict the returned `centeredId`, because the drum's item count and
// ordering can both change between renders (e.g. centered on 'mem_1' at
// rotation -180 of a 2-card drum; a new memory arrives, the drum becomes 3
// cards, and -180 no longer faces 'mem_1'). After ANY reconciliation the
// consumer MUST recompute the angle from the centered id against the returned
// ids, never trusting view.rotation:
//
//   rotationForIndex(ids.indexOf(view.centeredId), ids.length)
//
// The authoritative outputs of a reconcile are `centeredId` and `itemIds`.

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

// ---------- gesture routing (spec input map) ----------
// insideReader is only true when the pointer is inside the front card's
// scrollable reader area (memories level, content actually overflowing).
// It gates SCROLLING only: clicks dive at every level, because a reader that
// eats clicks reads as a broken app. Controls inside a card (Edit, links) are
// exempted by the page's DOM guard before this is ever consulted.

export function routeGesture(kind, ctx) {
  const { level, insideReader } = ctx;
  switch (kind) {
    case 'wheel': return insideReader ? 'scrollContent' : 'spin';
    case 'vswipe': return insideReader ? 'scrollContent' : 'spin';
    case 'hdrag': return 'spin';
    case 'ctrlWheelUp': case 'pinchSpread': case 'enter': return 'dive';
    case 'ctrlWheelDown': case 'pinchTogether': case 'rightClick': case 'esc': case 'back': return 'zoomOut';
    case 'clickCentered': return 'dive';
    case 'clickOther': return 'centerThenDive';
    case 'arrowLeft': return 'stepPrev';
    case 'arrowRight': return 'stepNext';
    default: return 'none';
  }
}

// ---------- navigation tree ----------
// Supersedes the history stack. The cursor's ancestor chain plays exactly the
// role the stack played (wall, zoom-out, reconciliation), while abandoned
// branches are kept so the session's exploration can be drawn and revisited.
// EVERY dive gesture is one navPush — click, Enter, ctrl+wheel, pinch, and the
// memories->projects wrap alike. There is no separate lap or loop counter:
// wraps are ordinary projects-level children and depth just keeps climbing.

export function createNavTree(rootView) {
  return {
    nodes: [{ id: 0, parentId: null, view: { ...rootView, itemIds: [...(rootView.itemIds || [])] }, childIds: [] }],
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

// Columns are deliberately much wider than a node (r=5, so 10px across): at 26px a
// fork read as a jog in a trunk rather than a branch. Rows are tighter than columns
// so a deep chain does not stretch the tree into a thread.
const MINIMAP_COL = 46;   // px between sibling columns
const MINIMAP_ROW = 28;   // px between depth rows
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
