# Per-Connection MCP Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the daemon real, per-connection MCP sessions so `agent_id` auto-binds from `clientInfo.name` at `initialize` instead of requiring it on every call, without reintroducing the cross-talk bug the single-writer daemon was built to eliminate.

**Architecture:** Replace the daemon's "fresh `Server` + transport per request, both discarded after" pattern with a session registry keyed by MCP's real `Mcp-Session-Id`. A `WeakMap<Server, ActiveAgentSession>` in `server-main.ts`, keyed by the per-session `Server` instance (not a shared/global variable), holds each session's bound identity; seven existing tool-dispatch call sites consult it as a fallback tier between the caller's explicit `agent_id` and the existing `unassigned` default. `stdio-proxy.ts` stops answering `initialize` locally and instead forwards it to the daemon, capturing and re-attaching the real session id on every subsequent call.

**Tech Stack:** TypeScript (compiled via `tsc` to `build/`), `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` (stateful mode: `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`), Node's built-in `node:test` + `node:assert/strict` (spawns the compiled server/daemon over real HTTP or stdio — no test framework dependency, matching `test/bridge-daemon.test.mjs`'s existing pattern).

## Global Constraints

- Spec source of truth: `docs/superpowers/specs/2026-07-16-per-connection-mcp-sessions-design.md`.
- Build-and-serve-locally only. No CHANGELOG/version bump, no release step — this is not part of a 0.4.0 release cut. Version stays `0.3.9`.
- `update_memory`'s `memory_agent_id` repair-only field must NEVER consult session state — stays explicit-argument-only in every task.
- Session state (`ActiveAgentSession`, the daemon's session registry) is never persisted to the snapshot/WAL. A daemon restart always starts with zero sessions.
- Run `npm run build && node --test` after every task. All existing tests must keep passing. (Two pre-existing failures — `agent-customization-wording.test.mjs`'s doc-template-drift checks — are unrelated to this work; confirmed via `git stash` against unmodified code on 2026-07-16. Don't try to fix them as part of this plan.)
- Tags follow this repo's `topic:`/`scope:`/`kind:`/`layer:` convention.
- Each task's tests spawn real processes (compiled `build/index.js --daemon`, or the stdio proxy) and talk to them over real HTTP/stdio, exactly like `test/bridge-daemon.test.mjs` — no mocking the transport or the SDK.

---

### Task 1: Daemon session registry (persistent per-session transports, `Mcp-Session-Id` routing, idle timeout)

**Files:**
- Modify: `src/core/daemon.ts`
- Test: `test/daemon-session-registry.test.mjs`

**Interfaces:**
- Produces: `attachDaemonRoutes` now maintains an internal `sessions: Map<string, { transport: StreamableHTTPServerTransport; server: Server; lastActivityAt: number }>`, not exported — later tasks only interact with sessions through the `Mcp-Session-Id` HTTP header, never this map directly.
- Consumes: nothing new from other tasks yet (identity binding is Task 2).

- [ ] **Step 1: Write the failing test**

Create `test/daemon-session-registry.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/daemon-session-registry.test.mjs`
Expected: FAIL — today's daemon has `sessionIdGenerator: undefined` (stateless mode), so no `Mcp-Session-Id` header is ever returned and every request is independent; the "mints a fresh session id", "persists across requests", and "idle sweep" assertions all fail on missing/undefined session ids.

- [ ] **Step 3: Rewrite `attachDaemonRoutes` to maintain a session registry**

Open `src/core/daemon.ts`. Replace the whole file with:

```ts
import * as http from "http";
import * as crypto from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { logger } from "./logger.js";

export interface DaemonRouteOptions {
  createServer: () => Server;
  version: string;
  memoryPath: string;
  getMemoryCount: () => number;
}

interface DaemonSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastActivityAt: number;
}

const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

function resolveSessionIdleMs(): number {
  const raw = process.env.NEURODIVERGENT_MEMORY_SESSION_IDLE_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_IDLE_MS;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (!data) { resolve(undefined); return; }
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

/**
 * Bind 127.0.0.1:port FIRST, before the store exists. The exclusive port bind
 * is the singleton lock: a second daemon gets EADDRINUSE and exits 0 without
 * ever constructing (or writing) the store. Requests that arrive before
 * attachDaemonRoutes() get 503 so health polls simply retry.
 */
export function createHttpListener(port: number): Promise<http.Server> {
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "daemon starting" }));
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.info({ port }, "Memory daemon already running on port; exiting (singleton lock)");
        process.exit(0);
      }
      reject(err);
    });
    httpServer.listen(port, "127.0.0.1", () => resolve(httpServer));
  });
}

export function attachDaemonRoutes(httpServer: http.Server, options: DaemonRouteOptions): void {
  const { createServer, version, memoryPath, getMemoryCount } = options;

  // Real per-connection MCP sessions: each session gets its own long-lived
  // Server+transport pair, reused across every request that carries its
  // Mcp-Session-Id. This replaces the old "fresh Server per request" pattern —
  // that pattern existed only to keep concurrent clients' JSON-RPC ids from
  // crossing wires on a shared transport, which a persistent per-session
  // transport still guarantees. It does NOT touch the single-writer
  // guarantee, which comes from the NeurodivergentMemory singleton's
  // writeMutex, not from per-request disposal.
  const sessions = new Map<string, DaemonSession>();

  const idleMs = resolveSessionIdleMs();
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastActivityAt > idleMs) {
        sessions.delete(sessionId);
        void session.transport.close();
        void session.server.close();
      }
    }
  }, Math.min(idleMs, 60_000));
  sweepInterval.unref();

  httpServer.removeAllListeners("request");
  httpServer.on("request", (req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid: process.pid, version, memoryPath, mode: "daemon", memoryCount: getMemoryCount() }));
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const rawSessionId = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found or expired" } }));
            return;
          }
          existing.lastActivityAt = Date.now();
          await existing.transport.handleRequest(req, res);
          return;
        }

        // No session header. Two callers reach this branch: a real MCP
        // client's `initialize` call (wants a session), and a caller that
        // never establishes a session at all — the bridge's runMcpTool,
        // pre-Task-3 stdio-proxy forwarding, and any bare direct HTTP
        // caller all send tools/call with no handshake. The SDK's stateful
        // transport mode rejects any non-initialize request with no
        // session (400), so those callers need the exact old stateless
        // per-request behavior preserved — read the body once to tell
        // the two cases apart.
        const parsedBody = await readJsonBody(req);
        const isInitialize = typeof parsedBody === "object" && parsedBody !== null && (parsedBody as { method?: unknown }).method === "initialize";

        if (isInitialize) {
          const server = createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, { transport, server, lastActivityAt: Date.now() });
            },
            onsessionclosed: (closedSessionId) => {
              sessions.delete(closedSessionId);
            },
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        // Stateless fallback: today's exact pre-Task-1 behavior for callers
        // that never hand shake — a throwaway Server+transport pair, closed
        // when the response ends.
        const statelessServer = createServer();
        const statelessTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void statelessTransport.close();
          void statelessServer.close();
        });
        await statelessServer.connect(statelessTransport);
        await statelessTransport.handleRequest(req, res, parsedBody);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (err) {
      logger.error({ err }, "Daemon request handling failed");
      if (!res.writableEnded) {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } }));
      }
    }
  }

  logger.info({ pid: process.pid, memoryPath, version, sessionIdleMs: idleMs }, "Memory daemon routes attached; per-connection sessions active");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/daemon-session-registry.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm run build && node --test`
Expected: all existing tests pass except the same 2 pre-existing, unrelated `agent-customization-wording.test.mjs` failures documented in Global Constraints. This includes `test/bridge-daemon.test.mjs`, `test/bridge-project-reassign.test.mjs`, and every proxy/singleton/regression test that sends bare `tools/call` with no `initialize` and no session header — the stateless fallback branch (Step 3) exists specifically so none of them need to change. If any of them fail, the fallback branch is misrouting a request that should have gone stateless — don't patch the failing test, fix the routing.

- [ ] **Step 6: Commit**

```bash
git add src/core/daemon.ts test/daemon-session-registry.test.mjs
git commit -m "feat: give the daemon real per-connection MCP sessions"
```

---

### Task 2: Automatic identity binding from `clientInfo`, dispatch-layer fallback wiring, `server_handshake` override

**Files:**
- Modify: `src/core/daemon.ts` (bind identity at session creation)
- Modify: `src/index.ts` (thread the new options through)
- Modify: `src/server-main.ts` (`ActiveAgentSession` type, `WeakMap`, `resolveEffectiveAgentId` helper, 7 call-site updates, `server_handshake` schema + handler)
- Test: `test/agent-session-identity.test.mjs`

**Interfaces:**
- Consumes: Task 1's session registry (routes by `Mcp-Session-Id`; this task adds what happens the moment a session is minted).
- Produces: `bindAgentSession(server: Server, agentId: string, sessionId: string, source: "client_info" | "override"): void`, `clearAgentSession(server: Server): void`, both exported from `src/server-main.ts` — Task 4 (session-end triggers) calls `clearAgentSession` directly from within tool handlers that already have `server` in scope.

- [ ] **Step 1: Write the failing test**

Create `test/agent-session-identity.test.mjs`:

```js
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

test("update_memory's memory_agent_id repair field never auto-fills from session state", async () => {
  await withDaemon(async (port) => {
    const sessionId = await initSession(port, "repair-session-agent");
    const stored = await postMcp(port, toolCall(2, "store_memory", { content: "memory_agent_id regression guard test" }), sessionId);
    const idMatch = stored.json.result.content[0].text.match(/ID: (memory_\d+)/);
    assert.ok(idMatch, "expected a memory id in the store_memory response");
    // No memory_agent_id passed — the repair field must stay untouched (still "repair-session-agent"
    // from the auto-bound session), never silently overwritten by some other session-derived value.
    const updated = await postMcp(port, toolCall(3, "update_memory", { memory_id: idMatch[1], content: "updated content, no memory_agent_id" }), sessionId);
    assert.match(updated.json.result.content[0].text, /Agent: repair-session-agent/, "authorship must be untouched when memory_agent_id isn't passed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/agent-session-identity.test.mjs`
Expected: FAIL — nothing binds `clientInfo.name` to a session yet, so `store_memory` without `agent_id` reports `Agent: unassigned`, and `server_handshake` doesn't accept an `agent_id` argument or report session state at all.

- [ ] **Step 3: Add `ActiveAgentSession`, the `WeakMap`, and `resolveEffectiveAgentId` to `src/server-main.ts`**

Find `function resolveStoredAgentId` (around line 4616, right after the `validateTagsField` helper added earlier). Add immediately after `resolveStoredAgentId`'s closing brace:

```ts
export interface ActiveAgentSession {
  agent_id: string;
  session_id: string;
  bound_at: string;
  source: "client_info" | "override";
}

// Keyed by the per-session Server instance (Task 1 gives each MCP session its
// own long-lived Server), never by a process-global variable — this is what
// keeps concurrent sessions from clobbering each other's identity.
const activeAgentSessions = new WeakMap<Server, ActiveAgentSession>();

export function bindAgentSession(server: Server, agentId: string, sessionId: string, source: ActiveAgentSession["source"]): void {
  activeAgentSessions.set(server, { agent_id: agentId, session_id: sessionId, bound_at: new Date().toISOString(), source });
}

export function clearAgentSession(server: Server): void {
  activeAgentSessions.delete(server);
}

function getActiveAgentSession(server: Server): ActiveAgentSession | undefined {
  return activeAgentSessions.get(server);
}

/** Explicit arg wins; otherwise falls back to the calling session's bound identity, then to the "unassigned" default (applied later, inside the store). */
function resolveEffectiveAgentId(agentId: string | undefined | null, server: Server, fieldPath = "agent_id"): string | undefined {
  return normalizeOptionalAgentId(agentId, fieldPath) ?? getActiveAgentSession(server)?.agent_id;
}
```

`Server` is already imported at the top of `src/server-main.ts` (it's the type used by `createMcpServer(): Server`) — no new import needed.

- [ ] **Step 4: Update the 7 dispatch call sites to consult the session**

All 7 edits are inside `createMcpServer()`, so `server` (the function's local `const server = new Server(...)`) is in scope at every site.

In `case "store_memory"`, change:
```ts
const normalizedAgentId = normalizeOptionalAgentId(agent_id);
```
to:
```ts
const normalizedAgentId = resolveEffectiveAgentId(agent_id, server);
```
and change the `memorySystem.storeMemory(...)` call's `session_id` argument from `session_id` to `session_id ?? getActiveAgentSession(server)?.session_id`.

In `case "update_memory"`, change:
```ts
const normalizedActorAgentId = normalizeOptionalAgentId(agent_id);
```
to:
```ts
const normalizedActorAgentId = resolveEffectiveAgentId(agent_id, server);
```

In `case "retrieve_memory"`, change:
```ts
const { memory_id, district, agent_id } = request.params.arguments as any;
const retrieval = memorySystem.retrieveMemory(memory_id, { district, agent_id });
```
to:
```ts
const { memory_id, district, agent_id } = request.params.arguments as any;
const normalizedAgentId = resolveEffectiveAgentId(agent_id, server);
const retrieval = memorySystem.retrieveMemory(memory_id, { district, agent_id: normalizedAgentId });
```

In `case "connect_memories"`, change:
```ts
const normalizedAgentId = normalizeOptionalAgentId(agent_id);
```
to:
```ts
const normalizedAgentId = resolveEffectiveAgentId(agent_id, server);
```

In `case "share_memory"`, change:
```ts
const { memory_id, target_agent_id, target_project_id, new_visibility, agent_id } = request.params.arguments as any;
try {
  const result = await runMutatingTool(
    "share_memory",
    () => memorySystem.shareMemory(memory_id, target_agent_id, target_project_id, new_visibility, agent_id),
  );
```
to:
```ts
const { memory_id, target_agent_id, target_project_id, new_visibility, agent_id } = request.params.arguments as any;
try {
  const normalizedAgentId = resolveEffectiveAgentId(agent_id, server);
  const result = await runMutatingTool(
    "share_memory",
    () => memorySystem.shareMemory(memory_id, target_agent_id, target_project_id, new_visibility, normalizedAgentId),
  );
```

In `case "distill_memory"`, change:
```ts
const normalizedAgentId = normalizeOptionalAgentId(agent_id);
```
to:
```ts
const normalizedAgentId = resolveEffectiveAgentId(agent_id, server);
```

In `case "close_task"`, change:
```ts
const normalizedActorAgentId = normalizeOptionalAgentId(agent_id);
```
to:
```ts
const normalizedActorAgentId = resolveEffectiveAgentId(agent_id, server);
```

- [ ] **Step 5: Extend `server_handshake` to accept an override and report current state**

Find the `server_handshake` tool descriptor (around line 5469):

```ts
{
  name: "server_handshake",
  description: "Return runtime server identity and version details so clients can confirm the active build.",
  inputSchema: {
    type: "object",
    properties: {}
  }
},
```

Replace with:

```ts
{
  name: "server_handshake",
  description: "Return runtime server identity, version, and current session identity. Pass agent_id to override the identity auto-bound from this session's clientInfo.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Optional. Overrides this session's auto-bound agent_id (from clientInfo.name) for every subsequent call in this session." }
    }
  }
},
```

Find the `case "server_handshake":` handler (around line 6541) and replace its body:

```ts
case "server_handshake": {
  const { agent_id: overrideAgentId } = request.params.arguments as any;
  if (overrideAgentId) {
    const existing = getActiveAgentSession(server);
    bindAgentSession(server, overrideAgentId, existing?.session_id ?? extra.sessionId ?? "unknown", "override");
  }
  const currentSession = getActiveAgentSession(server);
  const sessionLine = currentSession
    ? `Active session: agent_id=${currentSession.agent_id}, session_id=${currentSession.session_id}, bound at ${currentSession.bound_at} (${currentSession.source})`
    : "Active session: none (no identity bound — this client's clientInfo.name was empty, and no agent_id override has been set)";

  const quickstart = [
    "",
    "📋 Quick start (read this once per session)",
    "1. `store_memory` needs only `content`. District, tags, intensity, agent_id, etc. are all optional — the server fills in sensible defaults.",
    "2. District is auto-inferred from your content if you omit it. The response tells you when this happened (\"auto-inferred\"); if the guess is wrong, either pass `district` explicitly next time or fix it with `update_memory`.",
    "3. Tags (`topic:X`, `scope:X`, `kind:X`, `layer:X`) are optional enrichment, not a requirement. Add them when a memory is meant to be durable or cross-session searchable; skip them for quick task-log notes. A bare `store_memory({content})` call is a complete, valid write.",
    "4. Before starting work, call `search_memories` for the current task and `memory_stats` for an overview — don't assume prior context persists.",
    "5. Use `connect_memories` to link related entries so future sessions can follow the thread instead of rediscovering it.",
    "6. Your session's agent_id is auto-bound from your client's clientInfo.name (see \"Active session\" above) — you don't need to pass agent_id on every call. Pass agent_id to server_handshake once if you need to override it.",
    "In short: write early, write often, and don't let metadata decisions slow you down — content is the only thing that has to be right on the first try.",
  ].join("\n");

  return {
    content: [{
      type: "text",
      text: [
        "🤝 Server Handshake",
        `Name: ${SERVER_PACKAGE_INFO.name}`,
        `Version: ${SERVER_PACKAGE_INFO.version}`,
        `Started: ${SERVER_START_TIME_ISO}`,
        `PID: ${process.pid}`,
        `Node.js: ${process.version}`,
        "Transport: stdio",
        sessionLine,
        quickstart,
      ].join("\n"),
    }],
  };
}
```

The handler needs `extra` as a second parameter. Find:
```ts
server.setRequestHandler(CallToolRequestSchema, async (request) => {
```
Change to:
```ts
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
```

- [ ] **Step 6: Bind identity automatically at session creation in `src/core/daemon.ts`**

In `DaemonRouteOptions`, add the two new fields:
```ts
export interface DaemonRouteOptions {
  createServer: () => Server;
  version: string;
  memoryPath: string;
  getMemoryCount: () => number;
  bindAgentSession: (server: Server, agentId: string, sessionId: string, source: "client_info" | "override") => void;
  clearAgentSession: (server: Server) => void;
}
```

Destructure them alongside the others:
```ts
const { createServer, version, memoryPath, getMemoryCount, bindAgentSession, clearAgentSession } = options;
```

In the "no session header" branch, extend `onsessioninitialized` and `onsessionclosed`:
```ts
onsessioninitialized: (newSessionId) => {
  sessions.set(newSessionId, { transport, server, lastActivityAt: Date.now() });
  const clientInfo = server.getClientVersion();
  if (clientInfo?.name) {
    bindAgentSession(server, clientInfo.name, newSessionId, "client_info");
  }
},
onsessionclosed: (closedSessionId) => {
  sessions.delete(closedSessionId);
  clearAgentSession(server);
},
```

Also call `clearAgentSession` in the idle-timeout sweep, right before closing:
```ts
if (now - session.lastActivityAt > idleMs) {
  sessions.delete(sessionId);
  clearAgentSession(session.server);
  void session.transport.close();
  void session.server.close();
}
```

- [ ] **Step 7: Thread the new options through `src/index.ts`**

Find:
```ts
const { createHttpListener, attachDaemonRoutes } = await import("./core/daemon.js");
const httpServer = await createHttpListener(resolveDaemonPort());
const { createMcpServer, SERVER_PACKAGE_INFO, PERSISTENCE_FILE, getMemoryCount } = await import("./server-main.js");
attachDaemonRoutes(httpServer, {
  createServer: createMcpServer,
  version: SERVER_PACKAGE_INFO.version,
  memoryPath: PERSISTENCE_FILE,
  getMemoryCount,
});
```

Replace with:
```ts
const { createHttpListener, attachDaemonRoutes } = await import("./core/daemon.js");
const httpServer = await createHttpListener(resolveDaemonPort());
const { createMcpServer, SERVER_PACKAGE_INFO, PERSISTENCE_FILE, getMemoryCount, bindAgentSession, clearAgentSession } = await import("./server-main.js");
attachDaemonRoutes(httpServer, {
  createServer: createMcpServer,
  version: SERVER_PACKAGE_INFO.version,
  memoryPath: PERSISTENCE_FILE,
  getMemoryCount,
  bindAgentSession,
  clearAgentSession,
});
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run build && node --test test/agent-session-identity.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 9: Run the full suite to confirm no regressions**

Run: `npm run build && node --test`
Expected: 221+ pass (plus this task's new tests), same 2 pre-existing unrelated failures.

- [ ] **Step 10: Commit**

```bash
git add src/core/daemon.ts src/index.ts src/server-main.ts test/agent-session-identity.test.mjs
git commit -m "feat: auto-bind agent identity from clientInfo.name per session"
```

---

### Task 3: `stdio-proxy.ts` forwards `initialize` and carries the real session id

**Files:**
- Modify: `src/core/stdio-proxy.ts`
- Test: `test/stdio-proxy-session.test.mjs`

**Interfaces:**
- Consumes: Task 1's session routing (`Mcp-Session-Id` header), Task 2's identity binding (so this task's test can verify identity works end-to-end through the proxy, not just direct-to-daemon).

- [ ] **Step 1: Write the failing test**

Create `test/stdio-proxy-session.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
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
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/stdio-proxy-session.test.mjs`
Expected: FAIL — today's proxy answers `initialize` locally with a fabricated response and never contacts the daemon at all, so no session id is ever established and `store_memory`'s response shows `Agent: unassigned`.

- [ ] **Step 3: Rewrite the `initialize` handling in `src/core/stdio-proxy.ts`**

Find:
```ts
const FALLBACK_PROTOCOL_VERSION = "2024-11-05";
```
Delete this line — it becomes dead code once `initialize` is forwarded instead of fabricated locally.

Find:
```ts
export async function runStdioProxy(options: ProxyOptions): Promise<void> {
  const port = options.port ?? resolveDaemonPort();
  const logFile =
    options.logFile ?? path.join(resolvePersistenceLocation().dir, "daemon.log");

  // Warm start (non-blocking): most sessions' first real call skips the spawn wait.
  void ensureDaemon({ port, entryPath: options.entryPath, logFile }).catch((err) => {
    logger.warn({ err }, "Proxy warm-start of daemon failed; will retry per request");
  });

  const write = (msg: unknown): void => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };
```

Replace with the same code plus one new line:
```ts
export async function runStdioProxy(options: ProxyOptions): Promise<void> {
  const port = options.port ?? resolveDaemonPort();
  const logFile =
    options.logFile ?? path.join(resolvePersistenceLocation().dir, "daemon.log");

  // This process is genuinely one process per client — the proxy's half of
  // the original per-process assumption still holds. It just needs to carry
  // a real session id to the shared daemon instead of pretending every call
  // is independent.
  let sessionId: string | undefined;

  // Warm start (non-blocking): most sessions' first real call skips the spawn wait.
  void ensureDaemon({ port, entryPath: options.entryPath, logFile }).catch((err) => {
    logger.warn({ err }, "Proxy warm-start of daemon failed; will retry per request");
  });

  const write = (msg: unknown): void => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };
```

Find the `initialize` short-circuit branch:
```ts
    if (msg.method === "initialize" && msg.id !== undefined) {
      const requested = msg.params?.protocolVersion;
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: typeof requested === "string" ? requested : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: options.serverName, version: options.serverVersion },
        },
      });
      return;
    }

    // Notifications carry no id and the daemon is stateless — drop them.
    if (msg.id === undefined) return;
