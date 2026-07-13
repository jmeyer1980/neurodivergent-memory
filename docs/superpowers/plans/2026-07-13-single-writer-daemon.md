# Single-Writer Memory Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make exactly one process ever write `memories.json` by adding an HTTP daemon mode and making the default stdio launch a thin proxy to it, per [docs/superpowers/specs/2026-07-13-single-writer-daemon-design.md](../specs/2026-07-13-single-writer-daemon-design.md).

**Architecture:** `build/index.js` becomes a thin mode dispatcher (`src/index.ts`, ~90 lines) over the renamed heavy module `src/server-main.ts`. Three modes: `daemon` (sole writer, MCP over Streamable HTTP on `127.0.0.1:3838`), `proxy` (default for stdio launches; ensures daemon, forwards JSON-RPC), `standalone` (today's behavior, explicit opt-in for tests). The bridge drops its spawned MCP child and forwards to the daemon.

**Tech Stack:** TypeScript (strict, `tsc`), `@modelcontextprotocol/sdk` 1.29.0 (`StreamableHTTPServerTransport`, stateless + `enableJsonResponse`), `node:http`, `node:test` + `node:assert/strict`, pino (already logs to fd 2).

## Global Constraints

- **CRITICAL:** the store (`NeurodivergentMemory`) is constructed at module import of `server-main.ts` and its constructor can WRITE (WAL compaction). Proxy mode must therefore never import `server-main.js`; daemon mode must bind the port (singleton lock) BEFORE importing it. Tasks 2–5 encode this ordering — do not "simplify" it away.
- No new runtime dependencies. Only `@modelcontextprotocol/sdk` and `pino` in `dependencies`.
- New core modules must not import `server-main.ts` (that would construct the store). `src/core/persistence.ts`, `src/core/logger.ts`, `src/core/run-mode.ts` are safe imports.
- stdout of proxy mode carries only JSON-RPC lines. All diagnostics go to stderr (pino already uses fd 2).
- Default daemon port: `3838`; env override `NEURODIVERGENT_MEMORY_DAEMON_PORT`. Mode env: `NEURODIVERGENT_MEMORY_MODE` = `daemon` | `proxy` | `standalone` (unknown values → `proxy`, the safe non-writer).
- HTTP bind is `127.0.0.1` only. No auth in this pass.
- Build/test loop: `npm run build` then `node --test test/<file>` for a single file; `npm test` for the suite. `npm run lint:code` runs `tsc --noEmit`.
- Windows dev machine: spawn daemons with `detached: true, windowsHide: true`, and always kill spawned daemons in test `finally` blocks via the pid from `/health`.
- Commit after every task (conventional commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` footer).

---

### Task 1: Run-mode and port resolution module

**Files:**
- Create: `src/core/run-mode.ts`
- Test: `test/run-mode.test.mjs`

**Interfaces:**
- Produces: `type RunMode = "daemon" | "proxy" | "standalone"`, `resolveRunMode(options?: {argv?: string[]; env?: NodeJS.ProcessEnv}): RunMode`, `DEFAULT_DAEMON_PORT = 3838`, `resolveDaemonPort(env?: NodeJS.ProcessEnv): number`. Used by Tasks 3, 5, 7.

- [ ] **Step 1: Write the failing test**

```js
// test/run-mode.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { resolveRunMode, resolveDaemonPort, DEFAULT_DAEMON_PORT } from "../build/core/run-mode.js";

test("--daemon flag wins over env", () => {
  assert.equal(resolveRunMode({ argv: ["--daemon"], env: { NEURODIVERGENT_MEMORY_MODE: "standalone" } }), "daemon");
});

test("env daemon selects daemon", () => {
  assert.equal(resolveRunMode({ argv: [], env: { NEURODIVERGENT_MEMORY_MODE: "daemon" } }), "daemon");
});

test("env standalone selects standalone", () => {
  assert.equal(resolveRunMode({ argv: [], env: { NEURODIVERGENT_MEMORY_MODE: "standalone" } }), "standalone");
});

test("no flag and no env defaults to proxy", () => {
  assert.equal(resolveRunMode({ argv: [], env: {} }), "proxy");
});

test("unknown env value falls back to proxy (safe non-writer)", () => {
  assert.equal(resolveRunMode({ argv: [], env: { NEURODIVERGENT_MEMORY_MODE: "bogus" } }), "proxy");
});

test("port defaults to 3838", () => {
  assert.equal(resolveDaemonPort({}), DEFAULT_DAEMON_PORT);
  assert.equal(DEFAULT_DAEMON_PORT, 3838);
});

test("port env override and garbage rejection", () => {
  assert.equal(resolveDaemonPort({ NEURODIVERGENT_MEMORY_DAEMON_PORT: "4141" }), 4141);
  assert.equal(resolveDaemonPort({ NEURODIVERGENT_MEMORY_DAEMON_PORT: "not-a-port" }), DEFAULT_DAEMON_PORT);
  assert.equal(resolveDaemonPort({ NEURODIVERGENT_MEMORY_DAEMON_PORT: "0" }), DEFAULT_DAEMON_PORT);
  assert.equal(resolveDaemonPort({ NEURODIVERGENT_MEMORY_DAEMON_PORT: "70000" }), DEFAULT_DAEMON_PORT);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/run-mode.test.mjs`
Expected: FAIL — `Cannot find module '.../build/core/run-mode.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/run-mode.ts
export type RunMode = "daemon" | "proxy" | "standalone";

export interface RunModeOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the process run mode. Proxy is the default for any stdio launch so
 * that no MCP config (current or forgotten) can ever open the store directly —
 * that is the structural single-writer guarantee. Unknown env values also fall
 * back to proxy: the safe failure mode is "not a writer".
 */
export function resolveRunMode(options: RunModeOptions = {}): RunMode {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;

  if (argv.includes("--daemon")) return "daemon";

  const raw = env.NEURODIVERGENT_MEMORY_MODE?.trim().toLowerCase();
  if (raw === "daemon") return "daemon";
  if (raw === "standalone") return "standalone";
  return "proxy";
}

export const DEFAULT_DAEMON_PORT = 3838;

export function resolveDaemonPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NEURODIVERGENT_MEMORY_DAEMON_PORT?.trim();
  if (!raw) return DEFAULT_DAEMON_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_DAEMON_PORT;
  return parsed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/run-mode.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/run-mode.ts test/run-mode.test.mjs
git commit -m "feat: add run-mode and daemon-port resolution for single-writer daemon"
```

---

### Task 2: Rename index.ts to server-main.ts behind a thin dispatcher entry

No behavior change in this task — the thin entry still runs standalone for every mode. This isolates the risky mechanical refactor so the full suite validates it before any mode flips.

**Files:**
- Rename: `src/index.ts` → `src/server-main.ts` (use `git mv` so history follows)
- Create: `src/core/package-info.ts`
- Create: `src/index.ts` (new thin dispatcher)
- Modify: `src/server-main.ts` (factory wrap + exports)

**Interfaces:**
- Produces (from `src/server-main.ts`): `export function createMcpServer(): Server`, `export async function runStandalone(): Promise<void>`, `export function runInitAgentKit(argv: string[]): number`, `export const SERVER_PACKAGE_INFO: {name: string; version: string}`, `export const PERSISTENCE_FILE: string`. Importing this module constructs the store (may write via WAL compaction) — Tasks 3/5 rely on lazy `await import()`.
- Produces (from `src/core/package-info.ts`): `export function resolveServerPackageInfo(packageJsonUrl: URL): {name: string; version: string}`.

- [ ] **Step 1: Move the file**

```bash
git mv src/index.ts src/server-main.ts
```

- [ ] **Step 2: Extract package info helper**

Create `src/core/package-info.ts`:

```ts
// src/core/package-info.ts
import * as fs from "fs";

export interface ServerPackageInfo {
  name: string;
  version: string;
}

export function resolveServerPackageInfo(packageJsonUrl: URL): ServerPackageInfo {
  try {
    const raw = fs.readFileSync(packageJsonUrl, "utf-8");
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: parsed.name ?? "neurodivergent-memory",
      version: parsed.version ?? "unknown",
    };
  } catch {
    return { name: "neurodivergent-memory", version: "unknown" };
  }
}
```

In `src/server-main.ts`, delete the local `resolveServerPackageInfo` function (currently lines 44–59) and replace line 61 with:

```ts
import { resolveServerPackageInfo } from "./core/package-info.js";
// ... (import goes with the other ./core imports near the top)

export const SERVER_PACKAGE_INFO = resolveServerPackageInfo(new URL("../package.json", import.meta.url));
```

- [ ] **Step 3: Export the identifiers the dispatcher needs**

In `src/server-main.ts`:
- Line ~700: `function runInitAgentKit(argv: string[]): number {` → `export function runInitAgentKit(argv: string[]): number {`
- Line ~964: `const PERSISTENCE_FILE = PERSISTENCE_LOCATION.file;` → `export const PERSISTENCE_FILE = PERSISTENCE_LOCATION.file;`

- [ ] **Step 4: Wrap server construction in a factory**

In `src/server-main.ts`, immediately BEFORE the doc comment above `const server = new Server(` (currently line ~4855), insert:

```ts
/**
 * Factory so the HTTP daemon can create a fresh Server per stateless request
 * (fresh transports need fresh Server instances). Every created Server closes
 * over the same module-level `memorySystem` store singleton, whose writeMutex
 * serializes all mutations — that is the concurrency guarantee.
 */
export function createMcpServer(): Server {
```

Change `const server = new Server(` to `  const server = new Server(` (it is now inside the function). Then immediately BEFORE the doc comment `/** Start the server using stdio transport ... */` (currently line ~7042), insert:

```ts
  return server;
}

const server = createMcpServer();
```

Everything between (all `server.setRequestHandler(...)` blocks and any helpers used only by them) now lives inside the factory. Do NOT re-indent the whole region (a 2,000-line whitespace diff hides real changes) — TypeScript does not care.

Verification for this step: run `npm run lint:code`. If `tsc` reports "Cannot find name" for something defined inside the factory but referenced outside it (or vice versa), MOVE that specific declaration to just above the `createMcpServer` function — do not widen the factory. Also search the wrapped region for module-level side effects that must not run per-request: `process.on(`, `setInterval(`, `setTimeout(` — if any exist inside the factory region, move them above it too.

- [ ] **Step 5: Replace the old main with runStandalone**

In `src/server-main.ts`, delete the entire tail block: `async function main() {...}`, `function isDirectExecution() {...}`, and the `if (isDirectExecution()) {...}` call (currently lines ~7042–7073). Replace with:

```ts
/**
 * Standalone mode: today's pre-daemon behavior — stdio transport with this
 * process owning the store. Explicit opt-in only (tests, CI, inspector).
 */
export async function runStandalone(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 6: Create the thin dispatcher entry**

Create `src/index.ts`:

```ts
#!/usr/bin/env node
/**
 * Thin mode dispatcher. IMPORTANT: importing ./server-main.js constructs the
 * memory store, which can WRITE (WAL compaction at startup). Every branch that
 * must not write therefore uses lazy `await import()` and never touches
 * server-main. Daemon/proxy branches are wired in later tasks.
 */
import * as path from "path";
import { fileURLToPath } from "url";

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "init-agent-kit" || command === "setup-agent-kit") {
    const { runInitAgentKit } = await import("./server-main.js");
    process.exitCode = runInitAgentKit(process.argv.slice(3));
    return;
  }

  // Mode dispatch lands in Tasks 3 and 5. Until then, standalone for all.
  const { runStandalone } = await import("./server-main.js");
  await runStandalone();
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  return path.resolve(entryPoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error("neurodivergent-memory entry failed", error);
    process.exit(1);
  });
}
```

- [ ] **Step 7: Run the full suite to prove no behavior change**

Run: `npm test`
Expected: PASS — identical results to before this task (tests spawn `build/index.js`, which still ends up in standalone behavior).

- [ ] **Step 8: Commit**

```bash
git add -A src/ test/
git commit -m "refactor: split entrypoint into thin dispatcher + server-main with createMcpServer factory"
```

---

### Task 3: Daemon mode — Streamable HTTP on localhost with port-bind singleton

**Files:**
- Create: `src/core/daemon.ts`
- Modify: `src/index.ts` (daemon branch)
- Test: `test/daemon-http.test.mjs`

**Interfaces:**
- Consumes: `createMcpServer`, `SERVER_PACKAGE_INFO`, `PERSISTENCE_FILE` from `server-main.js` (Task 2); `resolveRunMode`, `resolveDaemonPort` from `run-mode.js` (Task 1).
- Produces: `createHttpListener(port: number): Promise<http.Server>` (binds 127.0.0.1; on EADDRINUSE logs and `process.exit(0)`; serves 503 until routes attach), `attachDaemonRoutes(httpServer: http.Server, options: DaemonRouteOptions): void` with `DaemonRouteOptions = { createServer: () => Server; version: string; memoryPath: string }`. `GET /health` → `{ok: true, pid, version, memoryPath, mode: "daemon"}`. `POST /mcp` → stateless JSON-RPC. Tasks 4–8 depend on `/health` and `/mcp` exactly as specified.

- [ ] **Step 1: Write the failing test**

```js
// test/daemon-http.test.mjs
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
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon not healthy on ${port} within ${timeoutMs}ms`);
}

function postMcp(port, message) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify(message),
  }).then((r) => r.json());
}

test("daemon serves health and stateless tools/call, and persists writes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-daemon-test-"));
  const port = await getFreePort();
  const child = spawn(process.execPath, ["build/index.js", "--daemon"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString(); });

  try {
    const health = await waitForHealth(port);
    assert.equal(health.ok, true);
    assert.equal(health.pid, child.pid);
    assert.equal(health.mode, "daemon");
    assert.ok(health.memoryPath.startsWith(tempDir));

    const listed = await postMcp(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.ok(Array.isArray(listed.result.tools) && listed.result.tools.length > 0, `tools/list failed: ${JSON.stringify(listed)}\nstderr: ${stderr}`);

    const stored = await postMcp(port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "store_memory", arguments: { content: "daemon-http-test memory", district: "practical_execution", tags: ["test"] } },
    });
    assert.equal(stored.error, undefined, `store failed: ${JSON.stringify(stored)}`);

    // The daemon debounces saves by ~100ms; poll the snapshot.
    const snapshotPath = path.join(tempDir, "memories.json");
    const deadline = Date.now() + 5000;
    let persisted = false;
    while (Date.now() < deadline && !persisted) {
      if (fs.existsSync(snapshotPath) && fs.readFileSync(snapshotPath, "utf8").includes("daemon-http-test memory")) persisted = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(persisted, "stored memory reached memories.json");

    // Unknown routes 404
    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(notFound.status, 404);
  } finally {
    child.kill();
  }
});

test("second daemon on same port exits 0 without touching the store", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-daemon-singleton-"));
  const port = await getFreePort();
  const env = {
    ...process.env,
    NEURODIVERGENT_MEMORY_DIR: tempDir,
    NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
  };
  const first = spawn(process.execPath, ["build/index.js", "--daemon"], { cwd: process.cwd(), env, stdio: "ignore" });
  try {
    await waitForHealth(port);
    const second = spawn(process.execPath, ["build/index.js", "--daemon"], { cwd: process.cwd(), env, stdio: "ignore" });
    const exitCode = await new Promise((resolve) => second.on("exit", resolve));
    assert.equal(exitCode, 0);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.pid, first.pid, "first daemon still owns the port");
  } finally {
    first.kill();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/daemon-http.test.mjs`
Expected: FAIL — `--daemon` is not dispatched yet, the process starts standalone stdio and health never responds (timeout).

- [ ] **Step 3: Implement the daemon module**

```ts
// src/core/daemon.ts
import * as http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { logger } from "./logger.js";

export interface DaemonRouteOptions {
  createServer: () => Server;
  version: string;
  memoryPath: string;
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
  const { createServer, version, memoryPath } = options;

  httpServer.removeAllListeners("request");
  httpServer.on("request", (req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid: process.pid, version, memoryPath, mode: "daemon" }));
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        // Stateless: a fresh Server + transport per request means concurrent
        // clients' JSON-RPC ids can never cross wires. All servers share the
        // one store singleton; its writeMutex serializes mutations.
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (err) {
      logger.error({ err }, "Daemon request handling failed");
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } }));
    }
  }

  logger.info({ pid: process.pid, memoryPath, version }, "Memory daemon routes attached; single writer active");
}
```

- [ ] **Step 4: Wire the daemon branch in the dispatcher**

In `src/index.ts`, add the import at the top and the branch between the `init-agent-kit` block and the standalone fallback:

```ts
import { resolveRunMode, resolveDaemonPort } from "./core/run-mode.js";
```

```ts
  const mode = resolveRunMode();

  if (mode === "daemon") {
    // Bind the port BEFORE importing server-main: the import constructs the
    // store and may compact the WAL (a write). Holding the port first means a
    // losing daemon exits before it can ever touch the file.
    const { createHttpListener, attachDaemonRoutes } = await import("./core/daemon.js");
    const httpServer = await createHttpListener(resolveDaemonPort());
    const { createMcpServer, SERVER_PACKAGE_INFO, PERSISTENCE_FILE } = await import("./server-main.js");
    attachDaemonRoutes(httpServer, {
      createServer: createMcpServer,
      version: SERVER_PACKAGE_INFO.version,
      memoryPath: PERSISTENCE_FILE,
    });
    return;
  }
