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
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} not ready in ${timeoutMs}ms`);
}

test("bridge /save routes through the daemon (no child MCP process) and persists", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-bridge-test-"));
  const bridgePort = await getFreePort();
  const daemonPort = await getFreePort();
  const memoryFile = path.join(tempDir, "memories.json");

  const bridge = spawn(process.execPath, ["scripts/nd-mem-bridge-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ND_MEM_BRIDGE_PORT: String(bridgePort),
      ND_MEM_FILE: memoryFile,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  bridge.stderr.on("data", (c) => { stderr += c.toString(); });
  let daemonPid;

  try {
    await waitFor(`http://127.0.0.1:${bridgePort}/health`);

    const saved = await fetch(`http://127.0.0.1:${bridgePort}/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "bridge-daemon test memory", district: "practical_execution", tags: ["test"] }),
    }).then((r) => r.json());
    assert.equal(saved.ok, true, `save failed: ${JSON.stringify(saved)}\n${stderr}`);
    assert.equal(saved.routedTo, "daemon-http");

    const health = await waitFor(`http://127.0.0.1:${daemonPort}/health`);
    daemonPid = health.pid;
    assert.notEqual(daemonPid, bridge.pid);

    const deadline = Date.now() + 5000;
    let persisted = false;
    while (Date.now() < deadline && !persisted) {
      if (fs.existsSync(memoryFile) && fs.readFileSync(memoryFile, "utf8").includes("bridge-daemon test memory")) persisted = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(persisted, "bridge save reached memories.json via daemon");
  } finally {
    bridge.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* gone */ } }
  }
});
