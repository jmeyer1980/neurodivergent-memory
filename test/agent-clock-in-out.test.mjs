import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

// Issue #141. Auto-binding from clientInfo.name covers the common case, but an
// agent cannot DECLARE an identity with it: the name is whatever the client
// program calls itself, so several agents behind one client are
// indistinguishable, and handing a session from one role to another mid-run
// means reconnecting. These two tools are the explicit override.

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

const textOf = (res) => (res.json?.result?.content ?? []).map((c) => c?.text).filter(Boolean).join("\n");

async function withDaemon(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-clock-test-"));
  const daemonPort = await getFreePort();
  const memoryFile = path.join(tempDir, "memories.json");
  const daemon = spawn(process.execPath, [path.join(process.cwd(), "build", "index.js"), "--daemon"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_MODE: "daemon",
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
      NEURODIVERGENT_MEMORY_FILE: memoryFile,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  daemon.stderr.on("data", (c) => { stderr += c.toString(); });
  try {
    await waitForHealth(daemonPort);
    await fn(daemonPort, () => stderr, memoryFile);
  } finally {
    daemon.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --- discoverability ------------------------------------------------------

test("both tools are advertised, or an agent cannot find them", async () => {
  // The whole point is an agent reaching for these deliberately. A tool the
  // catalog does not list is a tool that does not exist, from the caller's side.
  await withDaemon(async (port) => {
    const session = await initSession(port, "catalog-probe");
    const listed = await postMcp(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);
    const names = (listed.json?.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("agent_clock_in"), `agent_clock_in missing from tools/list: ${names.join(", ")}`);
    assert.ok(names.includes("agent_clock_out"), `agent_clock_out missing from tools/list: ${names.join(", ")}`);

    const mirrored = await postMcp(port, toolCall(3, "list_tools", {}), session);
    const mirrorNames = JSON.parse(textOf(mirrored)).tools.map((t) => t.name);
    assert.ok(mirrorNames.includes("agent_clock_in"), "agent_clock_in missing from the list_tools mirror");
    assert.ok(mirrorNames.includes("agent_clock_out"), "agent_clock_out missing from the list_tools mirror");
  });
});

// --- clock in -------------------------------------------------------------

test("clocking in binds an identity that later writes inherit", async () => {
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "reviewer-agent" }), session);

    const stored = await postMcp(port, toolCall(3, "store_memory", { content: "written while clocked in" }), session);
    assert.match(textOf(stored), /reviewer-agent/, `write did not inherit the clocked-in identity:\n${textOf(stored)}`);
  });
});

test("clocking in overrides the identity auto-bound from clientInfo.name", async () => {
  // The case auto-binding cannot serve: several agents behind one client
  // program, which reports a single clientInfo.name for all of them.
  await withDaemon(async (port) => {
    const session = await initSession(port, "claude-code");
    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "risk-reviewer" }), session);

    const stored = await postMcp(port, toolCall(3, "store_memory", { content: "second agent behind one client" }), session);
    const text = textOf(stored);
    assert.match(text, /risk-reviewer/, `override did not take:\n${text}`);
    assert.doesNotMatch(text, /claude-code/, `the auto-bound identity survived the override:\n${text}`);
  });
});

test("the handshake reports a clocked-in identity, and says it came from a clock-in", async () => {
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "architecture-reviewer" }), session);

    const shook = textOf(await postMcp(port, toolCall(3, "server_handshake", {}), session));
    assert.match(shook, /architecture-reviewer/, `handshake did not report the identity:\n${shook}`);
    // Distinguishing a deliberate clock-in from an auto-bind is the point of
    // having the tool at all — otherwise the handshake cannot tell a caller
    // whether anyone actually declared this identity.
    assert.match(shook, /clock_in/, `handshake did not attribute the bind to a clock-in:\n${shook}`);
  });
});

test("clocking in accepts an explicit session_id", async () => {
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "a", session_id: "task-42" }), session);
    const shook = textOf(await postMcp(port, toolCall(3, "server_handshake", {}), session));
    assert.match(shook, /task-42/, `explicit session_id was ignored:\n${shook}`);
  });
});

// `store_memory` normalizes session_id FIRST (NFKC, trim, lower-case), rejects
// what normalizes to empty, and validates the normalized value. Clock-in has to
// match that flow exactly, or the same string is accepted by one tool and
// refused by the other — and a session_id that means one thing on write means
// another on the identity that produced the write.

test("clocking in normalizes session_id the way store_memory does", async () => {
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    // Validating BEFORE normalizing rejects this: the raw string fails the
    // pattern on its leading space, though it trims to a perfectly good id.
    const res = await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "a", session_id: "  Task-42  " }), session);
    assert.equal(res.json?.error, undefined, `rejected a session_id that normalizes cleanly:\n${JSON.stringify(res.json)}`);
    assert.notEqual(res.json?.result?.isError, true, `rejected a session_id that normalizes cleanly:\n${textOf(res)}`);

    const shook = textOf(await postMcp(port, toolCall(3, "server_handshake", {}), session));
    assert.match(shook, /session_id=task-42\b/, `session_id was not normalized to canonical form:\n${shook}`);
  });
});

test("clocking in refuses a session_id that cannot normalize", async () => {
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    for (const bad of [null, "   ", " ", "not a valid id!", "-leading-dash"]) {
      const res = await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "a", session_id: bad }), session);
      const errored = Boolean(res.json?.error) || res.json?.result?.isError === true;
      // Silently treating a bad session_id as "not provided" would bind the
      // identity to a DIFFERENT session than the caller asked for, and say
      // nothing — the caller's write then files under an id they never chose.
      assert.ok(errored, `accepted session_id ${JSON.stringify(bad)}: ${JSON.stringify(res.json)}`);
    }
  });
});

