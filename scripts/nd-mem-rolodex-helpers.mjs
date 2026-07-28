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