```

Do NOT dispatch `proxy` yet — the standalone fallback still catches it (flipped in Task 5).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test test/daemon-http.test.mjs`
Expected: PASS (2 tests). If `tools/list` returns HTTP 400 mentioning `Accept` or protocol version, the SDK rejected the request headers — the `postMcp` helper's `accept` and `mcp-protocol-version` headers above are the fix; verify they made it into the failing request.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/daemon.ts src/index.ts test/daemon-http.test.mjs
git commit -m "feat: add --daemon mode serving MCP over localhost HTTP with port-bind singleton"
```

---

### Task 4: Ensure-daemon helper (health check + detached spawn + poll)

**Files:**
- Create: `src/core/ensure-daemon.ts`
- Test: `test/ensure-daemon.test.mjs`

**Interfaces:**
- Consumes: daemon `/health` shape from Task 3.
- Produces: `checkDaemonHealth(port: number, timeoutMs?: number): Promise<DaemonHealth | null>` and `ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonHealth>` where `EnsureDaemonOptions = { port: number; entryPath: string; logFile: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; pollIntervalMs?: number }` and `DaemonHealth = { ok: boolean; pid?: number; version?: string; memoryPath?: string; mode?: string }`. Used by Tasks 5 and 7.

- [ ] **Step 1: Write the failing test**

```js
// test/ensure-daemon.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/ensure-daemon.test.mjs`
Expected: FAIL — `Cannot find module '.../build/core/ensure-daemon.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/ensure-daemon.ts
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface DaemonHealth {
  ok: boolean;
  pid?: number;
  version?: string;
  memoryPath?: string;
  mode?: string;
}

export interface EnsureDaemonOptions {
  port: number;
  /** Absolute path to build/index.js (the mode dispatcher). */
  entryPath: string;
  /** The spawned daemon's stderr (pino) is appended here — it has no console. */
  logFile: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function checkDaemonHealth(port: number, timeoutMs = 750): Promise<DaemonHealth | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as DaemonHealth;
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

/**
 * Guarantee a healthy daemon on the port, spawning one detached if needed.
 * Safe under races: if two callers spawn simultaneously, the port bind picks
 * one winner and the loser exits 0 (see createHttpListener) — both callers'
 * health polls then converge on the winner.
 *
 * NEVER falls back to opening the store in-process. If the daemon cannot be
 * reached or started, this throws — a loud failure is the only safe failure.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonHealth> {
  const { port, entryPath, logFile } = options;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;

  const existing = await checkDaemonHealth(port);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [entryPath, "--daemon"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", logFd],
      env: { ...(options.env ?? process.env), NEURODIVERGENT_MEMORY_MODE: "daemon" },
    });
    child.on("error", () => { /* surfaced by the health-poll timeout below */ });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkDaemonHealth(port, Math.min(750, pollIntervalMs * 5));
    if (health) return health;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `Memory daemon did not become healthy on 127.0.0.1:${port} within ${timeoutMs}ms. ` +
      `Check the daemon log: ${logFile}`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/ensure-daemon.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/ensure-daemon.ts test/ensure-daemon.test.mjs
git commit -m "feat: add ensure-daemon helper with detached spawn and health polling"
```

