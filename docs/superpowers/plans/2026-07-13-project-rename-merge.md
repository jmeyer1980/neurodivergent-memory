# Project Rename / Merge-on-Collision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Rename project…" action to the ND-Mem web app that bulk re-assigns `project_id` for every memory in the active project — merging into an existing project (with confirmation) when the new name collides, per [docs/superpowers/specs/2026-07-13-project-rename-merge-design.md](../specs/2026-07-13-project-rename-merge-design.md).

**Architecture:** Pure helpers (`normalizeProjectId`, `nearMissOf`) live in a new real module `scripts/nd-mem-app-helpers.mjs` so they are unit-testable; the bridge serves it via one static route; the HTML app loads it with a `<script type="module">` that publishes `window.ndMemHelpers`. The merge itself is a client-side sequential loop of `POST /update` calls carrying only `{memoryId, projectId}` — no daemon or bridge write-path changes.

**Tech Stack:** Plain ES modules, node:test + node:assert/strict, express bridge (`scripts/nd-mem-bridge-server.mjs`), single-file HTML app (`scripts/nd-mem-mcp-app-bridge.html`).

## Global Constraints

- **No version bump, no release framing** — this repo's convention is build-and-serve-locally; version stays `0.3.9` and any CHANGELOG content goes under `## [Unreleased]`.
- The bridge's **write path is unchanged**: `/save` and `/update` keep their exact request/response shapes. Only a static GET route is added.
- Merge updates send **only** `{memoryId, projectId}` — content, tags, district, visibility, intensity must not appear in the body (the bridge forwards only supplied fields).
- Collision matching: `normalizeProjectId` lowercases, trims, and maps `-` → `_`. Near-miss: Levenshtein distance ≤ 2 on normalized forms, distance 0 excluded (that's a collision, not a near-miss).
- The `(unassigned)` pseudo-project (`UNASSIGNED` constant, literal `'(no project)'`) can never be renamed — the button is hidden when it is the active carousel.
- The web app must keep working when opened **directly as a file** (`file:///…/nd-mem-mcp-app-bridge.html`) as well as served from the bridge at `/` — the user does both. Hence the helpers module is imported by absolute URL (`http://localhost:3737/nd-mem-app-helpers.mjs`) and the rename handler guards on `window.ndMemHelpers` being present.
- Suite baseline: `npm test` currently has 2 pre-existing failures in `test/agent-customization-wording.test.mjs` (template drift, unrelated). "Suite green" means no NEW failures.
- Commits use conventional-commit subjects and end with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Pure helpers module with unit tests

**Files:**
- Create: `scripts/nd-mem-app-helpers.mjs`
- Test: `test/project-rename-helpers.test.mjs`

**Interfaces:**
- Produces: `normalizeProjectId(id: unknown): string`, `levenshtein(a: string, b: string): number`, `nearMissOf(candidate: string, existingIds: string[]): string | null`. Tasks 2–3 rely on these exact names; the HTML app calls them via `window.ndMemHelpers`.

- [ ] **Step 1: Write the failing test**

```js
// test/project-rename-helpers.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectId, levenshtein, nearMissOf } from "../scripts/nd-mem-app-helpers.mjs";

test("normalizeProjectId lowercases, trims, and maps hyphens to underscores", () => {
  assert.equal(normalizeProjectId("TWG-ProgressionGraph"), "twg_progressiongraph");
  assert.equal(normalizeProjectId("  twg_progressiongraph  "), "twg_progressiongraph");
  assert.equal(normalizeProjectId("a-b-c"), "a_b_c");
  assert.equal(normalizeProjectId(""), "");
  assert.equal(normalizeProjectId(null), "");
  assert.equal(normalizeProjectId(undefined), "");
});

test("levenshtein computes edit distance", () => {
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", "abd"), 1);
  assert.equal(levenshtein("abc", ""), 3);
  assert.equal(levenshtein("", "ab"), 2);
  // the user's real-world typo: one missing character
  assert.equal(levenshtein("twg_progressiograph", "twg_progressiongraph"), 1);
});

test("nearMissOf finds close-but-not-identical project ids", () => {
  const existing = ["twg_progressiongraph", "yorkz", "warbler-cda"];
  // one missing character -> near miss
  assert.equal(nearMissOf("twg_progressiograph", existing), "twg_progressiongraph");
  // identical after normalization (distance 0) is a collision, NOT a near miss
  assert.equal(nearMissOf("TWG-ProgressionGraph", existing), null);
  // far away from everything -> null
  assert.equal(nearMissOf("completely_different", existing), null);
  // empty candidate matches nothing
  assert.equal(nearMissOf("", existing), null);
});

test("nearMissOf returns the closest candidate when several are within range", () => {
  const existing = ["projct_a", "project_ab"];
  // "project_a": distance 1 to "projct_a" (insert o), distance 1 to "project_ab" (delete b) — ties resolve to the first found
  assert.equal(nearMissOf("project_a", existing), "projct_a");
  // distance 2 still matches when it is the only candidate in range
  assert.equal(nearMissOf("project_axy", ["project_a"]), "project_a");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/project-rename-helpers.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/nd-mem-app-helpers.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// scripts/nd-mem-app-helpers.mjs
// Pure helpers for the ND-Mem web app's project rename/merge flow.
// Served to the browser by the bridge at /nd-mem-app-helpers.mjs and
// imported directly by test/project-rename-helpers.test.mjs.

/** Canonical form used for project-id collision matching: lowercase, trimmed, '-' ≡ '_'. */
export function normalizeProjectId(id) {
  return String(id ?? "").trim().toLowerCase().replace(/-/g, "_");
}

/** Classic two-row Levenshtein edit distance. */
export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * The closest existing project id whose normalized form is within edit
 * distance 2 of the candidate's — excluding exact (distance 0) matches,
 * which are collisions handled separately. Returns null when nothing is close.
 */
export function nearMissOf(candidate, existingIds) {
  const norm = normalizeProjectId(candidate);
  if (!norm) return null;
  let best = null;
  let bestDist = Infinity;
  for (const id of existingIds) {
    const d = levenshtein(norm, normalizeProjectId(id));
    if (d > 0 && d <= 2 && d < bestDist) {
      best = id;
      bestDist = d;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/project-rename-helpers.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-app-helpers.mjs test/project-rename-helpers.test.mjs
git commit -m "feat: add project-id normalize and near-miss helpers for rename/merge"
```

---

### Task 2: Bridge serves the helpers module

**Files:**
- Modify: `scripts/nd-mem-bridge-server.mjs` (immediately after the `app.get('/', …)` block that ends at line ~125)
- Test: `test/bridge-project-reassign.test.mjs` (created here with the route assertion; Task 3 extends this same file with the reassignment test)

**Interfaces:**
- Consumes: `scripts/nd-mem-app-helpers.mjs` from Task 1 (served verbatim).
- Produces: `GET /nd-mem-app-helpers.mjs` → 200, `Content-Type: text/javascript`, body containing `normalizeProjectId`. The HTML app (Task 3) imports this URL.

- [ ] **Step 1: Write the failing test**

```js
// test/bridge-project-reassign.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} not ready in ${timeoutMs}ms`);
}

