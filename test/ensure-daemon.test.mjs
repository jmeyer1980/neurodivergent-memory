import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";

import { checkDaemonHealth, ensureDaemon } from "../build/core/ensure-daemon.js";

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

test("checkDaemonHealth returns null when nothing is listening", async () => {
  const port = await getFreePort();
  assert.equal(await checkDaemonHealth(port, 300), null);
});

test("ensureDaemon reuses an already-healthy daemon without spawning", async () => {
  const port = await getFreePort();
  // Fake daemon: any /health response with ok:true counts.
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: 424242, mode: "daemon" }));
  });
  await new Promise((r) => fake.listen(port, "127.0.0.1", r));
  try {
    const health = await ensureDaemon({
      port,
      entryPath: path.join(process.cwd(), "build", "index.js"),
      logFile: path.join(os.tmpdir(), "ndm-ensure-noop.log"),
    });
    assert.equal(health.pid, 424242, "must not have spawned a real daemon");
  } finally {
    fake.close();
  }
});

test("ensureDaemon spawns a real daemon when none is running", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-ensure-spawn-"));
  const port = await getFreePort();
  const logFile = path.join(tempDir, "daemon.log");
  const health = await ensureDaemon({
    port,
    entryPath: path.join(process.cwd(), "build", "index.js"),
    logFile,
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
    },
    timeoutMs: 10000,
  });
  try {
    assert.equal(health.ok, true);
    assert.equal(typeof health.pid, "number");
    assert.equal(health.mode, "daemon");
  } finally {
    if (health.pid) process.kill(health.pid);
  }
});

test("ensureDaemon throws a clear error when the entry path is broken", async () => {
  const port = await getFreePort();
  await assert.rejects(
    ensureDaemon({
      port,
      entryPath: path.join(os.tmpdir(), "does-not-exist.js"),
      logFile: path.join(os.tmpdir(), "ndm-ensure-broken.log"),
      timeoutMs: 1500,
    }),
    /did not become healthy/,
  );
});