```

Delete it entirely — `initialize` now falls through to the same forwarding path as every other request. Only the notification-drop guard stays:
```ts
    // Notifications carry no id and the daemon is stateless per MCP-message —
    // drop them (the daemon's session, once minted, doesn't need them).
    if (msg.id === undefined) return;
```

Find the forwarding block:
```ts
    try {
      const health = await ensureDaemon({ port, entryPath: options.entryPath, logFile });
      warnOnMemoryPathMismatch(health.memoryPath, health.pid);
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify(msg),
      });
      const text = await res.text();
      let response: unknown;
      try {
        response = JSON.parse(text);
      } catch {
        throw new Error(`daemon returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      write(response);
    } catch (err) {
```

Replace with:
```ts
    try {
      const health = await ensureDaemon({ port, entryPath: options.entryPath, logFile });
      warnOnMemoryPathMismatch(health.memoryPath, health.pid);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
      });
      const returnedSessionId = res.headers.get("mcp-session-id");
      if (returnedSessionId) sessionId = returnedSessionId;
      const text = await res.text();
      let response: unknown;
      try {
        response = JSON.parse(text);
      } catch {
        throw new Error(`daemon returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      write(response);
    } catch (err) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/stdio-proxy-session.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm run build && node --test`
Expected: same pass count as Task 2 plus this task's new test, same 2 pre-existing unrelated failures.

- [ ] **Step 6: Commit**

```bash
git add src/core/stdio-proxy.ts test/stdio-proxy-session.test.mjs
git commit -m "feat: stdio-proxy forwards initialize and carries the real session id"
```

---

### Task 4: Session-end triggers — `kind:handoff` tag hook and `close_task` hook

**Files:**
- Modify: `src/server-main.ts`
- Test: `test/session-end-triggers.test.mjs`

**Interfaces:**
- Consumes: Task 2's `clearAgentSession(server)` and `getActiveAgentSession(server)`.

- [ ] **Step 1: Write the failing test**

Create `test/session-end-triggers.test.mjs`:

```js
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
    const stored = await postMcp(port, toolCall(2, "store_memory", { content: "task to close", tags: ["kind:task"], status: "closable" }), sessionId);
    const idMatch = stored.json.result.content[0].text.match(/ID: (memory_\d+)/);
    assert.ok(idMatch, "expected a memory id in the store_memory response");
    const closed = await postMcp(port, toolCall(3, "close_task", { memory_id: idMatch[1] }), sessionId);
    assert.match(closed.json.result.content[0].text, /Session identity cleared \(close_task\)/);
    const after = await postMcp(port, toolCall(4, "store_memory", { content: "after close_task, no explicit agent_id" }), sessionId);
    assert.match(after.json.result.content[0].text, /Agent: unassigned/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/session-end-triggers.test.mjs`
Expected: FAIL — nothing clears session identity on either trigger yet; both post-trigger `store_memory` calls still show the originally-bound agent, and neither response contains a "Session identity cleared" line.

- [ ] **Step 3: Add the `kind:handoff` tag hook to `store_memory`/`update_memory`**

In `case "store_memory"`, find where the successful response text is assembled (after `const storeResult = await runMutatingTool(...)`, right before the final `return { content: [...] }`). Add a check on the resulting memory's tags and append a note:

```ts
const memory = storeResult.memory;
const warningLine = wipWarning ? `\n${wipWarning}` : "";
const repeatWarningLine = storeResult.no_net_new_info_warning ? `\n${storeResult.no_net_new_info_warning}` : "";
const cooldownLine = storeResult.cooldown_duration_ms
  ? `\n${memorySystem.buildCrossDistrictCooldownWarning(storeResult.matched_memory_id ?? memory.id, storeResult.cooldown_duration_ms)}`
  : "";
let sessionClearedLine = "";
if (memory.tags.includes("kind:handoff") && getActiveAgentSession(server)) {
  clearAgentSession(server);
  sessionClearedLine = "\n🕐 Session identity cleared (handoff tag detected)";
}
```

Then add `${sessionClearedLine}` to the end of the returned template string (after `${cooldownLine}`).

In `case "update_memory"`, apply the same check after its own successful update, using the updated memory's tags. Find the update handler's success path (after the `runMutatingTool("update_memory", ...)` call resolves) and add the identical `if (memory.tags.includes("kind:handoff") && getActiveAgentSession(server)) { clearAgentSession(server); ... }` block, appending `sessionClearedLine` to its response text the same way.

- [ ] **Step 4: Add the `close_task` hook**

In `case "close_task"`, after the successful transition (right after the `await runMutatingTool("close_task", ...)` call, before its `return`), add:

```ts
let sessionClearedLine = "";
if (getActiveAgentSession(server)) {
  clearAgentSession(server);
  sessionClearedLine = "\n🕐 Session identity cleared (close_task)";
}
return {
  content: [{
    type: "text",
    text: [
      `🔒 close_task: ${currentState} → closed.`,
      `memory_id: ${memory_id}`,
      `lifecycle_state: closed`,
    ].join("\n") + sessionClearedLine,
  }],
};
```

(Replacing the existing `return` in that success branch — the idempotent "already closed" branch above it is unaffected and does not clear identity, matching the spec: only a real `closable → closed` transition fires this hook.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test test/session-end-triggers.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm run build && node --test`
Expected: all tests from Tasks 1–4 passing, same 2 pre-existing unrelated failures, no other regressions.

- [ ] **Step 7: Commit**

```bash
git add src/server-main.ts test/session-end-triggers.test.mjs
git commit -m "feat: clear session identity on kind:handoff writes and close_task"
```

---

## Out of scope for this plan

- The web bridge (`scripts/nd-mem-bridge-server.mjs`) does not get a session — its own daemon calls stay stateless/per-call, per the spec's non-goals.
- Persisting session state across a daemon restart.
- The paused Step 3 (LAN bind + API-key auth) design thread — separate spec, separate plan, when picked back up.
- The "post-handoff orphan write" telemetry bonus from the original 2026-07-08 design — still deferred.
