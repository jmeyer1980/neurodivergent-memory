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

    // A write BEFORE the sweep, to capture the session id that is about to die.
    const beforeResult = await send(2, "tools/call", { name: "store_memory", arguments: { content: "pre-expiry store, no explicit agent_id" } });
    assert.ok(!beforeResult.error, `pre-expiry store_memory failed: ${JSON.stringify(beforeResult)}\n${proxyStderr}\n${daemonStderr}`);
    const beforeText = beforeResult.result.content[0].text;
    assert.match(beforeText, /Agent: expiry-test-agent/, "precondition: the live session binds the client's identity");
    const deadSessionId = (beforeText.match(/Session: (\S+)/) ?? [])[1];
    assert.ok(deadSessionId, `precondition: a session id was reported\n${beforeText}`);

    // Let the session go idle past the 200ms sweep window so the daemon
    // forgets it — the proxy still remembers the now-dead session id.
    await new Promise((r) => setTimeout(r, 600));

    // This must resolve at all (not hang) — a `null`-id response from the
    // daemon's 404 would never match a pending-request lookup, so the promise
    // resolving is itself proof the recovery path fired.
    const storeResult = await send(3, "tools/call", { name: "store_memory", arguments: { content: "post-expiry store, no explicit agent_id" } });
    assert.ok(!storeResult.error, `store_memory failed: ${JSON.stringify(storeResult)}\n${proxyStderr}\n${daemonStderr}`);
    const text = storeResult.result.content[0].text;

    // This assertion was inverted deliberately. It used to require
    // `Agent: unassigned`, on the reasoning that the retry "must fall through
    // to the stateless path, not somehow reuse the dead session's identity" --
    // but that encoded a real defect as the contract: because the stateless
    // path mints no session id, the proxy stayed sessionless for the REST OF
    // THE PROCESS, so every later write in a long-lived client silently lost
    // its identity. The design intent is that callers omit agent_id and rely
    // on session binding, so losing the session lost the attribution entirely.
    //
    // The original concern still holds and is now asserted directly: the dead
    // session must NOT be reused. The proxy instead replays the client's own
    // initialize to mint a FRESH session, which legitimately re-binds the same
    // client -- so the identity returns while the session id differs.
    assert.match(text, /Agent: expiry-test-agent/, "the proxy must re-establish the session, not degrade to unattributed writes");
    const newSessionId = (text.match(/Session: (\S+)/) ?? [])[1];
    assert.ok(newSessionId, `a session id was reported after recovery\n${text}`);
    assert.notEqual(newSessionId, deadSessionId, "recovery must mint a NEW session, never resurrect the swept one");

    // And it must persist: the whole point is that the next call does not have
    // to rediscover this. A one-call fix would leave the process degraded again.
    const thirdResult = await send(4, "tools/call", { name: "store_memory", arguments: { content: "third store, still attributed" } });
    assert.ok(!thirdResult.error, `third store_memory failed: ${JSON.stringify(thirdResult)}`);
    assert.match(thirdResult.result.content[0].text, /Agent: expiry-test-agent/, "the re-established session must survive beyond the call that created it");
  } finally {
    if (proxy) proxy.kill();
    await stopDaemonOnPort(daemonPort);
    daemon.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
