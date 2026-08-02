import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { stopDaemonOnPort } from "../test-support/daemon.mjs";

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
    // Reap AFTER the child dies: a live proxy/bridge respawns a daemon the
    // instant the one it was using disappears.
    await stopDaemonOnPort(daemonPort);
  }
});

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
    // Reap AFTER the child dies: a live proxy/bridge respawns a daemon the
    // instant the one it was using disappears.
    await stopDaemonOnPort(daemonPort);
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* gone */ } }
  }
});

test("POST /update for a nonexistent memory surfaces the daemon's isError result as a failed request", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-soft-error-"));
  const bridgePort = await getFreePort();
  const daemonPort = await getFreePort();
  const bridge = startBridge(tempDir, bridgePort, daemonPort);
  let daemonPid;
  try {
    await waitFor(`http://127.0.0.1:${bridgePort}/health`);

    // The /update call itself triggers ensureDaemon (daemon starts lazily), so
    // issue it before probing the daemon's own health endpoint.
    const res = await fetch(`http://127.0.0.1:${bridgePort}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memoryId: "memory_999999", projectId: "anywhere" }),
    });
    const data = await res.json();
    assert.equal(res.status, 500);
    assert.equal(data.ok, false, JSON.stringify(data));

    daemonPid = (await waitFor(`http://127.0.0.1:${daemonPort}/health`).then((r) => r.json())).pid;
  } finally {
    bridge.kill();
    // Reap AFTER the child dies: a live proxy/bridge respawns a daemon the
    // instant the one it was using disappears.
    await stopDaemonOnPort(daemonPort);
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* gone */ } }
  }
});