---

### Task 5: Stdio proxy mode + flip the default + keep the test suite standalone

This is the task that flips the structural guarantee on. It must land as one unit: proxy module, dispatcher flip, and the standalone opt-in for every test/tool that spawns `build/index.js` directly.

**Files:**
- Create: `src/core/stdio-proxy.ts`
- Modify: `src/index.ts` (proxy branch replaces the standalone-by-default fallback)
- Modify: `package.json` (`inspector` script)
- Modify (mechanical, add one env line each): the `spawn` helper in `test/synthesize-prompt.test.mjs`, `test/server-handshake.test.mjs`, `test/store-memory-repeat.test.mjs`, `test/visibility.test.mjs`, `test/orchestration-safety-validation.test.mjs`, `test/connect-memories-recovery.test.mjs`, `test/agent-identity.test.mjs`, `test/mirror-list-tools.test.mjs`, `test/infer-district.test.mjs`, `test/session-id.test.mjs`, `test/import-diagnostics.test.mjs`, `test/luca-custom-districts.test.mjs`, `test/retrieval-context.test.mjs`, `test/epistemic-status.test.mjs`, `test/project-id.test.mjs`, and `test/live-project-id-smoke.mjs`
- Test: `test/stdio-proxy.test.mjs`

**Interfaces:**
- Consumes: `ensureDaemon` (Task 4), `resolveDaemonPort` (Task 1), `resolvePersistenceLocation` from `src/core/persistence.ts` (existing, pure — safe to import).
- Produces: `runStdioProxy(options: ProxyOptions): Promise<void>` with `ProxyOptions = { entryPath: string; serverName: string; serverVersion: string; port?: number; logFile?: string }`.

