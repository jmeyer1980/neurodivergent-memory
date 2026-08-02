import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
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

async function waitForHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon not healthy on ${port} within ${timeoutMs}ms`);
}

test("stdio-proxy forwards initialize to the daemon and reuses the returned session for later calls", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-proxy-session-test-"));
  const daemonPort = await getFreePort();
  const memoryFile = path.join(tempDir, "memories.json");

  const proxy = spawn(process.execPath, [path.join(process.cwd(), "build", "index.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_MODE: "proxy",
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
      NEURODIVERGENT_MEMORY_FILE: memoryFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  proxy.stderr.on("data", (c) => { stderr += c.toString(); });

  const rl = readline.createInterface({ input: proxy.stdout });
  const pending = new Map();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore non-JSON noise */ }
  });

  function send(id, method, params) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  try {
    const initResult = await send(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "proxy-test-agent", version: "1.0.0" },
    });
    assert.ok(initResult.result, `initialize failed: ${JSON.stringify(initResult)}\n${stderr}`);

    const storeResult = await send(2, "tools/call", { name: "store_memory", arguments: { content: "stdio proxy session identity test" } });
    assert.ok(!storeResult.error, `store_memory failed: ${JSON.stringify(storeResult)}\n${stderr}`);
    const text = storeResult.result.content[0].text;
    assert.match(text, /Agent: proxy-test-agent/, "identity should flow from clientInfo through the proxy to the daemon");
  } finally {
    proxy.kill();
    // Reap AFTER the child dies: a live proxy/bridge respawns a daemon the
    // instant the one it was using disappears.
    await stopDaemonOnPort(daemonPort);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stdio-proxy recovers from an expired session: retries once with no session header instead of wedging on a null-id response", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-proxy-expiry-test-"));
  const daemonPort = await getFreePort();
  const memoryFile = path.join(tempDir, "memories.json");

  // Spawn the daemon directly (not via the proxy's warm-start) so we can force
  // a very short idle timeout — this is what makes the session expire quickly.
  const daemon = spawn(process.execPath, [path.join(process.cwd(), "build", "index.js"), "--daemon"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_MODE: "daemon",
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
      NEURODIVERGENT_MEMORY_FILE: memoryFile,
      NEURODIVERGENT_MEMORY_SESSION_IDLE_MS: "200",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let daemonStderr = "";
  daemon.stderr.on("data", (c) => { daemonStderr += c.toString(); });

  let proxy;
  try {
    await waitForHealth(daemonPort);

    // Point the proxy at the already-running daemon so its warm-start finds
    // it healthy and never spawns a second one.
    proxy = spawn(process.execPath, [path.join(process.cwd(), "build", "index.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEURODIVERGENT_MEMORY_MODE: "proxy",
        NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
        NEURODIVERGENT_MEMORY_FILE: memoryFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let proxyStderr = "";
    proxy.stderr.on("data", (c) => { proxyStderr += c.toString(); });

    const rl = readline.createInterface({ input: proxy.stdout });
    const pending = new Map();
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* ignore non-JSON noise */ }
    });

    function send(id, method, params) {
      return new Promise((resolve) => {
        pending.set(id, resolve);
        proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    const initResult = await send(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "expiry-test-agent", version: "1.0.0" },
    });
    assert.ok(initResult.result, `initialize failed: ${JSON.stringify(initResult)}\n${proxyStderr}\n${daemonStderr}`);

    // Let the session go idle past the 200ms sweep window so the daemon
    // forgets it — the proxy still remembers the now-dead session id.
    await new Promise((r) => setTimeout(r, 600));

    // This must resolve at all (not hang) — a `null`-id response from the
    // daemon's 404 would never match a pending-request lookup, so the promise
    // resolving is itself proof the retry-with-no-session-header path fired.
    const storeResult = await send(2, "tools/call", { name: "store_memory", arguments: { content: "post-expiry store, no explicit agent_id" } });
    assert.ok(!storeResult.error, `store_memory failed: ${JSON.stringify(storeResult)}\n${proxyStderr}\n${daemonStderr}`);
    const text = storeResult.result.content[0].text;
    assert.match(text, /Agent: unassigned/, "retry must fall through to the stateless path, not somehow reuse the dead session's identity");
  } finally {
    if (proxy) proxy.kill();
    await stopDaemonOnPort(daemonPort);
    daemon.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
