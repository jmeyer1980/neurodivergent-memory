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

/** Send JSON-RPC lines to a child's stdin, resolve responses by id. */
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
    request(msg, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for id ${msg.id}`)), timeoutMs);
        pending.set(msg.id, (response) => { clearTimeout(timer); resolve(response); });
        child.stdin.write(JSON.stringify(msg) + "\n");
      });
    },
    notify(msg) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
  };
}

test("default stdio launch is a proxy: forwards tool calls to an auto-started daemon", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-proxy-test-"));
  const port = await getFreePort();
  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
      NEURODIVERGENT_MEMORY_MODE: "", // explicit: default path
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString(); });
  const client = createLineClient(child);
  let daemonPid;

  try {
    const init = await client.request({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proxy-test", version: "0.0.0" } },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init)}\n${stderr}`);
    assert.equal(init.result.serverInfo.name, "neurodivergent-memory");
    client.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const stored = await client.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "store_memory", arguments: { content: "proxy-mode test memory", district: "practical_execution", tags: ["test"] } },
    });
    assert.equal(stored.error, undefined, `store failed: ${JSON.stringify(stored)}\n${stderr}`);

    // A real daemon must now exist and own the store...
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.notEqual(health.pid, child.pid, "proxy must not be the writer");
    daemonPid = health.pid;

    // ...and the write must be in the daemon's snapshot dir.
    const snapshotPath = path.join(tempDir, "memories.json");
    const deadline = Date.now() + 5000;
    let persisted = false;
    while (Date.now() < deadline && !persisted) {
      if (fs.existsSync(snapshotPath) && fs.readFileSync(snapshotPath, "utf8").includes("proxy-mode test memory")) persisted = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(persisted, "proxied store reached memories.json");
  } finally {
    child.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* already gone */ } }
  }
});

test("proxy fails loudly (JSON-RPC error), never becomes a writer, when daemon cannot start", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-proxy-fail-"));
  const port = await getFreePort();
  // Occupy the port with something that is NOT a healthy daemon: /health 500s.
  const net2 = await import("node:http");
  const blocker = net2.createServer((req, res) => { res.writeHead(500); res.end("{}"); });
  await new Promise((r) => blocker.listen(port, "127.0.0.1", r));

  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = createLineClient(child);
  try {
    await client.request({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const result = await client.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "store_memory", arguments: { content: "must not persist", district: "practical_execution" } },
    }, 20000);
    assert.ok(result.error, "tool call must surface a JSON-RPC error");
    assert.match(result.error.message, /daemon/i);
    assert.ok(!fs.existsSync(path.join(tempDir, "memories.json")), "proxy must never write the store itself");
  } finally {
    child.kill();
    blocker.close();
  }
});