- [ ] **Step 1: Write the failing test**

```js
// test/stdio-proxy.test.mjs
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

/** Send JSON-RPC lines to a child's stdin, resolve responses by id. */
function createLineClient(child) {
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  return {
    request(msg, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for id ${msg.id}`)), timeoutMs);
        pending.set(msg.id, (response) => { clearTimeout(timer); resolve(response); });
        child.stdin.write(JSON.stringify(msg) + "\n");
      });
    },
    notify(msg) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
  };
}

test("default stdio launch is a proxy: forwards tool calls to an auto-started daemon", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-proxy-test-"));
  const port = await getFreePort();
  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
      NEURODIVERGENT_MEMORY_MODE: "", // explicit: default path
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString(); });
  const client = createLineClient(child);
  let daemonPid;

  try {
    const init = await client.request({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proxy-test", version: "0.0.0" } },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init)}\n${stderr}`);
    assert.equal(init.result.serverInfo.name, "neurodivergent-memory");
    client.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const stored = await client.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "store_memory", arguments: { content: "proxy-mode test memory", district: "practical_execution", tags: ["test"] } },
    });
    assert.equal(stored.error, undefined, `store failed: ${JSON.stringify(stored)}\n${stderr}`);

    // A real daemon must now exist and own the store...
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.notEqual(health.pid, child.pid, "proxy must not be the writer");
    daemonPid = health.pid;

    // ...and the write must be in the daemon's snapshot dir.
    const snapshotPath = path.join(tempDir, "memories.json");
    const deadline = Date.now() + 5000;
    let persisted = false;
    while (Date.now() < deadline && !persisted) {
      if (fs.existsSync(snapshotPath) && fs.readFileSync(snapshotPath, "utf8").includes("proxy-mode test memory")) persisted = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(persisted, "proxied store reached memories.json");
  } finally {
    child.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* already gone */ } }
  }
});

