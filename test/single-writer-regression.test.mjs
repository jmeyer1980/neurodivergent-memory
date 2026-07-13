// test/single-writer-regression.test.mjs
// Regression for the 2026-07-13 incident: two concurrent clients (a Claude
// session via stdio proxy + the web-app path via HTTP) must never lose each
// other's writes or collide on memory IDs. Before the single-writer daemon,
// this exact interleaving destroyed two user memories.
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

function createLineClient(child) {
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  return {
    request(msg, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout id ${msg.id}`)), timeoutMs);
        pending.set(msg.id, (r) => { clearTimeout(timer); resolve(r); });
        child.stdin.write(JSON.stringify(msg) + "\n");
      });
    },
    notify(msg) { child.stdin.write(JSON.stringify(msg) + "\n"); },
  };
}

function postMcp(port, message) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify(message),
  }).then((r) => r.json());
}

test("interleaved writes from a proxy session and an HTTP client all survive with unique ids", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-regression-"));
  const port = await getFreePort();
  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, NEURODIVERGENT_MEMORY_DIR: tempDir, NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const proxy = createLineClient(child);
  let daemonPid;
  let httpId = 1000;

  try {
    await proxy.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "session", version: "0" } } });
    proxy.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const storeViaProxy = (n, content) =>
      proxy.request({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "store_memory", arguments: { content, district: "practical_execution" } } });
    const storeViaHttp = (content) =>
      postMcp(port, { jsonrpc: "2.0", id: httpId++, method: "tools/call", params: { name: "store_memory", arguments: { content, district: "creative_synthesis" } } });

    // Ensure daemon is healthy before making HTTP calls to avoid race with proxy warm-start.
    const healthDeadline = Date.now() + 5000;
    while (Date.now() < healthDeadline) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok ? r.json() : null);
        if (health?.ok) break;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Interleave: the incident shape — agent session writing while the app writes.
    const results = await Promise.all([
      storeViaProxy(10, "agent memory alpha"),
      storeViaHttp("app memory one"),
      storeViaProxy(11, "agent memory beta"),
      storeViaHttp("app memory two"),
      storeViaProxy(12, "agent memory gamma"),
    ]);
    for (const r of results) assert.equal(r.error, undefined, JSON.stringify(r));

    daemonPid = (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())).pid;

    // Every write survives in the snapshot; every id is unique; the counter is sane.
    const snapshotPath = path.join(tempDir, "memories.json");
    const expected = ["agent memory alpha", "app memory one", "agent memory beta", "app memory two", "agent memory gamma"];
    const deadline = Date.now() + 5000;
    let snapshot;
    while (Date.now() < deadline) {
      if (fs.existsSync(snapshotPath)) {
        snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        const contents = Object.values(snapshot.memories).map((m) => m.content);
        if (expected.every((e) => contents.some((c) => c.includes(e)))) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const memories = Object.values(snapshot.memories);
    for (const e of expected) {
      assert.ok(memories.some((m) => m.content.includes(e)), `lost write: ${e}`);
    }
    const ids = memories.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, "memory ids must be unique");
    const maxId = Math.max(...ids.map((id) => Number.parseInt(id.replace(/\D/g, ""), 10)));
    assert.ok(snapshot.nextMemoryId > maxId, "nextMemoryId is ahead of every assigned id");
  } finally {
    child.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* gone */ } }
  }
});
