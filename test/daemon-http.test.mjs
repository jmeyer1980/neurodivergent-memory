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

async function waitForHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon not healthy on ${port} within ${timeoutMs}ms`);
}

function postMcp(port, message) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify(message),
  }).then((r) => r.json());
}

test("daemon serves health and stateless tools/call, and persists writes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-daemon-test-"));
  const port = await getFreePort();
  const child = spawn(process.execPath, ["build/index.js", "--daemon"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString(); });

  try {
    const health = await waitForHealth(port);
    assert.equal(health.ok, true);
    assert.equal(health.pid, child.pid);
    assert.equal(health.mode, "daemon");
    assert.ok(health.memoryPath.startsWith(tempDir));

    const listed = await postMcp(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.ok(Array.isArray(listed.result.tools) && listed.result.tools.length > 0, `tools/list failed: ${JSON.stringify(listed)}\nstderr: ${stderr}`);

    const stored = await postMcp(port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "store_memory", arguments: { content: "daemon-http-test memory", district: "practical_execution", tags: ["test"] } },
    });
    assert.equal(stored.error, undefined, `store failed: ${JSON.stringify(stored)}`);

    // The daemon debounces saves by ~100ms; poll the snapshot.
    const snapshotPath = path.join(tempDir, "memories.json");
    const deadline = Date.now() + 5000;
    let persisted = false;
    while (Date.now() < deadline && !persisted) {
      if (fs.existsSync(snapshotPath) && fs.readFileSync(snapshotPath, "utf8").includes("daemon-http-test memory")) persisted = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(persisted, "stored memory reached memories.json");

    // Unknown routes 404
    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(notFound.status, 404);
  } finally {
    child.kill();
  }
});

test("second daemon on same port exits 0 without touching the store", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-daemon-singleton-"));
  const port = await getFreePort();
  const env = {
    ...process.env,
    NEURODIVERGENT_MEMORY_DIR: tempDir,
    NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
  };
  const first = spawn(process.execPath, ["build/index.js", "--daemon"], { cwd: process.cwd(), env, stdio: "ignore" });
  try {
    await waitForHealth(port);
    const second = spawn(process.execPath, ["build/index.js", "--daemon"], { cwd: process.cwd(), env, stdio: "ignore" });
    const exitCode = await new Promise((resolve) => second.on("exit", resolve));
    assert.equal(exitCode, 0);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.pid, first.pid, "first daemon still owns the port");
  } finally {
    first.kill();
  }
});