test("proxy fails loudly (JSON-RPC error), never becomes a writer, when daemon cannot start", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-proxy-fail-"));
  const port = await getFreePort();
  // Occupy the port with something that is NOT a healthy daemon: /health 500s.
  const net2 = await import("node:http");
  const blocker = net2.createServer((req, res) => { res.writeHead(500); res.end("{}"); });
  await new Promise((r) => blocker.listen(port, "127.0.0.1", r));

  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = createLineClient(child);
  try {
    await client.request({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const result = await client.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "store_memory", arguments: { content: "must not persist", district: "practical_execution" } },
    }, 20000);
    assert.ok(result.error, "tool call must surface a JSON-RPC error");
    assert.match(result.error.message, /daemon/i);
    assert.ok(!fs.existsSync(path.join(tempDir, "memories.json")), "proxy must never write the store itself");
  } finally {
    child.kill();
    blocker.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/stdio-proxy.test.mjs`
Expected: FAIL — default launch still runs standalone, so `health.pid` equals nothing (fetch fails) / the second test writes `memories.json` locally.

- [ ] **Step 3: Implement the proxy module**

```ts
// src/core/stdio-proxy.ts
import * as path from "path";
import * as readline from "readline";
import { ensureDaemon } from "./ensure-daemon.js";
import { resolveDaemonPort } from "./run-mode.js";
import { resolvePersistenceLocation } from "./persistence.js";
import { logger } from "./logger.js";

export interface ProxyOptions {
  /** Absolute path to build/index.js — respawned with --daemon when needed. */
  entryPath: string;
  serverName: string;
  serverVersion: string;
  port?: number;
  logFile?: string;
}

const FALLBACK_PROTOCOL_VERSION = "2024-11-05";

/**
 * Proxy mode: this process NEVER opens the store. It answers `initialize`
 * locally (the daemon is stateless per request) and forwards every other
 * request to the daemon over HTTP. If the daemon is unreachable and cannot be
 * spawned, requests get a JSON-RPC error — there is deliberately no local
 * fallback, because a silent fallback would re-create the multi-writer bug
 * this design exists to kill.
 */
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

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => { void handleLine(line); });
  rl.on("close", () => process.exit(0));

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      logger.warn({ err, linePreview: trimmed.slice(0, 120) }, "Proxy dropping unparseable stdin line");
      return;
    }

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

    try {
      await ensureDaemon({ port, entryPath: options.entryPath, logFile });
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
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: `memory daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }
}
```

- [ ] **Step 4: Flip the dispatcher default to proxy**

In `src/index.ts`, replace the standalone fallback tail of `main()` (everything after the daemon branch) with:

```ts
  if (mode === "proxy") {
    const { runStdioProxy } = await import("./core/stdio-proxy.js");
    const { resolveServerPackageInfo } = await import("./core/package-info.js");
    const info = resolveServerPackageInfo(new URL("../package.json", import.meta.url));
    await runStdioProxy({
      entryPath: fileURLToPath(import.meta.url),
      serverName: info.name,
      serverVersion: info.version,
    });
    return;
  }

  // mode === "standalone" — explicit opt-in (tests, CI, inspector).
  const { runStandalone } = await import("./server-main.js");
  await runStandalone();
```

Note the proxy branch reads package info via `core/package-info.js` — NOT via `server-main.js`, which would construct the store. (In the built output, `build/index.js` and `build/package.json`'s parent resolve the same `../package.json` URL as before.)

- [ ] **Step 5: Opt the direct-spawn tests into standalone**

In each of the 16 files listed under **Files** above, the spawn helper builds an env object that already sets `NEURODIVERGENT_MEMORY_DIR`. Add one line to that env object in each file:

```js
      NEURODIVERGENT_MEMORY_MODE: "standalone",
```

Then audit for stragglers — every spawn of the entry must now carry a mode:

```bash
grep -rn "build/index.js" test/ benchmarks/ | grep -v "MODE"
```

For any hit that spawns the server without `NEURODIVERGENT_MEMORY_MODE` nearby, open the file and add `NEURODIVERGENT_MEMORY_MODE: "standalone"` to its spawn env the same way. (Files that merely mention the path in strings/docs need no change.)

- [ ] **Step 6: Keep the inspector script usable**

In `package.json`, change:

```json
"inspector": "npx @modelcontextprotocol/inspector build/index.js"
```

to:

```json
"inspector": "npx @modelcontextprotocol/inspector -e NEURODIVERGENT_MEMORY_MODE=standalone build/index.js"
```

- [ ] **Step 7: Run the new test, then the full suite**

Run: `npm run build && node --test test/stdio-proxy.test.mjs`
Expected: PASS (2 tests)

Run: `npm test`
Expected: PASS — every pre-existing test still green via explicit standalone.

- [ ] **Step 8: Commit**

```bash
git add src/core/stdio-proxy.ts src/index.ts package.json test/
git commit -m "feat: default stdio launches to daemon-proxy mode; tests opt into standalone"
```

---

### Task 6: Spawn-race test — N simultaneous proxies, exactly one daemon

**Files:**
- Test: `test/daemon-singleton.test.mjs`

**Interfaces:**
- Consumes: proxy default mode (Task 5), `/health` (Task 3).

- [ ] **Step 1: Write the test**

```js
// test/daemon-singleton.test.mjs
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
    for (const p of proxies) p.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* gone */ } }
  }
});
```

- [ ] **Step 2: Run it**

Run: `npm run build && node --test test/daemon-singleton.test.mjs`
Expected: PASS. (If it ever flakes on the 5s persistence poll under load, raise that poll's deadline — never weaken the three-writes assertion.)

- [ ] **Step 3: Commit**

```bash
git add test/daemon-singleton.test.mjs
git commit -m "test: prove spawn race yields one daemon and no lost writes"
```

---

### Task 7: Bridge refactor — drop the MCP child, forward to the daemon

**Files:**
- Modify: `scripts/nd-mem-bridge-server.mjs`
- Test: `test/bridge-daemon.test.mjs`

**Interfaces:**
- Consumes: `ensureDaemon` from `build/core/ensure-daemon.js`, `resolveDaemonPort` from `build/core/run-mode.js` (compiled output — the bridge is plain ESM).
- Produces: unchanged HTTP API for the HTML app (`/health`, `/memories`, `/events`, `/save`, `/update`, `/`). `runMcpTool(toolName, args)` keeps returning `{ ok: true, result: <full JSON-RPC response> }` so response envelopes seen by the app do not change.

- [ ] **Step 1: Write the failing test**

```js
// test/bridge-daemon.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/bridge-daemon.test.mjs`
Expected: FAIL — `saved.routedTo` is `"stdio-mcp"` (old child path), and the daemon health check times out.

- [ ] **Step 3: Refactor the bridge**

In `scripts/nd-mem-bridge-server.mjs`:

a. Add imports (top of file, after existing imports):

```js
import { ensureDaemon } from '../build/core/ensure-daemon.js';
import { resolveDaemonPort } from '../build/core/run-mode.js';
```

b. Delete: the entire `PersistentMcpClient` class, the `TOOL_CALL_TIMEOUT_MS` / `RESPAWN_DELAY_MS` constants, the `const mcpClient = new PersistentMcpClient(...)` line, the old `runMcpTool`, the `shutdownBridge`/`SIGINT`/`SIGTERM` block (there is no child to kill — the daemon deliberately outlives the bridge), and the `MCP_COMMAND` / `MCP_ARGS` env constants (lines 14–15).

c. Add the daemon-backed replacement where `PersistentMcpClient` used to be:

```js
// Single-writer architecture: the bridge owns NO memory process. Every write
// is forwarded to the shared HTTP daemon (build/index.js --daemon), which is
// the only process that ever opens memories.json. See
// docs/superpowers/specs/2026-07-13-single-writer-daemon-design.md.
const DAEMON_PORT = resolveDaemonPort(process.env);
const DAEMON_ENTRY = process.env.ND_MEM_DAEMON_ENTRY || path.join(process.cwd(), 'build', 'index.js');
const DAEMON_LOG = path.join(path.dirname(MEMORY_PATH), 'daemon.log');

let rpcId = 1;
async function runMcpTool(toolName, args) {
  await ensureDaemon({ port: DAEMON_PORT, entryPath: DAEMON_ENTRY, logFile: DAEMON_LOG });
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: toolName, arguments: args } }),
  });
  const message = await res.json();
  if (message.error) throw new Error(JSON.stringify(message.error));
  return { ok: true, result: message };
}
```

d. In both `/update` and `/save` handlers, change the response field `routedTo: 'stdio-mcp'` to `routedTo: 'daemon-http'` (two occurrences).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/bridge-daemon.test.mjs`
Expected: PASS

- [ ] **Step 5: Manual smoke against the real environment (report result, do not skip)**

With the user's real bridge running (`node scripts/nd-mem-bridge-server.mjs` from repo root): open `http://localhost:3737/`, confirm the app loads memories and an edit round-trips. Confirm `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` shows exactly one `--daemon` process regardless of how many sessions are open.

- [ ] **Step 6: Commit**

```bash
git add scripts/nd-mem-bridge-server.mjs test/bridge-daemon.test.mjs
git commit -m "refactor: bridge forwards writes to shared daemon instead of owning an MCP child"
```

---

### Task 8: Multi-writer regression test (the 2026-07-13 incident, encoded)

**Files:**
- Test: `test/single-writer-regression.test.mjs`

**Interfaces:**
- Consumes: proxy mode (Task 5), daemon `/mcp` (Task 3) as a stand-in for any second client (the bridge path exercises identical HTTP calls per Task 7).

- [ ] **Step 1: Write the test**

```js
// test/single-writer-regression.test.mjs
// Regression for the 2026-07-13 incident: two concurrent clients (a Claude
// session via stdio proxy + the web-app path via HTTP) must never lose each
// other's writes or collide on memory IDs. Before the single-writer daemon,
// this exact interleaving destroyed two user memories.
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

function createLineClient(child) {
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  return {
    request(msg, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout id ${msg.id}`)), timeoutMs);
        pending.set(msg.id, (r) => { clearTimeout(timer); resolve(r); });
        child.stdin.write(JSON.stringify(msg) + "\n");
      });
    },
    notify(msg) { child.stdin.write(JSON.stringify(msg) + "\n"); },
  };
}

