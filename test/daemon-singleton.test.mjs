// test/daemon-singleton.test.mjs
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

function rpcOverStdio(child, messages, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const responses = [];
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("stdio rpc timeout")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        responses.push(JSON.parse(line));
        if (responses.length === messages.filter((m) => m.id !== undefined).length) {
          clearTimeout(timer);
          resolve(responses);
        }
      }
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("three proxies racing from cold start produce exactly one daemon and lose no writes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-race-"));
  const port = await getFreePort();
  const env = {
    ...process.env,
    NEURODIVERGENT_MEMORY_DIR: tempDir,
    NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
  };
  const proxies = [0, 1, 2].map(() =>
    spawn(process.execPath, ["build/index.js"], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "ignore"] }),
  );
  let daemonPid;
  try {
    const results = await Promise.all(
      proxies.map((child, i) =>
        rpcOverStdio(child, [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: `race-${i}`, version: "0" } } },
          { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "store_memory", arguments: { content: `race memory from proxy ${i}`, district: "practical_execution" } } },
        ]),
      ),
    );
    for (const responses of results) {
      const toolResponse = responses.find((r) => r.id === 2);
      assert.equal(toolResponse.error, undefined, JSON.stringify(toolResponse));
    }

    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    daemonPid = health.pid;

    // All three writes survived in one snapshot — the incident scenario, killed.
    const deadline = Date.now() + 5000;
    let snapshot = "";
    while (Date.now() < deadline) {
      const p = path.join(tempDir, "memories.json");
      snapshot = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      if (["race memory from proxy 0", "race memory from proxy 1", "race memory from proxy 2"].every((s) => snapshot.includes(s))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const i of [0, 1, 2]) {
      assert.ok(snapshot.includes(`race memory from proxy ${i}`), `write from proxy ${i} survived`);
    }
  } finally {
    // Proxies first: a live proxy respawns a daemon the instant the one it was
    // using disappears. Then ask the port who is actually there now, rather
    // than killing the pid captured mid-test -- that one can be stale, and the
    // survivor is what leaks.
    for (const p of proxies) p.kill();
    await stopDaemonOnPort(port);
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* already gone */ } }
  }
});
