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