function postMcp(port, message) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify(message),
  }).then((r) => r.json());
}

test("interleaved writes from a proxy session and an HTTP client all survive with unique ids", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-regression-"));
  const port = await getFreePort();
  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, NEURODIVERGENT_MEMORY_DIR: tempDir, NEURODIVERGENT_MEMORY_DAEMON_PORT: String(port) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const proxy = createLineClient(child);
  let daemonPid;
  let httpId = 1000;

  try {
    await proxy.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "session", version: "0" } } });
    proxy.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const storeViaProxy = (n, content) =>
      proxy.request({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "store_memory", arguments: { content, district: "practical_execution" } } });
    const storeViaHttp = (content) =>
      postMcp(port, { jsonrpc: "2.0", id: httpId++, method: "tools/call", params: { name: "store_memory", arguments: { content, district: "creative_synthesis" } } });

    // Interleave: the incident shape — agent session writing while the app writes.
    const results = await Promise.all([
      storeViaProxy(10, "agent memory alpha"),
      storeViaHttp("app memory one"),
      storeViaProxy(11, "agent memory beta"),
      storeViaHttp("app memory two"),
      storeViaProxy(12, "agent memory gamma"),
    ]);
    for (const r of results) assert.equal(r.error, undefined, JSON.stringify(r));

    daemonPid = (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())).pid;

    // Every write survives in the snapshot; every id is unique; the counter is sane.
    const snapshotPath = path.join(tempDir, "memories.json");
    const expected = ["agent memory alpha", "app memory one", "agent memory beta", "app memory two", "agent memory gamma"];
    const deadline = Date.now() + 5000;
    let snapshot;
    while (Date.now() < deadline) {
      if (fs.existsSync(snapshotPath)) {
        snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        const contents = Object.values(snapshot.memories).map((m) => m.content);
        if (expected.every((e) => contents.some((c) => c.includes(e)))) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const memories = Object.values(snapshot.memories);
    for (const e of expected) {
      assert.ok(memories.some((m) => m.content.includes(e)), `lost write: ${e}`);
    }
    const ids = memories.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, "memory ids must be unique");
    const maxId = Math.max(...ids.map((id) => Number.parseInt(id.replace(/\D/g, ""), 10)));
    assert.ok(snapshot.nextMemoryId > maxId, "nextMemoryId is ahead of every assigned id");
  } finally {
    child.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* gone */ } }
  }
});
```

- [ ] **Step 2: Run it**

Run: `npm run build && node --test test/single-writer-regression.test.mjs`
Expected: PASS

- [ ] **Step 3: Run the entire suite one more time**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 4: Commit**

```bash
git add test/single-writer-regression.test.mjs
git commit -m "test: encode the 2026-07-13 multi-writer incident as a regression test"
```

---

### Task 9: Docs, version bump, and machine config migration

**Files:**
- Modify: `CHANGELOG.md`, `package.json` (version), `docs/runbooks/cross-process-coordination.md`, `docs/superpowers/specs/2026-07-11-remote-shared-memory-service-design.md`
- Machine-local (NOT in repo — perform with the user, list the diffs in the task report): `C:\Users\jerio\AppData\Roaming\Claude\claude_desktop_config.json`, VS Code `mcp.json`

- [ ] **Step 1: Version and changelog**

In `package.json`: `"version": "0.3.9"` → `"version": "0.4.0"`.

Prepend to `CHANGELOG.md` under a new `## 0.4.0` heading:

