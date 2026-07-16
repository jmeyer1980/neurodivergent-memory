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
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon not healthy on ${port} within ${timeoutMs}ms`);
}

function initializeBody(clientName = "test-agent") {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  };
}

async function postMcp(port, body, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), json: text ? JSON.parse(text) : undefined };
}

async function withDaemon(envOverrides, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-session-test-"));
  const daemonPort = await getFreePort();
  const memoryFile = path.join(tempDir, "memories.json");
  const daemon = spawn(process.execPath, [path.join(process.cwd(), "build", "index.js"), "--daemon"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_MODE: "daemon",
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
      NEURODIVERGENT_MEMORY_FILE: memoryFile,
      ...envOverrides,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  daemon.stderr.on("data", (c) => { stderr += c.toString(); });
  try {
    await waitForHealth(daemonPort);
    await fn(daemonPort, () => stderr);
  } finally {
    daemon.kill();
  }
}

test("initialize with no session header mints a fresh session id each time", async () => {
  await withDaemon({}, async (port) => {
    const first = await postMcp(port, initializeBody());
    const second = await postMcp(port, initializeBody());
    assert.ok(first.sessionId, "first initialize returns a session id");
    assert.ok(second.sessionId, "second initialize returns a session id");
    assert.notEqual(first.sessionId, second.sessionId, "each initialize mints an independent session");
  });
});

test("a session persists across sequential requests carrying the same Mcp-Session-Id", async () => {
  await withDaemon({}, async (port) => {
    const init = await postMcp(port, initializeBody());
    const call1 = await postMcp(port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "storage_diagnostics", arguments: {} } }, init.sessionId);
    const call2 = await postMcp(port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "storage_diagnostics", arguments: {} } }, init.sessionId);
    assert.equal(call1.status, 200);
    assert.equal(call2.status, 200);
    assert.ok(!call1.json.error, `call1 unexpectedly errored: ${JSON.stringify(call1.json)}`);
    assert.ok(!call2.json.error, `call2 unexpectedly errored: ${JSON.stringify(call2.json)}`);
  });
});

test("a request with an unknown session id is rejected instead of silently starting a new session", async () => {
  await withDaemon({}, async (port) => {
    const res = await postMcp(port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "storage_diagnostics", arguments: {} } }, "not-a-real-session-id");
    assert.equal(res.status, 404);
  });
});

test("an idle session is swept and its resources freed after the configured timeout", async () => {
  await withDaemon({ NEURODIVERGENT_MEMORY_SESSION_IDLE_MS: "200" }, async (port) => {
    const init = await postMcp(port, initializeBody());
    await new Promise((r) => setTimeout(r, 600));
    const afterIdle = await postMcp(port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "storage_diagnostics", arguments: {} } }, init.sessionId);
    assert.equal(afterIdle.status, 404, "swept session should no longer be found");
  });
});

test("a bare tools/call with no initialize and no session header still works (stateless fallback for non-handshaking callers like the bridge)", async () => {
  await withDaemon({}, async (port) => {
    const res = await postMcp(port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "storage_diagnostics", arguments: {} } });
    assert.equal(res.status, 200);
    assert.ok(!res.json.error, `unexpected error: ${JSON.stringify(res.json)}`);
    assert.equal(res.sessionId, null, "a stateless fallback call must not mint or return a session id");
  });
});

test("malformed JSON on /mcp returns 400 with Parse error code -32700, not 500", async () => {
  await withDaemon({}, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-03-26",
      },
      body: "not valid json at all",
    });
    const json = await res.json();
    assert.equal(res.status, 400, "malformed JSON should return 400, not 500");
    assert.equal(json.error.code, -32700, "error code should be -32700 (Parse error)");
    assert.match(json.error.message, /Invalid JSON/, "error message should mention Invalid JSON");
  });
});