test("clocking in without an agent_id is refused", async () => {
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    for (const args of [{}, { agent_id: "" }, { agent_id: "   " }, { agent_id: 7 }]) {
      const res = await postMcp(port, toolCall(2, "agent_clock_in", args), session);
      const isError = res.json?.result?.isError === true || Boolean(res.json?.error);
      assert.ok(isError, `clock-in accepted ${JSON.stringify(args)}: ${JSON.stringify(res.json)}`);
    }
  });
});

// --- clock out ------------------------------------------------------------

test("clocking out drops the identity, and later writes fall back to unassigned", async () => {
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "temp-agent" }), session);
    await postMcp(port, toolCall(3, "agent_clock_out", {}), session);

    const stored = await postMcp(port, toolCall(4, "store_memory", { content: "written after clocking out" }), session);
    const text = textOf(stored);
    assert.doesNotMatch(text, /temp-agent/, `the identity survived clock-out:\n${text}`);
    assert.match(text, /unassigned/, `did not fall back to the unassigned default:\n${text}`);
  });
});

test("clocking out twice is a stable no-op, not an error", async () => {
  // An agent that cannot tell whether it is clocked in must be able to just
  // call this. Idempotence is what makes it safe in a finally block.
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "temp-agent" }), session);
    const first = await postMcp(port, toolCall(3, "agent_clock_out", {}), session);
    const second = await postMcp(port, toolCall(4, "agent_clock_out", {}), session);

    assert.notEqual(first.json?.result?.isError, true, `first clock-out errored:\n${textOf(first)}`);
    assert.notEqual(second.json?.result?.isError, true, `second clock-out errored:\n${textOf(second)}`);
    assert.match(textOf(second), /alread(y|ies)|no active|not clocked/i,
      `a repeat clock-out should say plainly that nothing was bound:\n${textOf(second)}`);
  });
});

test("clocking out with nothing bound is safe", async () => {
  await withDaemon(async (port) => {
    const session = await initSession(port, "");
    const res = await postMcp(port, toolCall(2, "agent_clock_out", {}), session);
    // BOTH error channels: a thrown NMError surfaces as a JSON-RPC `error`,
    // not as `result.isError`, so checking only the latter let a mutation that
    // made this throw sail straight through.
    assert.equal(res.json?.error, undefined, `errored on a cold clock-out:\n${JSON.stringify(res.json)}`);
    assert.notEqual(res.json?.result?.isError, true, `errored on a cold clock-out:\n${textOf(res)}`);
    assert.match(textOf(res), /alread(y|ies)|no active|not clocked/i,
      `a cold clock-out should say plainly that nothing was bound:\n${textOf(res)}`);
  });
});

// --- isolation ------------------------------------------------------------

test("one session's clock-in cannot reach another session", async () => {
  // The regression that matters most: identity lives in a WeakMap keyed by the
  // per-session Server, and a process-global would silently cross-attribute
  // every concurrent agent's writes.
  await withDaemon(async (port) => {
    const a = await initSession(port, "client-a");
    const b = await initSession(port, "client-b");

    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "agent-one" }), a);
    await postMcp(port, toolCall(3, "agent_clock_in", { agent_id: "agent-two" }), b);

    const fromA = textOf(await postMcp(port, toolCall(4, "store_memory", { content: "from a" }), a));
    const fromB = textOf(await postMcp(port, toolCall(5, "store_memory", { content: "from b" }), b));

    assert.match(fromA, /agent-one/, `session A wrote as the wrong agent:\n${fromA}`);
    assert.match(fromB, /agent-two/, `session B wrote as the wrong agent:\n${fromB}`);
  });
});

test("clocking out of one session leaves the other clocked in", async () => {
  await withDaemon(async (port) => {
    const a = await initSession(port, "client-a");
    const b = await initSession(port, "client-b");
    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "agent-one" }), a);
    await postMcp(port, toolCall(3, "agent_clock_in", { agent_id: "agent-two" }), b);

    await postMcp(port, toolCall(4, "agent_clock_out", {}), a);

    const fromB = textOf(await postMcp(port, toolCall(5, "store_memory", { content: "b still working" }), b));
    assert.match(fromB, /agent-two/, `clocking out of A also cleared B:\n${fromB}`);
  });
});

// --- interaction with the existing auto-clock-out triggers ----------------

test("a kind:handoff write still clears an identity that was clocked in explicitly", async () => {
  // The existing triggers (#145/#146) must not become blind to identities that
  // arrived through the new door — otherwise an explicit clock-in would leak
  // past the end of the task it belonged to.
  await withDaemon(async (port) => {
    const session = await initSession(port, "some-client");
    await postMcp(port, toolCall(2, "agent_clock_in", { agent_id: "handoff-agent" }), session);

    // Prove the clock-in took BEFORE testing that the handoff undoes it.
    // Without this the test passes even when agent_clock_in does not exist:
    // clientInfo.name auto-binds something, the handoff clears that instead,
    // and every later assertion still reads exactly the same.
    const before = textOf(await postMcp(port, toolCall(3, "store_memory", { content: "mid-task" }), session));
    assert.match(before, /handoff-agent/, `clock-in never took, so this proves nothing:\n${before}`);

    const handoff = await postMcp(port, toolCall(4, "store_memory", {
      content: "HANDOFF: done for now", tags: ["kind:handoff"],
    }), session);
    assert.match(textOf(handoff), /cleared/i, `handoff did not clear an explicitly clocked-in identity:\n${textOf(handoff)}`);

    const after = textOf(await postMcp(port, toolCall(5, "store_memory", { content: "after the handoff" }), session));
    assert.doesNotMatch(after, /handoff-agent/, `identity survived the handoff:\n${after}`);
  });
});