```markdown
## 0.4.0

### Added
- **Single-writer daemon architecture.** `build/index.js` now dispatches three modes:
  `--daemon` (sole process that opens `memories.json`, serving MCP over Streamable HTTP
  on `127.0.0.1:3838`, port overridable via `NEURODIVERGENT_MEMORY_DAEMON_PORT`),
  stdio **proxy** (the new default — ensures the daemon is running and forwards JSON-RPC;
  never opens the store), and `NEURODIVERGENT_MEMORY_MODE=standalone` (previous behavior,
  for tests/CI/inspector). Fixes the multi-writer last-writer-wins data loss of 2026-07-13.

### Changed
- The web-app bridge (`scripts/nd-mem-bridge-server.mjs`) no longer spawns its own MCP
  child; `/save` and `/update` forward to the shared daemon (`routedTo: "daemon-http"`).
```

- [ ] **Step 2: Update the runbook and parent spec**

In `docs/runbooks/cross-process-coordination.md`, add a short section at the top stating: as of 0.4.0, stdio launches are proxies and cannot be writers; the multi-writer scenario now requires deliberately running two daemons on different ports against one file, and `NEURODIVERGENT_COORDINATION_MODE=filesystem-lock` remains relevant only for that deliberate deployment (Profile B).

In `docs/superpowers/specs/2026-07-11-remote-shared-memory-service-design.md`, update the Step 2 heading to `### Step 2 — Streamable HTTP transport on the server (SHIPPED 2026-07-13, localhost)` and add one sentence pointing to `2026-07-13-single-writer-daemon-design.md` for the shipped shape (localhost + stdio proxy; LAN bind and auth remain Step 3).

