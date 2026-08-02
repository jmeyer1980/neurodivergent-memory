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
// make a cube showing one face. Small drums instead fan forward on a large,
// shallow arc so several cards read at once, and ROTATE to bring the selected
// card to centre — clamped at the ends (`clampRotation`) rather than wrapping,
// since there is no card past the last one to wrap to.
//
// HISTORY, so the reasoning survives the code that carried it: the original
// defect was misdiagnosed as "rotation is the problem", because the fan sat at
// a tight, four-card-diameter radius where rotating to centre an end card swung
// the far card past 90deg, facing away. That misdiagnosis produced three layers
// of machinery, each one patching the previous layer's consequence: a fan that
// never rotates (so the selection had to be marked by lifting it instead), a
// pan to bring an off-screen selection to centre (since a non-rotating fan
// cannot), and viewport-aware arc-shrinking to keep that pan on screen. The
// real defect was the radius, not the rotation: at the shallow FAN_SPREAD_DEG
// steps below, the far card of a centred end selection lands at only ~45deg
// (cos 0.7 — still readable), so rotation was fine all along once the drum was
// sized to avoid the tight arc. Reverting to rotation deletes all three layers
// at once. See `docs/superpowers/specs/2026-07-29-rolodex-navigation-aids-design.md`
// §4 for the fuller account.
//
// A second-order effect worth keeping deliberately: because centring is done by
// rotation, the selected card always sits at 0deg — flat, full width, at z=0 —
// which is what makes it hit-testable by the browser (see cardIndexAtPoint's
// comment in nd-mem-rolodex.html).
//
// A note on what is NOT achievable: for a non-overlapping arc of forward-facing
// cards, the projected width tends to count * cardWidth as the spread narrows —
// the arc can never be more compact than the same cards laid flat side by side,
// whatever spread you choose. Perspective foreshortening buys back roughly
// 15-20%, and that is all. So four non-overlapping 340px cards genuinely cannot
// be shown at once below ~1090px of viewport — accepted, not engineered around.

export const FAN_MAX_CARDS = 4;

// Total arc each count spreads over. Chosen so that when an END card is centred by
// rotation, the far card sits at no more than ~45deg (cos 0.7 — still clearly
// readable). That is the constraint the old tight arc violated: at a 66deg spread on
// a small radius, centring an end card swung the far one to 100deg, facing away.
// The radius follows from non-overlap at these steps and comes out large (~1300px for
// four 340px cards), which is exactly the "not a four-card diameter" the design wants.
const FAN_SPREAD_DEG = { 1: 0, 2: 30, 3: 40, 4: 45 };

// Keep in sync with #stage{perspective:1400px} in nd-mem-rolodex.html, which
// imports this rather than redeclaring its own copy. Geometry that decides
// what the browser projects has to agree with the projection it performs.
export const FAN_PERSPECTIVE = 1400;

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

// Adjacent card centres sit a chord apart on the arc; the chord must be at least a card
// wide or the faces overlap and hide each other. With the shallow steps above this comes
// out deliberately large — a big drum with a small arc, not a tight ring of four cards.
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
    const radius = fanRadius(cardWidth, count);
    return {
      mode: 'fan', count, step, radius, angles,
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

// Live for fans again: a small drum rotates to centre its selection just like
// a cylinder does, but it has no card past its ends to wrap to, so it clamps
// at `minRotation`/`maxRotation` instead — the page's tick() calls this on
// every frame a fan's momentum is decaying, exactly as it does for a cylinder
// (which never clamps, since `layout.mode !== 'fan'` short-circuits below).
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
    // Long-press creates, carrying the pressed card's context. Not at the
    // memories level: there the card is a reading surface and the press belongs
    // to text selection. Right-click is unavailable -- `rightClick` above
    // already means zoomOut -- so this is the only free gesture.
    case 'longPress': return level === 'memories' ? 'none' : 'create';
    default: return 'none';
  }
}

// How far a pointer must travel from its press origin before the gesture is
// committed to an axis. Large enough to survive the sub-pixel wobble that
// pointer capture delivers on every human press, small enough that the reader
// starts moving well inside the first thumb-flick.
export const DRAG_AXIS_THRESHOLD_PX = 10;

// dx/dy are NET displacement from the press origin, never accumulated path
// length — the same rule the click/drag discrimination uses, and for the same
// reason (see the note on dragMoved in the page).
// Ties go to 'horizontal': spin is the drum's primary gesture, so an ambiguous
// diagonal must never silently stop spinning.
export function classifyDragAxis(dx, dy, threshold = DRAG_AXIS_THRESHOLD_PX) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < threshold) return 'undecided';
  return ay > ax ? 'vertical' : 'horizontal';
}

