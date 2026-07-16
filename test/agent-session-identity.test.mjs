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

async function initSession(port, clientName) {
  const res = await postMcp(port, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } },
  });
  return res.sessionId;
}

function toolCall(id, name, args) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function withDaemon(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-identity-test-"));
  const daemonPort = await getFreePort();
  const memoryFile = path.join(tempDir, "memories.json");
  const daemon = spawn(process.execPath, [path.join(process.cwd(), "build", "index.js"), "--daemon"], {
    cwd: process.cwd(),
    env: { ...process.env, NEURODIVERGENT_MEMORY_MODE: "daemon", NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort), NEURODIVERGENT_MEMORY_FILE: memoryFile },
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

test("store_memory with no agent_id inherits the session's clientInfo.name", async () => {
  await withDaemon(async (port) => {
    const sessionId = await initSession(port, "test-agent-alpha");
    const res = await postMcp(port, toolCall(2, "store_memory", { content: "identity inheritance test alpha" }), sessionId);
    const text = res.json.result.content[0].text;
    assert.match(text, /Agent: test-agent-alpha/);
  });
});

test("two concurrent sessions with different clientInfo.name do not clobber each other's identity", async () => {
  await withDaemon(async (port) => {
    const sessionA = await initSession(port, "agent-a");
    const sessionB = await initSession(port, "agent-b");
    // Interleave: B's call happens between A's two calls.
    const a1 = await postMcp(port, toolCall(2, "store_memory", { content: "concurrent identity test A1" }), sessionA);
    const b1 = await postMcp(port, toolCall(2, "store_memory", { content: "concurrent identity test B1" }), sessionB);
    const a2 = await postMcp(port, toolCall(3, "store_memory", { content: "concurrent identity test A2" }), sessionA);
    assert.match(a1.json.result.content[0].text, /Agent: agent-a/);
    assert.match(b1.json.result.content[0].text, /Agent: agent-b/);
    assert.match(a2.json.result.content[0].text, /Agent: agent-a/, "session A must still resolve to agent-a after B's interleaved call");
  });
});

test("an explicit agent_id argument still overrides the session's bound identity", async () => {
  await withDaemon(async (port) => {
    const sessionId = await initSession(port, "test-agent-alpha");
    const res = await postMcp(port, toolCall(2, "store_memory", { content: "explicit override test", agent_id: "explicit-override" }), sessionId);
    assert.match(res.json.result.content[0].text, /Agent: explicit-override/);
  });
});

test("server_handshake with an agent_id argument overrides the auto-bound identity for the rest of the session", async () => {
  await withDaemon(async (port) => {
    const sessionId = await initSession(port, "test-agent-alpha");
    const handshake = await postMcp(port, toolCall(2, "server_handshake", { agent_id: "handshake-override" }), sessionId);
    assert.match(handshake.json.result.content[0].text, /agent_id=handshake-override/);
    const stored = await postMcp(port, toolCall(3, "store_memory", { content: "post-handshake-override test" }), sessionId);
    assert.match(stored.json.result.content[0].text, /Agent: handshake-override/);
  });
});

test("server_handshake reports no active session when clientInfo carried no name", async () => {
  await withDaemon(async (port) => {
    const initRes = await postMcp(port, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "", version: "1.0.0" } },
    });
    const handshake = await postMcp(port, toolCall(2, "server_handshake", {}), initRes.sessionId);
    assert.match(handshake.json.result.content[0].text, /Active session: none/);
  });
});

test("update_memory's memory_agent_id repair field never auto-fills from a different session's bound identity", async () => {
  await withDaemon(async (port) => {
    // Session with no bound identity (empty clientInfo.name) — the resulting memory lands unassigned.
    const unboundInit = await postMcp(port, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "", version: "1.0.0" } },
    });
    const stored = await postMcp(port, toolCall(2, "store_memory", { content: "memory_agent_id regression guard test" }), unboundInit.sessionId);
    const idMatch = stored.json.result.content[0].text.match(/ID: (memory_\d+)/);
    assert.ok(idMatch, "expected a memory id in the store_memory response");
    assert.match(stored.json.result.content[0].text, /Agent: unassigned/, "precondition: memory must start unassigned for this test to mean anything");

    // A DIFFERENT session, bound to a different identity, updates the memory without memory_agent_id.
    const boundSessionId = await initSession(port, "different-session-identity");
    const updated = await postMcp(port, toolCall(3, "update_memory", { memory_id: idMatch[1], content: "updated content, no memory_agent_id" }), boundSessionId);
    assert.match(updated.json.result.content[0].text, /Agent: unassigned/, "authorship must stay unassigned — memory_agent_id was never passed, so the session's bound identity must not backfill it");
  });
});