- [ ] **Step 3: Migrate the machine configs (with the user)**

These are user-machine files, not repo files. Claude Code's `~/.claude.json` needs NO change (it already runs `node build/index.js`, which is now the proxy). Apply, or hand the user, these two edits:

`C:\Users\jerio\AppData\Roaming\Claude\claude_desktop_config.json` — replace the `neurodivergent-memory` entry:

```json
"neurodivergent-memory": {
  "command": "node",
  "args": ["C:\\Users\\jerio\\RiderProjects\\neurodivergent-memory\\build\\index.js"]
}
```

VS Code `mcp.json` (`%APPDATA%\Code\User\mcp.json`) — replace the `command`/`args` of the `neurodivergent-memory` entry the same way (keep its `autoApprove` list):

```json
"command": "node",
"args": ["C:\\Users\\jerio\\RiderProjects\\neurodivergent-memory\\build\\index.js"]
```

- [ ] **Step 4: Rollout verification on the real machine**

1. `npm run build`.
2. Ask the user to close/restart Claude sessions, or approve killing stale `build/index.js` / `npx neurodivergent-memory` processes (same cleanup as the incident recovery — get explicit approval, do not force-kill unprompted).
3. Restart the bridge (`node scripts/nd-mem-bridge-server.mjs`).
4. Verify: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'neurodivergent-memory|build\\index' }` shows exactly ONE process with `--daemon` (plus proxies and the bridge, which are fine); `curl http://127.0.0.1:3838/health` returns `ok: true`; the web app loads; a memory stored from a Claude session and an app edit both survive together.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json docs/
git commit -m "docs: ship single-writer daemon — changelog, runbook, spec status, v0.4.0"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** modes table → Tasks 1–5; port-bind singleton → Task 3; ensure-daemon/on-demand start → Task 4; fail-loud-never-fork → Task 5 (second test asserts no local `memories.json`); bridge refactor → Task 7; spawn race → Task 6; incident regression → Task 8; config migration + runbook + parent-spec update → Task 9. The spec's "daemon crash mid-session → reconnect" behavior is inherent to `ensureDaemon` running per request (Task 5 Step 3) and exercised implicitly; no separate task.
- **Store-construction-writes hazard** (WAL compaction on import) is the reason for the thin-dispatcher rename (Task 2) and bind-before-import (Task 3) — called out in Global Constraints so implementers don't "simplify" it away.
- **Type consistency:** `createMcpServer/runStandalone/runInitAgentKit/SERVER_PACKAGE_INFO/PERSISTENCE_FILE` (Task 2) are consumed with identical names in Tasks 3 and 5; `ensureDaemon/checkDaemonHealth/DaemonHealth/EnsureDaemonOptions` (Task 4) consumed identically in Tasks 5 and 7; `routedTo: "daemon-http"` consistent between Task 7 code and test.