// The pointer path's entry into the gesture table above. 'vswipe' and 'hdrag'
// were specified and unit-tested from day one, but nothing ever dispatched
// either of them from a pointer event: touch scrolling was delegated wholesale
// to the browser's native panning of the reader. That works in Blink and does
// not on WebKit inside the preserve-3d card stack, where the vertical swipe
// fell through to the drum and spun it instead. This is the missing wire.
export function routeDragAxis(axis, ctx) {
  if (axis === 'undecided') return 'wait';
  return routeGesture(axis === 'vertical' ? 'vswipe' : 'hdrag', ctx);
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
    // itemIds are project ids only at the projects level (districts/memories
    // level itemIds are district/memory ids, which happen to share a namespace
    // with project ids — e.g. a district literally named "logical_analysis" —
    // so rewriting them unconditionally could corrupt an unrelated node's
    // reconciliation data). Gate both rewrites the same way.
    if (node.view.level === 'projects') {
      if (node.view.centeredId === oldId) node.view.centeredId = newId;
      node.view.itemIds = (node.view.itemIds || []).map(id => (id === oldId ? newId : id));
    }
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

// Declared here, above truncateNodeLabel, and not down with MINIMAP_COL where
// the other minimap-geometry constants live: the function's `max =
// NODE_LABEL_MAX` default parameter evaluates at CALL time, not definition
// time, so it works today only because nothing calls truncateNodeLabel during
// this module's own top-to-bottom evaluation. A future top-level call (a
// module-init self-test, say) made before the old lower declaration ran would
// have hit a TDZ ReferenceError on a `const` that looked already in scope.
export const NODE_LABEL_MAX = 10;

// The map's only label used to be an SVG <title>, which requires a hover — so
// on touch the tree was a field of identical dots. Labels now render as text,
// which means they have to fit: elide the MIDDLE, because project ids share
// heads ("twg-…") and district names share tails ("…_analysis"/"…_monitoring"),
// and dropping either end alone collapses distinct nodes into the same string.
export function truncateNodeLabel(label, max = NODE_LABEL_MAX) {
  const s = String(label ?? '');
  if (s.length <= max) return s;
  const keep = max - 1;                 // one char is spent on the ellipsis
  // Tail gets the extra char when keep is odd, not head: word endings
  // ("-ation" vs "-ution") carry more distinguishing signal than a shared
  // prefix, so biasing the split toward the tail keeps more labels apart.
  const head = Math.floor(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}…${tail ? s.slice(-tail) : ''}`;
}

// What a new memory inherits from where you are standing. The deeper you are,
// the more context it takes -- which is exactly what the coordinate already
// means. A long-pressed card outranks the current view, because pressing a
// specific card is a more explicit statement of intent than standing near it.
//
// UNASSIGNED and UNCATEGORIZED are DISPLAY buckets for memories with no project
// or district respectively, not real project/district ids. Inheriting them would
// create literal entities named after the placeholders, which is wrong.
export function createDefaultsFor(view, pressedCard = null) {
  const realProject = (id) => (id && id !== UNASSIGNED ? String(id) : null);
  const realDistrict = (id) => (id && id !== UNCATEGORIZED ? String(id) : null);

  if (pressedCard && pressedCard.kind === 'project') {
    return { projectId: realProject(pressedCard.id), district: null };
  }
  if (pressedCard && pressedCard.kind === 'district') {
    return { projectId: realProject(view.projectId), district: realDistrict(pressedCard.id) };
  }
  if (view.level === 'memories') {
    return { projectId: realProject(view.projectId), district: realDistrict(view.districtId) };
  }
  if (view.level === 'districts') {
    return { projectId: realProject(view.projectId), district: null };
  }
  return { projectId: null, district: null };
}

// What the edit modal's district <select> should be populated with, so that
// assigning `district` to it always finds an <option>.
//
// register_district is a supported tool and deriveDistricts renders a card for
// whatever district the data actually contains, so a legacy or custom district
// reaches the modal routinely -- and a <select> asked for a value it has no
// option for silently goes to selectedIndex -1, i.e. renders BLANK. Edit mode
// prepended the stray value; create mode did not, so long-pressing a custom
// district card opened a modal with an empty District field and then posted
// district: ''. One function now, because the defect was precisely that the
// rule lived in one of the two places that needed it.
export function districtOptions(district) {
  if (!district || CANONICAL_DISTRICTS.includes(district)) return CANONICAL_DISTRICTS;
  return [district, ...CANONICAL_DISTRICTS];
}

// Columns are deliberately much wider than a node (r=5, so 10px across): at 26px a
// fork read as a jog in a trunk rather than a branch. Rows are tighter than columns
// so a deep chain does not stretch the tree into a thread.
// Widened from 46 to fit a 10-char label beside each node: ~58px of text plus
// the node's own r=5 and a 4px gap needs ~67px of clearance. (The 26 in the
// comment above is an even older value this constant already superseded —
// derive from the constant, never from the prose.)
export const MINIMAP_COL = 76;   // px between sibling columns
// NODE_LABEL_MAX lives above truncateNodeLabel now, not here — see that
// declaration for why. MINIMAP_COL itself has no such trap: layoutNavTree,
// its only reader, is declared below this line, so it is never in scope
// before MINIMAP_COL is.
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

// ---------- hint bar wording ----------

// The hint bar shipped as one desktop sentence shown to everyone, then hidden
// outright in landscape. A thumb has no right-click and no Ctrl key, so the
// portrait phone was being given instructions it could not follow. Wording is
// data keyed by (level, pointerKind) so it can be tested without a browser.
export const HINTS = {
  fine: {
    default: 'Scroll to spin · click a card to dive · right-click / Esc to zoom out · Ctrl+scroll zooms',
    memories: 'Scroll to spin · scroll inside the card to read · click to dive onward · right-click / Esc goes back',
  },
  coarse: {
    default: 'Swipe to spin · tap a card to open · pinch in to go back',
    memories: 'Swipe to spin · drag inside the card to read · tap to go onward · pinch in to go back',
  },
};

export function hintFor(level, pointerKind) {
  const table = HINTS[pointerKind] ?? HINTS.fine;
  return table[level] ?? table.default;
}

// search_memories answers in PROSE, for a reader:
//   • [0.873] memory_123 — Some title (scholar)
//     first eighty characters of content…
// There is no structured search API and the BM25 index is private to
// server-main.ts, so the bridge recovers the two tokens it cannot get locally --
// the id and its score -- and hydrates everything else from the snapshot it
// already reads. Deliberately anchored on the "[score] id" shape: the partial-
// matches block below the results uses bullets too, but carries no score, so
// requiring the bracket keeps those out.
//
// This regex is the whole fragile seam in the search feature. Its failure mode
// is SILENT -- zero hits, not an error -- which is why a contract test runs the
// real tool and asserts this still parses it.
const SEARCH_HIT_RE = /^\s*[•*-]\s*\[(\d+(?:\.\d+)?)\]\s*(\S+)\s+—/;

export function parseSearchResults(text) {
  if (typeof text !== 'string' || text === '') return [];
  const hits = [];
  for (const line of text.split('\n')) {
    const m = SEARCH_HIT_RE.exec(line);
    if (!m) continue;
    const score = Number(m[1]);
    if (!Number.isFinite(score)) continue;
    hits.push({ id: m[2], score });
  }
  return hits;
}

// ---------- search lighting ----------

// One rule at every level: a card is lit if IT, or anything inside it, matched.
// That is what turns a search into a drill-down -- query at the wall, see which
// projects light, dive into a lit one, see which districts light -- instead of
// needing a separate results view.
export function isLit(item, hits, snapshot, view = {}) {
  if (!hits || hits.size === 0 || !item) return false;
  if (item.kind === 'memory') return hits.has(item.id);
  const memories = Object.values(snapshot?.memories ?? {});
  if (item.kind === 'project') {
    return memories.some(m => hits.has(m.id) && projectOf(m) === item.id);
  }
  if (item.kind === 'district') {
    // Scoped to the project being viewed. District names are shared across
    // projects, not globally unique buckets -- without this, standing inside
    // project beta would light its practical_execution card because something
    // in ALPHA's practical_execution matched.
    const scope = view.projectId;
    return memories.some(m => hits.has(m.id)
      && districtOf(m) === item.id
      && (scope == null || projectOf(m) === scope));
  }
  return false;
}

// Stepping skips dark cards while a search is active, so a 364-memory bucket
// stays fast. With nothing lit at this level, fall back to ordinary stepping
// rather than refusing to move -- a search that matches nothing here must not
// strand the drum.
export function nextLitIndex(items, hits, snapshot, view, from, direction) {
  const count = items.length;
  if (!count) return from;
  const step = direction >= 0 ? 1 : -1;
  const plain = ((from + step) % count + count) % count;
  if (!hits || hits.size === 0) return plain;
  for (let i = 1; i <= count; i++) {
    const idx = ((from + step * i) % count + count) % count;
    if (isLit(items[idx], hits, snapshot, view)) return idx;
  }
  return plain;
}