export function startBridge(tempDir, bridgePort, daemonPort) {
  return spawn(process.execPath, ["scripts/nd-mem-bridge-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ND_MEM_BRIDGE_PORT: String(bridgePort),
      ND_MEM_FILE: path.join(tempDir, "memories.json"),
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

test("bridge serves the app helpers module as javascript", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-helpers-route-"));
  const bridgePort = await getFreePort();
  const daemonPort = await getFreePort();
  const bridge = startBridge(tempDir, bridgePort, daemonPort);
  try {
    await waitFor(`http://127.0.0.1:${bridgePort}/health`);
    const res = await fetch(`http://127.0.0.1:${bridgePort}/nd-mem-app-helpers.mjs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);
    const body = await res.text();
    assert.match(body, /export function normalizeProjectId/);
  } finally {
    bridge.kill();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/bridge-project-reassign.test.mjs`
Expected: FAIL — the helpers fetch returns 404 (route does not exist yet). The `/health` wait passes because the bridge itself runs fine.

- [ ] **Step 3: Add the static route to the bridge**

In `scripts/nd-mem-bridge-server.mjs`, immediately AFTER the closing `});` of the `app.get('/', …)` handler (line ~125), insert:

```js
// Serves the pure helpers module shared between the web app (loaded as an
// ES module in the browser) and the node test suite (imported directly).
const HELPERS_PATH = path.join(process.cwd(), 'scripts', 'nd-mem-app-helpers.mjs');
app.get('/nd-mem-app-helpers.mjs', (_req, res) => {
  if (fs.existsSync(HELPERS_PATH)) {
    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(fs.readFileSync(HELPERS_PATH, 'utf-8'));
  } else {
    res.status(404).send('helpers module not found. Ensure scripts/nd-mem-app-helpers.mjs exists.');
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/bridge-project-reassign.test.mjs`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add scripts/nd-mem-bridge-server.mjs test/bridge-project-reassign.test.mjs
git commit -m "feat: bridge serves nd-mem-app-helpers.mjs for the web app"
```

---

### Task 3: Rename/merge UI in the web app + reassignment regression test

**Files:**
- Modify: `scripts/nd-mem-mcp-app-bridge.html` (sidebar header ~line 29, `els` map ~line 103, new functions after `updateMemory` ~line 248, wiring block ~lines 250–262, module loader script before the main `<script>` ~line 96, `render()` ~line 142)
- Test: `test/bridge-project-reassign.test.mjs` (extend the file created in Task 2)

**Interfaces:**
- Consumes: `window.ndMemHelpers` = `{ normalizeProjectId, levenshtein, nearMissOf }` (Tasks 1–2); existing app functions `activeCarousel()`, `carousels()`, `loadSnapshot()`, `showToast()`, constant `UNASSIGNED`, state object `state`.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Extend the bridge test with the reassignment regression (write it first)**

Append to `test/bridge-project-reassign.test.mjs` (reusing its `getFreePort`/`waitFor`/`startBridge` helpers):

```js
test("POST /update with only {memoryId, projectId} moves a memory between projects without touching other fields", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-reassign-"));
  const bridgePort = await getFreePort();
  const daemonPort = await getFreePort();
  const memoryFile = path.join(tempDir, "memories.json");
  const bridge = startBridge(tempDir, bridgePort, daemonPort);
  let daemonPid;
  try {
    await waitFor(`http://127.0.0.1:${bridgePort}/health`);
    const save = (content, projectId) =>
      fetch(`http://127.0.0.1:${bridgePort}/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, district: "practical_execution", tags: ["kind:task", "scope:project"], projectId }),
      }).then((r) => r.json());

    for (const [content, project] of [
      ["drift memory one", "drift-a"],
      ["drift memory two", "drift-a"],
      ["canonical memory", "drift_b"],
    ]) {
      const saved = await save(content, project);
      assert.equal(saved.ok, true, JSON.stringify(saved));
    }

    daemonPid = (await waitFor(`http://127.0.0.1:${daemonPort}/health`).then((r) => r.json())).pid;

    // Wait for all three to hit the snapshot, then capture pre-move state.
    let snapshot;
    {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (fs.existsSync(memoryFile)) {
          snapshot = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
          if (Object.keys(snapshot.memories).length === 3) break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(Object.keys(snapshot.memories).length, 3, "all three memories persisted");
    }
    const driftIds = Object.values(snapshot.memories).filter((m) => m.project_id === "drift-a").map((m) => m.id);
    assert.equal(driftIds.length, 2);
    const before = Object.fromEntries(driftIds.map((id) => [id, snapshot.memories[id]]));

    // The merge loop's exact contract: only memoryId + projectId in the body.
    for (const id of driftIds) {
      const updated = await fetch(`http://127.0.0.1:${bridgePort}/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memoryId: id, projectId: "drift_b" }),
      }).then((r) => r.json());
      assert.equal(updated.ok, true, JSON.stringify(updated));
    }

    // All three end in drift_b; moved cards keep every other field.
    {
      const deadline = Date.now() + 5000;
      let done = false;
      while (Date.now() < deadline && !done) {
        snapshot = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
        done = Object.values(snapshot.memories).every((m) => m.project_id === "drift_b");
        if (!done) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(done, "every memory reassigned to drift_b");
    }
    for (const id of driftIds) {
      const after = snapshot.memories[id];
      assert.equal(after.content, before[id].content, "content untouched");
      assert.deepEqual(after.tags, before[id].tags, "tags untouched");
      assert.equal(after.district, before[id].district, "district untouched");
      assert.equal(after.visibility, before[id].visibility, "visibility untouched");
    }
  } finally {
    bridge.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* gone */ } }
  }
});
```

- [ ] **Step 2: Run it — this one should already PASS (it exercises existing bridge/daemon behavior; it is the regression net for the UI loop's contract)**

Run: `npm run build && node --test test/bridge-project-reassign.test.mjs`
Expected: PASS (2 tests). If it FAILS, the `/update` partial-field contract is broken — stop and report; do not proceed to UI work on a broken contract.

- [ ] **Step 3: Add the module loader and the rename button to the HTML**

In `scripts/nd-mem-mcp-app-bridge.html`:

a. Sidebar header (line ~29) — replace:

```html
      <div class="sidehead"><h2>Projects</h2><p>Auto-discovered from every memory's project_id. Cards group into districts.</p></div>
```

with:

```html
      <div class="sidehead"><h2>Projects</h2><p>Auto-discovered from every memory's project_id. Cards group into districts.</p><button class="btn" id="renameProjectBtn" style="margin-top:10px">Rename project…</button></div>
```

b. Immediately BEFORE the existing `<script>` tag (line ~96), add the module loader (absolute URL so the app also works when opened via `file://`; `window.ndMemHelpers` stays undefined if the bridge is down and the rename handler guards on that):

```html
  <script type="module">
    try {
      const helpers = await import('http://localhost:3737/nd-mem-app-helpers.mjs');
      window.ndMemHelpers = helpers;
    } catch { /* bridge down — rename flow will explain when clicked */ }
  </script>
```

c. In the `els` map (line ~103), add `renameProjectBtn:$('#renameProjectBtn'),` after `carouselInput:$('#carouselInput')` (inside the braces).

- [ ] **Step 4: Add the rename/merge functions**

In the main `<script>`, immediately AFTER the `updateMemory` function (its closing `}` at line ~248), add:

```js
    function setWriteButtonsDisabled(disabled){
      for(const id of ['renameProjectBtn','editSaveBtn','saveBtn']){ const el = $('#'+id); if(el) el.disabled = disabled; }
    }

    async function bulkReassign(ids, target, source){
      setWriteButtonsDisabled(true);
      let moved = 0;
      try {
        for(const id of ids){
          showToast(`Moving ${moved+1}/${ids.length} into ${target}…`);
          let ok = false;
          try {
            const res = await fetch(`${BRIDGE}/update`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ memoryId:id, projectId:target }) });
            const data = await res.json();
            ok = res.ok && data.ok;
          } catch { ok = false; }
          if(!ok){ showToast(`Moved ${moved} of ${ids.length}. Re-run rename to move the rest.`); return; }
          moved++;
        }
        state.activeCarousel = target;
        await loadSnapshot();
        showToast(`Moved ${moved} card${moved===1?'':'s'} from ${source} to ${target}.`);
      } finally {
        setWriteButtonsDisabled(false);
      }
    }

    async function renameProject(){
      const c = activeCarousel();
      if(!c || c.id===UNASSIGNED){ showToast('Select a real project first.'); return; }
      const helpers = window.ndMemHelpers;
      if(!helpers){ showToast('Helpers not loaded — is the bridge running at ' + BRIDGE + '?'); return; }
      const typed = prompt(`Rename project "${c.id}" to:`, c.id);
      if(typed===null) return;
      const newName = typed.trim();
      if(!newName || newName===c.id) return;
      const others = carousels().filter(x=>x.id!==UNASSIGNED && x.id!==c.id);
      const collision = others.find(o=>helpers.normalizeProjectId(o.id)===helpers.normalizeProjectId(newName));
      let target = newName;
      if(collision){
        if(!confirm(`Project "${collision.id}" already exists (${collision.items.length} cards). Move all ${c.items.length} cards from "${c.id}" into it?`)) return;
        target = collision.id; // canonical spelling wins, whatever was typed
      } else {
        const near = helpers.nearMissOf(newName, others.map(o=>o.id));
        if(near && confirm(`Did you mean "${near}"? OK = merge into "${near}", Cancel = keep "${newName}".`)){
          target = near;
        } else if(!confirm(`Rename all ${c.items.length} cards from "${c.id}" to "${newName}"?`)){
          return;
        }
      }
      await bulkReassign(c.items.map(m=>m.id), target, c.id);
    }
```

- [ ] **Step 5: Wire the button and hide it for the unassigned pseudo-project**

a. In the wiring block (lines ~250–262), add after the `$('#editSaveBtn').onclick = updateMemory;` line:

```js
    $('#renameProjectBtn').onclick = renameProject;
```

b. In `render()` (line ~142), add before the closing `}` of the function (after the `els.pollState.textContent = …` statement):

```js
      const ac = activeCarousel(); els.renameProjectBtn.style.display = (ac && ac.id!==UNASSIGNED) ? '' : 'none';
```

- [ ] **Step 6: Verify the app end-to-end against a scratch store**

1. `npm run build` (bridge imports build/core modules).
2. Create a scratch store dir and run a scratch bridge (do NOT touch the real one on 3737):
   `ND_MEM_BRIDGE_PORT=3799 ND_MEM_FILE="$TEMP/ndm-ui-test/memories.json" NEURODIVERGENT_MEMORY_DIR="$TEMP/ndm-ui-test" NEURODIVERGENT_MEMORY_DAEMON_PORT=3899 node scripts/nd-mem-bridge-server.mjs`
   (PowerShell: set the four `$env:` vars first, then run the node command.)

   NOTE: the module loader in the HTML hardcodes port 3737, so for this scratch check either temporarily set `BRIDGE` handling aside and test helpers-dependent paths on the real bridge later, or verify at `http://localhost:3799/` that (a) the button renders and hides on `(no project)`, and (b) clicking rename with the bridge-down helper guard shows the toast — then do the full merge check on the real bridge (step 3 below) where the helpers load.
3. On the REAL bridge (port 3737, after the user's rollout or with their OK): open `http://localhost:3737/`, create two throwaway memories under project `merge-smoke-a`, rename `merge-smoke-a` → `merge-smoke-b`, confirm, and verify both cards moved and kept their content/tags. Clean up the throwaway cards via the app if desired.
4. Confirm the suite has no new failures: `npm test` (baseline: 2 pre-existing template-drift failures).

- [ ] **Step 7: Commit**

```bash
git add scripts/nd-mem-mcp-app-bridge.html test/bridge-project-reassign.test.mjs
git commit -m "feat: project rename with merge-on-collision and near-miss guard in web app"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** UX flow cases 1–3 → Task 3 Step 4 (`renameProject`); normalization + near-miss → Task 1; execution loop with pre-snapshotted ids, progress toast, disabled buttons → Task 3 Step 4 (`bulkReassign` receives `c.items.map(m=>m.id)` captured before the first write); stop-on-first-failure + resumable → `bulkReassign`'s early return; unassigned hidden → Task 3 Step 5b; bridge static route → Task 2; bridge-level `/update` partial-field test → Task 3 Step 1; unit tests for helpers → Task 1; manual verification → Task 3 Step 6.
- **Deviation from spec, intentional:** the spec's Testing section implies the reassignment test proves *new* behavior; it actually pins *existing* `/update` behavior as the loop's contract, so Task 3 Step 2 expects PASS on first run (documented in-step so nobody "fixes" a passing test).
- **file:// context:** the user opens the HTML directly from disk as well as via the bridge; the absolute-URL module import plus `window.ndMemHelpers` guard handles both (Global Constraints + Task 3 Step 3b).
- **Type consistency:** `normalizeProjectId`/`nearMissOf`/`levenshtein` names identical across Tasks 1–3; `startBridge` helper exported from the Task 2 test file and reused in Task 3's test.
