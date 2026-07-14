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
