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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-session-end-test-"));
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

test("a store_memory write tagged kind:handoff clears the session's bound identity", async () => {
  await withDaemon(async (port) => {
    const sessionId = await initSession(port, "handoff-test-agent");
    const handoff = await postMcp(port, toolCall(2, "store_memory", { content: "session handoff test", tags: ["kind:handoff"] }), sessionId);
    assert.match(handoff.json.result.content[0].text, /Session identity cleared \(handoff tag detected\)/);
    const after = await postMcp(port, toolCall(3, "store_memory", { content: "after handoff, no explicit agent_id" }), sessionId);
    assert.match(after.json.result.content[0].text, /Agent: unassigned/, "identity should be cleared, not still bound to handoff-test-agent");
  });
});

test("closing a task clears the session's bound identity", async () => {
  await withDaemon(async (port) => {
    const sessionId = await initSession(port, "close-task-test-agent");
    const stored = await postMcp(port, toolCall(2, "store_memory", { content: "task to close", tags: ["kind:task"] }), sessionId);
    const idMatch = stored.json.result.content[0].text.match(/ID: (memory_\d+)/);
    assert.ok(idMatch, "expected a memory id in the store_memory response");
    const memoryId = idMatch[1];
    // close_task gates on the publication_state lifecycle field (draft -> ... -> closable -> closed),
    // not the kanban "status" field store_memory accepts, so fast-track it to "closable" via update_memory.
    const madeClosable = await postMcp(port, toolCall(3, "update_memory", { memory_id: memoryId, publication_state: "closable" }), sessionId);
    assert.ok(!madeClosable.json.result.isError, "expected update_memory to succeed in setting publication_state to closable");
    const closed = await postMcp(port, toolCall(4, "close_task", { memory_id: memoryId }), sessionId);
    assert.match(closed.json.result.content[0].text, /Session identity cleared \(close_task\)/);
    const after = await postMcp(port, toolCall(5, "store_memory", { content: "after close_task, no explicit agent_id" }), sessionId);
    assert.match(after.json.result.content[0].text, /Agent: unassigned/);
  });
});
