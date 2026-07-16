# Agent Clock-In / Clock-Out Implementation Plan

> **SUPERSEDED 2026-07-16 — do not execute this plan.** Never started (every step below is still unchecked); its spec's safety argument no longer holds now that the single-writer daemon exists. See [`docs/superpowers/specs/2026-07-16-per-connection-mcp-sessions-design.md`](../specs/2026-07-16-per-connection-mcp-sessions-design.md) for the replacement design; a new plan will be written from that spec instead.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent "clock in" once (`agent_clock_in`) so subsequent memory writes in the same server process default to that agent_id/session_id instead of requiring it on every call, and "clock out" automatically (via a `kind:handoff` tag write or a `close_task` call) or explicitly (`agent_clock_out`).

**Architecture:** A single module-level, in-memory `activeAgentSession` variable in `src/index.ts` (safe because each MCP client gets its own `StdioServerTransport` process — confirmed at `src/index.ts:7055`, no shared daemon). Two new MCP tools mutate it. Existing agent-resolution choke points (`resolveStoredAgentId`, plus three tool handlers that resolve `agent_id`/`session_id` inline) consult it as a fallback tier between the caller's explicit argument and the existing `DEFAULT_AGENT_ID`/unset default.

**Tech Stack:** TypeScript (compiled via `tsc` to `build/`), `@modelcontextprotocol/sdk`, Node's built-in `node:test` + `node:assert/strict` for tests (spawns the compiled server over stdio JSON-RPC — no test framework dependency).

## Global Constraints

- Spec source of truth: `docs/superpowers/specs/2026-07-08-agent-clock-in-clock-out-design.md`.
- Build-and-serve-locally only. No CHANGELOG/version bump, no release step — this is not part of a 0.4.0 release cut.
- `update_memory`'s `memory_agent_id` repair-only field must NEVER consult `activeAgentSession`. It stays explicit-argument-only in every task.
- All new/changed tool responses must remain backward compatible: when `activeAgentSession` is `undefined` (never clocked in, or clocked out), every touched tool must behave byte-for-byte as it does today. Every task's tests include this "clocked-out / no session" regression case.
- Run `npm test` (= `npm run build && node --test`) after every task. All existing tests must keep passing.
- Tags follow this repo's `topic:`/`scope:`/`kind:`/`layer:` convention (see any existing test's `tags:` arrays for examples).

---

### Task 1: Active-session state, `agent_clock_in`, `agent_clock_out`, and `server_handshake` visibility

**Files:**
- Modify: `src/index.ts` (new module state + two new tools + `server_handshake` case)
- Create: `test/agent-clock-in-out.test.mjs`

**Interfaces:**
- Produces: module-level `let activeAgentSession: ActiveAgentSession | undefined`, `function getActiveSessionAgentId(): string | undefined`, `function getActiveSessionSessionId(): string | undefined`. Later tasks read these three names exactly.
- Produces: MCP tools `agent_clock_in` (input: `agent_id` required string, `session_id` optional string) and `agent_clock_out` (input: none).

- [ ] **Step 1: Add the active-session state and accessor helpers**

Open `src/index.ts` and find `function resolveStoredAgentId` (currently reads, at the time of writing, around line 4619):

```ts
function resolveStoredAgentId(agentId: string | undefined | null, fieldPath = "agent_id"): string {
  return normalizeOptionalAgentId(agentId, fieldPath) ?? DEFAULT_AGENT_ID;
}
```

Replace it with (adding the new state and helpers immediately above it):

```ts
interface ActiveAgentSession {
  agent_id: string;
  session_id: string;
  clocked_in_at: Date;
}

let activeAgentSession: ActiveAgentSession | undefined;

function getActiveSessionAgentId(): string | undefined {
  return activeAgentSession?.agent_id;
}

function getActiveSessionSessionId(): string | undefined {
  return activeAgentSession?.session_id;
}

function resolveStoredAgentId(agentId: string | undefined | null, fieldPath = "agent_id"): string {
  return normalizeOptionalAgentId(agentId, fieldPath) ?? getActiveSessionAgentId() ?? DEFAULT_AGENT_ID;
}
```

This one change already upgrades every existing caller of `resolveStoredAgentId` (`storeMemory`, `distillMemory`, `shareMemory` methods) — they get the active-session fallback for free. Later tasks add explicit tests for that.

- [ ] **Step 2: Register the `agent_clock_in` and `agent_clock_out` tool schemas**

Find `function buildRegisteredToolDescriptors` and the `close_task` schema entry at the end of its returned array (currently ends with the `close_task` object followed by `];`):

```ts
      {
        name: "close_task",
        description: "Transition a task memory to closed state. Idempotent: repeated calls on an already-closed task return a stable 'already closed' result without mutation. Returns a deterministic error when the task is not in a closable state.",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "ID of the task memory to close"
            },
            agent_id: {
              type: "string",
              description: "Optional caller agent identifier"
            }
          },
          required: ["memory_id"]
        }
      }
    ];
}
```

Replace with (adding two new entries before the closing `];`):

```ts
      {
        name: "close_task",
        description: "Transition a task memory to closed state. Idempotent: repeated calls on an already-closed task return a stable 'already closed' result without mutation. Returns a deterministic error when the task is not in a closable state.",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "ID of the task memory to close"
            },
            agent_id: {
              type: "string",
              description: "Optional caller agent identifier"
            }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "agent_clock_in",
        description: "Start an attribution session: subsequent memory writes in this server process default to the given agent_id (and session_id) unless overridden per-call. Calling again while a session is active overwrites it and returns a warning.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: {
              type: "string",
              description: "Agent identifier to attribute subsequent writes to"
            },
            session_id: {
              type: "string",
              description: "Optional session identifier; auto-minted if omitted"
            }
          },
          required: ["agent_id"]
        }
      },
      {
        name: "agent_clock_out",
        description: "End the current attribution session, if any. Idempotent: calling with no active session returns a stable 'already clocked out' result.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ];
}
```

- [ ] **Step 3: Add tool-usage-hint entries**

Find `function toolWhenToUseHint` and its `case "close_task": return "Use to idempotently close a completed or published task memory.";` line. Add two new cases directly after it:

```ts
    case "close_task":
      return "Use to idempotently close a completed or published task memory.";
    case "agent_clock_in":
      return "Use once at the start of a task to set the default agent_id/session_id for subsequent memory writes.";
    case "agent_clock_out":
      return "Use to explicitly end the current attribution session before its automatic triggers would fire.";
```

- [ ] **Step 4: Add the `case "agent_clock_in"` and `case "agent_clock_out"` handlers**

Find `case "close_task": {` in the `CallToolRequestSchema` handler switch and its closing `}` right before `default:`. Insert the two new cases between the end of the `close_task` case block and `default:`:

```ts
    case "agent_clock_in": {
      const { agent_id, session_id } = request.params.arguments as any;
      try {
        const normalizedAgentId = normalizeOptionalAgentId(agent_id);
        if (!normalizedAgentId) {
          throw createNMError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "agent_id is required for agent_clock_in.",
            "Provide a non-empty agent_id and retry agent_clock_in.",
          );
        }

        let normalizedSessionId: string;
        if (session_id !== undefined) {
          const candidate = normalizeSessionId(session_id);
          if (!candidate) {
            throw createNMError(
              NM_ERRORS.INPUT_VALIDATION_FAILED,
              "Invalid session_id: must be a non-empty string.",
              "Provide a valid session_id or omit it to auto-mint one.",
            );
          }
          validateSessionId(candidate);
          normalizedSessionId = candidate;
        } else {
          normalizedSessionId = `session-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        }

        const previous = activeAgentSession;
        activeAgentSession = {
          agent_id: normalizedAgentId,
          session_id: normalizedSessionId,
          clocked_in_at: new Date(),
        };

        const warningLine = previous
          ? `\n⚠️ Replaced previous active session (agent: ${previous.agent_id}, session: ${previous.session_id}).`
          : "";

        return {
          content: [{
            type: "text",
            text: `🕐 Clocked in as agent '${normalizedAgentId}' (session: ${normalizedSessionId}).\nMemory writes in this session default to this attribution unless overridden per-call.${warningLine}`,
          }],
        };
      } catch (error) {
        return toolErrorResult(
          "agent_clock_in",
          "Failed to clock in",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "agent_clock_in request was invalid.",
            "Provide a valid agent_id (and optional session_id), then retry agent_clock_in.",
          ),
        );
      }
    }

    case "agent_clock_out": {
      try {
        if (!activeAgentSession) {
          return {
            content: [{
              type: "text",
              text: "🕐 agent_clock_out: already clocked out — no changes made.",
            }],
          };
        }

        const closedSession = activeAgentSession;
        activeAgentSession = undefined;
        const durationMs = Date.now() - closedSession.clocked_in_at.getTime();

        return {
          content: [{
            type: "text",
            text: `🕐 Clocked out agent '${closedSession.agent_id}' (session: ${closedSession.session_id}).\nSession duration: ${durationMs}ms.`,
          }],
        };
      } catch (error) {
        return toolErrorResult(
          "agent_clock_out",
          "Failed to clock out",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "agent_clock_out request was invalid.",
            "Retry agent_clock_out.",
          ),
        );
      }
    }

```

- [ ] **Step 5: Add `server_handshake` active-session visibility**

Find the `case "server_handshake"` block's returned text array:

```ts
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
            quickstart,
          ].join("\n"),
        }],
      };
```

Replace with (adding one line before `quickstart`):

```ts
      const sessionLine = activeAgentSession
        ? `Active session: agent_id=${activeAgentSession.agent_id}, session_id=${activeAgentSession.session_id}, clocked in ${Date.now() - activeAgentSession.clocked_in_at.getTime()}ms ago`
        : "Active session: none (clocked out)";

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
```

- [ ] **Step 6: Write the test file**

Create `test/agent-clock-in-out.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-clock-test-"));

  fs.mkdirSync(tempDir, { recursive: true });

  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_LOG_LEVEL: "error",
      ...(options.env ?? {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  let buffer = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");

      if (!line) continue;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.id !== undefined && pending.has(parsed.id)) {
        const resolver = pending.get(parsed.id);
        pending.delete(parsed.id);
        resolver(parsed);
      }
    }
  });

  function callTool(id, name, args) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to request ${id}`));
      }, 15000);

      pending.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      })}\n`);
    });
  }

  function stop() {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { callTool, stop };
}

function resultText(response) {
  return response.result?.content?.[0]?.text ?? "";
}

test("agent_clock_in requires a non-empty agent_id", async () => {
  const server = startServer();
  try {
    const response = await server.callTool(1, "agent_clock_in", {});
    assert.match(resultText(response), /agent_id is required for agent_clock_in/);
  } finally {
    server.stop();
  }
});

test("agent_clock_in auto-mints a session_id when omitted", async () => {
  const server = startServer();
  try {
    const response = await server.callTool(1, "agent_clock_in", { agent_id: "agent-a" });
    const text = resultText(response);
    assert.match(text, /Clocked in as agent 'agent-a'/);
    assert.match(text, /session: session-\d+-[a-f0-9]{8}/);
  } finally {
    server.stop();
  }
});

test("agent_clock_in accepts an explicit session_id", async () => {
  const server = startServer();
  try {
    const response = await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "my-session-1" });
    assert.match(resultText(response), /session: my-session-1/);
  } finally {
    server.stop();
  }
});

test("agent_clock_in twice overwrites and warns", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const second = await server.callTool(2, "agent_clock_in", { agent_id: "agent-b", session_id: "session-b" });
    const text = resultText(second);
    assert.match(text, /Clocked in as agent 'agent-b'/);
    assert.match(text, /Replaced previous active session \(agent: agent-a, session: session-a\)/);
  } finally {
    server.stop();
  }
});

test("agent_clock_out clears an active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const response = await server.callTool(2, "agent_clock_out", {});
    assert.match(resultText(response), /Clocked out agent 'agent-a' \(session: session-a\)/);
  } finally {
    server.stop();
  }
});

test("agent_clock_out is idempotent when nothing is active", async () => {
  const server = startServer();
  try {
    const response = await server.callTool(1, "agent_clock_out", {});
    assert.match(resultText(response), /already clocked out/);
  } finally {
    server.stop();
  }
});

test("server_handshake reports no active session by default", async () => {
  const server = startServer();
  try {
    const response = await server.callTool(1, "server_handshake", {});
    assert.match(resultText(response), /Active session: none \(clocked out\)/);
  } finally {
    server.stop();
  }
});

test("server_handshake reports the active session after clock-in", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const response = await server.callTool(2, "server_handshake", {});
    assert.match(resultText(response), /Active session: agent_id=agent-a, session_id=session-a, clocked in \d+ms ago/);
  } finally {
    server.stop();
  }
});
```

- [ ] **Step 7: Build and run the new tests**

Run: `npm test`
Expected: all tests in `test/agent-clock-in-out.test.mjs` PASS, and no existing test regresses.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts test/agent-clock-in-out.test.mjs
git commit -m "feat: add agent_clock_in/agent_clock_out tools and active-session state"
```

---

### Task 2: `store_memory` inherits agent_id and session_id from the active session

**Files:**
- Modify: `src/index.ts` (`storeMemory` method's `session_id` handling)
- Modify: `test/agent-clock-in-out.test.mjs`

**Interfaces:**
- Consumes: `getActiveSessionAgentId()`, `getActiveSessionSessionId()`, `resolveStoredAgentId()` from Task 1.
- Note: `resolveStoredAgentId` already gained the active-session tier in Task 1, so `storeMemory`'s `agent_id` inheritance requires no further code change — this task adds its test coverage plus the `session_id` code change (which had no prior fallback at all).

- [ ] **Step 1: Add the failing test for session_id inheritance first**

Append to `test/agent-clock-in-out.test.mjs`:

```js
test("store_memory inherits agent_id and session_id from the active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "memory written while clocked in",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    const retrieved = await server.callTool(3, "retrieve_memory", { memory_id: "memory_1" });
    const text = resultText(retrieved);
    assert.match(text, /Agent: agent-a/);
  } finally {
    server.stop();
  }
});

test("store_memory explicit agent_id/session_id still overrides the active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const stored = await server.callTool(2, "store_memory", {
      content: "memory with explicit override",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      agent_id: "explicit-agent",
      session_id: "explicit-session",
    });
    const text = resultText(stored);
    assert.match(text, /Agent: explicit-agent/);
    assert.match(text, /Session: explicit-session/);
  } finally {
    server.stop();
  }
});

test("store_memory without clock-in still defaults to unassigned/unset", async () => {
  const server = startServer();
  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "memory with no session active",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    const text = resultText(stored);
    assert.match(text, /Agent: unassigned/);
    assert.match(text, /Session: unset/);
  } finally {
    server.stop();
  }
});
```

- [ ] **Step 2: Run tests to verify the session_id assertion fails**

Run: `npm test`
Expected: `store_memory inherits agent_id and session_id from the active session` FAILS at the `Session:` assertion (there's no such line yet in `store_memory`'s response until Step 3's code lands — check the `retrieve_memory` response text used in this test; if it doesn't print `Session:` at all, adjust the assertion to check `memory_stats` instead — see note in Step 3).

Note: `retrieve_memory`'s response text (see `src/index.ts` `case "retrieve_memory"`) does not currently include a `Session:` line. Use `memory_stats` to verify session inheritance instead — replace the first new test's body with:

```js
test("store_memory inherits agent_id and session_id from the active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const stored = await server.callTool(2, "store_memory", {
      content: "memory written while clocked in",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    const text = resultText(stored);
    assert.match(text, /Agent: agent-a/);
    assert.match(text, /Session: session-a/);
  } finally {
    server.stop();
  }
});
```

(`store_memory`'s own response text already includes both `Agent:` and `Session:` lines — see the `text:` template in `case "store_memory"` — so no `memory_stats` detour is needed; assert directly against the `store_memory` response.)

- [ ] **Step 3: Implement the session_id fallback**

Find, inside the `storeMemory` method:

```ts
    let normalizedSessionId: string | undefined = undefined;
    if (session_id !== undefined) {
      normalizedSessionId = normalizeSessionId(session_id);
      if (!normalizedSessionId) {
        throw createNMError(
          NM_ERRORS.INPUT_VALIDATION_FAILED,
          `Invalid session_id after normalization: ${session_id}`,
          "session_id must normalize to a non-empty canonical value."
        );
      }
      validateSessionId(normalizedSessionId);
    }
```

Replace with:

```ts
    let normalizedSessionId: string | undefined = undefined;
    if (session_id !== undefined) {
      normalizedSessionId = normalizeSessionId(session_id);
      if (!normalizedSessionId) {
        throw createNMError(
          NM_ERRORS.INPUT_VALIDATION_FAILED,
          `Invalid session_id after normalization: ${session_id}`,
          "session_id must normalize to a non-empty canonical value."
        );
      }
      validateSessionId(normalizedSessionId);
    } else {
      normalizedSessionId = getActiveSessionSessionId();
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all three new tests PASS, no existing test regresses.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/agent-clock-in-out.test.mjs
git commit -m "feat: store_memory inherits session_id from the active clock-in session"
```

---

### Task 3: `connect_memories`, `distill_memory`, `share_memory` inherit `agent_id`

**Files:**
- Modify: `src/index.ts` (`case "connect_memories"` handler only — `distill_memory`/`share_memory` already route through `resolveStoredAgentId` from Task 1)
- Modify: `test/agent-clock-in-out.test.mjs`

**Interfaces:**
- Consumes: `resolveStoredAgentId()` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-clock-in-out.test.mjs`:

```js
test("connect_memories inherits agent_id from the active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "first node",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    await server.callTool(3, "store_memory", {
      content: "second node",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });
    const connected = await server.callTool(4, "connect_memories", {
      memory_id_1: "memory_1",
      memory_id_2: "memory_2",
    });
    assert.match(resultText(connected), /Agent: agent-a/);
  } finally {
    server.stop();
  }
});

test("connect_memories explicit agent_id still overrides the active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "first node",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    await server.callTool(3, "store_memory", {
      content: "second node",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });
    const connected = await server.callTool(4, "connect_memories", {
      memory_id_1: "memory_1",
      memory_id_2: "memory_2",
      agent_id: "explicit-connector",
    });
    assert.match(resultText(connected), /Agent: explicit-connector/);
  } finally {
    server.stop();
  }
});

test("distill_memory inherits agent_id from the active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "emotional memory to distill",
      district: "emotional_processing",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    const distilled = await server.callTool(3, "distill_memory", { memory_id: "memory_1" });
    const text = resultText(distilled);
    const match = text.match(/Created distilled memory:\s*(memory_\d+)/);
    assert.ok(match, `expected a "Created distilled memory:" line in: ${text}`);
    const retrieved = await server.callTool(4, "retrieve_memory", { memory_id: match[1] });
    assert.match(resultText(retrieved), /Agent: agent-a/);
  } finally {
    server.stop();
  }
});

test("share_memory inherits agent_id from the active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "memory to be shared",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    const shared = await server.callTool(3, "share_memory", {
      memory_id: "memory_1",
      target_agent_id: "recipient-agent",
    });
    const text = resultText(shared);
    const match = text.match(/Provenance record:\s*(memory_\d+)/);
    assert.ok(match, `expected a provenance record line in: ${text}`);
    const provenance = await server.callTool(4, "retrieve_memory", { memory_id: match[1] });
    assert.match(resultText(provenance), /Agent: agent-a/);
    assert.match(resultText(provenance), /shared by agent agent-a/);
  } finally {
    server.stop();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail correctly**

Run: `npm test`
Expected: `connect_memories inherits agent_id from the active session` FAILS (still shows `Agent: unassigned`, since Step 3 hasn't landed). The `distill_memory` and `share_memory` tests should already PASS (both already route through `resolveStoredAgentId` as of Task 1).

- [ ] **Step 3: Update the `connect_memories` handler**

Find `case "connect_memories": {`:

```ts
    case "connect_memories": {
      const { memory_id_1, memory_id_2, bidirectional = true, agent_id } = request.params.arguments as any;

      try {
        const normalizedAgentId = normalizeOptionalAgentId(agent_id);
        await runMutatingTool(
          "connect_memories",
          () => memorySystem.connectMemories(memory_id_1, memory_id_2, bidirectional, normalizedAgentId),
        );
        return {
          content: [{
            type: "text",
            text: `🔗 Connected memories ${memory_id_1} and ${memory_id_2}${bidirectional ? ' (bidirectional)' : ' (unidirectional)'}\nAgent: ${normalizedAgentId ?? DEFAULT_AGENT_ID}`
          }]
        };
```

Replace with:

```ts
    case "connect_memories": {
      const { memory_id_1, memory_id_2, bidirectional = true, agent_id } = request.params.arguments as any;

      try {
        const normalizedAgentId = resolveStoredAgentId(agent_id);
        await runMutatingTool(
          "connect_memories",
          () => memorySystem.connectMemories(memory_id_1, memory_id_2, bidirectional, normalizedAgentId),
        );
        return {
          content: [{
            type: "text",
            text: `🔗 Connected memories ${memory_id_1} and ${memory_id_2}${bidirectional ? ' (bidirectional)' : ' (unidirectional)'}\nAgent: ${normalizedAgentId}`
          }]
        };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all new tests PASS. Existing tests `connect_memories remains backward-compatible without agent_id` and `connect_memories rejects blank agent_id values` (in `test/agent-identity.test.mjs`) still PASS unchanged — `resolveStoredAgentId` still throws on a blank string and still falls back to `DEFAULT_AGENT_ID` when nothing is active, matching prior behavior exactly.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/agent-clock-in-out.test.mjs
git commit -m "feat: connect_memories inherits agent_id from the active clock-in session"
```

---

### Task 4: `retrieve_memory`, `update_memory`, `close_task` inherit `agent_id` for actor/telemetry attribution

**Files:**
- Modify: `src/index.ts` (`case "retrieve_memory"`, `case "update_memory"`, `case "close_task"`)
- Modify: `test/agent-clock-in-out.test.mjs`

**Interfaces:**
- Consumes: `getActiveSessionAgentId()` from Task 1.

**Scope note:** unlike Task 2/3's authorship fields, these three tools use `agent_id` purely for internal loop-telemetry/actor attribution — none of their response text currently surfaces which `agent_id` was used (confirmed by reading each handler and the `MemoryNPC`/telemetry code paths). There is no external, observable signal to assert a positive behavioral proof against without adding new instrumentation, which is out of scope. This task's tests therefore verify wiring correctness and non-regression: explicit `agent_id` still behaves exactly as before, and omitting it still doesn't error, both clocked in and clocked out.

- [ ] **Step 1: Write the wiring/non-regression tests**

Append to `test/agent-clock-in-out.test.mjs`:

```js
test("retrieve_memory still accepts an explicit agent_id while clocked in", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "memory for retrieve telemetry check",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    const retrieved = await server.callTool(3, "retrieve_memory", { memory_id: "memory_1", agent_id: "explicit-reader" });
    assert.match(resultText(retrieved), /Retrieved memory/);
  } finally {
    server.stop();
  }
});

test("retrieve_memory omitting agent_id does not error while clocked in", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "memory for retrieve default check",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    const retrieved = await server.callTool(3, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Retrieved memory/);
  } finally {
    server.stop();
  }
});

test("update_memory omitting agent_id does not error while clocked in", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "memory for update telemetry check",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    const updated = await server.callTool(3, "update_memory", { memory_id: "memory_1", content: "updated content" });
    assert.match(resultText(updated), /Updated memory/);
  } finally {
    server.stop();
  }
});

test("close_task omitting agent_id does not error while clocked in", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const created = await server.callTool(2, "store_memory", {
      content: "task to close",
      district: "practical_execution",
      tags: ["kind:task", "topic:test"],
    });
    const idMatch = resultText(created).match(/ID:\s*(memory_\d+)/);
    assert.ok(idMatch, `expected an ID line in: ${resultText(created)}`);
    await server.callTool(3, "publish_task", { memory_id: idMatch[1], completed: true, last_step: "done" });
    await server.callTool(4, "update_memory", { memory_id: idMatch[1], publication_state: "closable" });
    const closed = await server.callTool(5, "close_task", { memory_id: idMatch[1] });
    assert.match(resultText(closed), /lifecycle_state: closed/);
  } finally {
    server.stop();
  }
});
```

Note: task lifecycle transitions are `draft → published_partial|published_complete → closable → closed` (see `VALID_PUBLICATION_TRANSITIONS` in `src/index.ts`) — `draft` cannot go directly to `closable`, hence the `publish_task` call before `update_memory({ publication_state: "closable" })` in every close_task test in this plan.

- [ ] **Step 2: Run tests to verify current behavior**

Run: `npm test`
Expected: all four new tests PASS already (omitting `agent_id` doesn't error today either — these are non-regression baselines, not proof of inheritance). Confirm this before proceeding so Step 3's diff is provably behavior-preserving.

- [ ] **Step 3: Wire the active-session fallback into all three handlers**

In `case "retrieve_memory": {`, find:

```ts
      const { memory_id, district, agent_id } = request.params.arguments as any;
      const retrieval = memorySystem.retrieveMemory(memory_id, { district, agent_id });
```

Replace with:

```ts
      const { memory_id, district, agent_id } = request.params.arguments as any;
      const effectiveAgentId = agent_id ?? getActiveSessionAgentId();
      const retrieval = memorySystem.retrieveMemory(memory_id, { district, agent_id: effectiveAgentId });
```

In `case "update_memory": {`, find:

```ts
        const normalizedActorAgentId = normalizeOptionalAgentId(agent_id);
        const updates: MemoryUpdatePayload = {};
```

Replace with:

```ts
        const normalizedActorAgentId = normalizeOptionalAgentId(agent_id) ?? getActiveSessionAgentId();
        const updates: MemoryUpdatePayload = {};
```

In `case "close_task": {`, find:

```ts
        const normalizedActorAgentId = normalizeOptionalAgentId(agent_id);
        await runMutatingTool("close_task", () => memorySystem.updateMemory(
```

Replace with:

```ts
        const normalizedActorAgentId = normalizeOptionalAgentId(agent_id) ?? getActiveSessionAgentId();
        await runMutatingTool("close_task", () => memorySystem.updateMemory(
```

- [ ] **Step 4: Run tests to verify no regression**

Run: `npm test`
Expected: all four new tests still PASS, and the full existing suite (`npm test`) still passes with zero regressions — in particular re-check `test/agent-identity.test.mjs`'s `update_memory can repair unassigned agent attribution exactly once` still passes (it uses `memory_agent_id`, which this task does not touch).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/agent-clock-in-out.test.mjs
git commit -m "feat: retrieve_memory/update_memory/close_task inherit actor agent_id from the active session"
```

---

### Task 5: Tag-based auto-clock-out (`kind:handoff`)

**Files:**
- Modify: `src/index.ts` (new `hasHandoffTag` helper; `case "store_memory"` and `case "update_memory"` response paths)
- Modify: `test/agent-clock-in-out.test.mjs`

**Interfaces:**
- Consumes: `activeAgentSession` (direct read/write), from Task 1.
- Produces: `function hasHandoffTag(tags: string[] = []): boolean`. Task 6 does not consume it (close_task's auto-clock-out doesn't check tags), but keep the name in mind for review — it's this task's tag-detection primitive, not a shared trigger.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-clock-in-out.test.mjs`:

```js
test("store_memory with kind:handoff tag auto-clocks-out an active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const stored = await server.callTool(2, "store_memory", {
      content: "end of session handoff note",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:handoff", "layer:implementation"],
    });
    assert.match(resultText(stored), /Auto-clocked-out agent 'agent-a' \(handoff tag detected\)/);

    const handshake = await server.callTool(3, "server_handshake", {});
    assert.match(resultText(handshake), /Active session: none \(clocked out\)/);
  } finally {
    server.stop();
  }
});

test("store_memory with kind:handoff tag is a no-op auto-clock-out when nothing is active", async () => {
  const server = startServer();
  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "handoff note with no active session",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:handoff", "layer:implementation"],
    });
    assert.doesNotMatch(resultText(stored), /Auto-clocked-out/);
  } finally {
    server.stop();
  }
});

test("update_memory adding kind:handoff tag auto-clocks-out an active session", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    await server.callTool(2, "store_memory", {
      content: "note to become a handoff",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });
    const updated = await server.callTool(3, "update_memory", {
      memory_id: "memory_1",
      tags: ["topic:test", "scope:session", "kind:handoff", "layer:implementation"],
    });
    assert.match(resultText(updated), /Auto-clocked-out agent 'agent-a' \(handoff tag detected\)/);
  } finally {
    server.stop();
  }
});

test("store_memory without kind:handoff tag does not auto-clock-out", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const stored = await server.callTool(2, "store_memory", {
      content: "ordinary note, not a handoff",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });
    assert.doesNotMatch(resultText(stored), /Auto-clocked-out/);
    const handshake = await server.callTool(3, "server_handshake", {});
    assert.match(resultText(handshake), /Active session: agent_id=agent-a/);
  } finally {
    server.stop();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the three tests expecting `Auto-clocked-out` FAIL (no such text is produced yet). The other two PASS already.

- [ ] **Step 3: Add the `hasHandoffTag` helper**

Find `function hasTaskTag(tags: string[] = []): boolean {` in `src/index.ts` and add a new function directly after its closing brace:

```ts
function hasHandoffTag(tags: string[] = []): boolean {
  return tags.map(normalizeTag).includes("kind:handoff");
}
```

- [ ] **Step 4: Wire the hook into `store_memory`'s response path**

Find, in `case "store_memory": {`:

```ts
        const memory = storeResult.memory;
        const warningLine = wipWarning ? `\n${wipWarning}` : "";
```

Replace with:

```ts
        const memory = storeResult.memory;
        let autoClockOutLine = "";
        if (activeAgentSession && hasHandoffTag(memory.tags)) {
          const closedSession = activeAgentSession;
          activeAgentSession = undefined;
          autoClockOutLine = `\n🕐 Auto-clocked-out agent '${closedSession.agent_id}' (handoff tag detected).`;
        }
        const warningLine = wipWarning ? `\n${wipWarning}` : "";
```

Then find the `return` statement immediately below in the same case block:

```ts
        return {
          content: [{
            type: "text",
            text: `🧠 Stored memory "${memory.name}" in ${districtLabel}${inferredNote}\nID: ${memory.id}\nArchetype: ${memory.archetype}\nAgent: ${memory.agent_id ?? "unassigned"}\nProject: ${memory.project_id ?? "unset"}\nSession: ${memory.session_id ?? "unset"}\nStatus: ${memory.status ?? "unset"}\nEpistemic status: ${memory.epistemic_status ?? "unset"}\nVisibility: ${memory.visibility ?? "private"}\n${repeatLines}${warningLine}${repeatWarningLine}${cooldownLine}`
          }]
        };
```

Replace with (appending `${autoClockOutLine}` at the end of the template string):

```ts
        return {
          content: [{
            type: "text",
            text: `🧠 Stored memory "${memory.name}" in ${districtLabel}${inferredNote}\nID: ${memory.id}\nArchetype: ${memory.archetype}\nAgent: ${memory.agent_id ?? "unassigned"}\nProject: ${memory.project_id ?? "unset"}\nSession: ${memory.session_id ?? "unset"}\nStatus: ${memory.status ?? "unset"}\nEpistemic status: ${memory.epistemic_status ?? "unset"}\nVisibility: ${memory.visibility ?? "private"}\n${repeatLines}${warningLine}${repeatWarningLine}${cooldownLine}${autoClockOutLine}`
          }]
        };
```

- [ ] **Step 5: Wire the hook into `update_memory`'s response path**

Find, in `case "update_memory": {`:

```ts
        const memory = updateResult.memory;
        const cooldownLine = updateResult.cooldown_duration_ms
          ? `\n${memorySystem.buildCrossDistrictCooldownWarning(memory_id, updateResult.cooldown_duration_ms)}`
          : "";
        return {
          content: [{
            type: "text",
            text: `✏️ Updated memory "${memory.name}" (${memory_id})\nDistrict: ${memory.district}\nAgent: ${memory.agent_id ?? DEFAULT_AGENT_ID}\nProject: ${memory.project_id ?? 'unset'}\nSession: ${memory.session_id ?? 'unset'}\nStatus: ${memory.status ?? 'unset'}\nEpistemic status: ${memory.epistemic_status ?? 'unset'}\nVisibility: ${memory.visibility ?? 'private'}\nTags: ${memory.tags.join(', ')}${cooldownLine}`
          }]
        };
```

Replace with:

```ts
        const memory = updateResult.memory;
        const cooldownLine = updateResult.cooldown_duration_ms
          ? `\n${memorySystem.buildCrossDistrictCooldownWarning(memory_id, updateResult.cooldown_duration_ms)}`
          : "";
        let autoClockOutLine = "";
        if (activeAgentSession && hasHandoffTag(memory.tags)) {
          const closedSession = activeAgentSession;
          activeAgentSession = undefined;
          autoClockOutLine = `\n🕐 Auto-clocked-out agent '${closedSession.agent_id}' (handoff tag detected).`;
        }
        return {
          content: [{
            type: "text",
            text: `✏️ Updated memory "${memory.name}" (${memory_id})\nDistrict: ${memory.district}\nAgent: ${memory.agent_id ?? DEFAULT_AGENT_ID}\nProject: ${memory.project_id ?? 'unset'}\nSession: ${memory.session_id ?? 'unset'}\nStatus: ${memory.status ?? 'unset'}\nEpistemic status: ${memory.epistemic_status ?? 'unset'}\nVisibility: ${memory.visibility ?? 'private'}\nTags: ${memory.tags.join(', ')}${cooldownLine}${autoClockOutLine}`
          }]
        };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: all five tests from Step 1 PASS. Full suite still green.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/agent-clock-in-out.test.mjs
git commit -m "feat: auto-clock-out on kind:handoff tagged store_memory/update_memory writes"
```

---

### Task 6: `close_task`-based auto-clock-out

**Files:**
- Modify: `src/index.ts` (`case "close_task"` success path)
- Modify: `test/agent-clock-in-out.test.mjs`

**Interfaces:**
- Consumes: `activeAgentSession` (direct read/write), from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-clock-in-out.test.mjs`:

```js
test("close_task auto-clocks-out an active session on successful close", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "agent_clock_in", { agent_id: "agent-a", session_id: "session-a" });
    const created = await server.callTool(2, "store_memory", {
      content: "task to close for clock-out test",
      district: "practical_execution",
      tags: ["kind:task", "topic:test"],
    });
    const idMatch = resultText(created).match(/ID:\s*(memory_\d+)/);
    assert.ok(idMatch, `expected an ID line in: ${resultText(created)}`);
    await server.callTool(3, "publish_task", { memory_id: idMatch[1], completed: true, last_step: "done" });
    await server.callTool(4, "update_memory", { memory_id: idMatch[1], publication_state: "closable" });

    const closed = await server.callTool(5, "close_task", { memory_id: idMatch[1] });
    assert.match(resultText(closed), /Auto-clocked-out agent 'agent-a' \(close_task\)/);

    const handshake = await server.callTool(6, "server_handshake", {});
    assert.match(resultText(handshake), /Active session: none \(clocked out\)/);
  } finally {
    server.stop();
  }
});

test("close_task on an already-closed task does not re-trigger auto-clock-out", async () => {
  const server = startServer();
  try {
    const created = await server.callTool(1, "store_memory", {
      content: "task closed before any clock-in",
      district: "practical_execution",
      tags: ["kind:task", "topic:test"],
    });
    const idMatch = resultText(created).match(/ID:\s*(memory_\d+)/);
    assert.ok(idMatch, `expected an ID line in: ${resultText(created)}`);
    await server.callTool(2, "publish_task", { memory_id: idMatch[1], completed: true, last_step: "done" });
    await server.callTool(3, "update_memory", { memory_id: idMatch[1], publication_state: "closable" });
    await server.callTool(4, "close_task", { memory_id: idMatch[1] });

    await server.callTool(5, "agent_clock_in", { agent_id: "agent-b", session_id: "session-b" });
    const secondClose = await server.callTool(6, "close_task", { memory_id: idMatch[1] });
    assert.match(resultText(secondClose), /already closed/);
    assert.doesNotMatch(resultText(secondClose), /Auto-clocked-out/);

    const handshake = await server.callTool(7, "server_handshake", {});
    assert.match(resultText(handshake), /Active session: agent_id=agent-b/);
  } finally {
    server.stop();
  }
});

test("close_task with no active session closes normally without an auto-clock-out line", async () => {
  const server = startServer();
  try {
    const created = await server.callTool(1, "store_memory", {
      content: "task closed with nobody clocked in",
      district: "practical_execution",
      tags: ["kind:task", "topic:test"],
    });
    const idMatch = resultText(created).match(/ID:\s*(memory_\d+)/);
    assert.ok(idMatch, `expected an ID line in: ${resultText(created)}`);
    await server.callTool(2, "publish_task", { memory_id: idMatch[1], completed: true, last_step: "done" });
    await server.callTool(3, "update_memory", { memory_id: idMatch[1], publication_state: "closable" });

    const closed = await server.callTool(4, "close_task", { memory_id: idMatch[1] });
    assert.match(resultText(closed), /lifecycle_state: closed/);
    assert.doesNotMatch(resultText(closed), /Auto-clocked-out/);
  } finally {
    server.stop();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail correctly**

Run: `npm test`
Expected: `close_task auto-clocks-out an active session on successful close` FAILS (no `Auto-clocked-out` text yet). The other two PASS already (nothing to clock out in either case, so they're already correct — confirm this before Step 3).

- [ ] **Step 3: Wire the hook into `close_task`'s success path**

Find, in `case "close_task": {`, the successful-transition branch:

```ts
        const normalizedActorAgentId = normalizeOptionalAgentId(agent_id) ?? getActiveSessionAgentId();
        await runMutatingTool("close_task", () => memorySystem.updateMemory(
          memory_id,
          { publication_state: "closed" },
          { agent_id: normalizedActorAgentId },
        ));
        return {
          content: [{
            type: "text",
            text: [
              `🔒 close_task: ${currentState} → closed.`,
              `memory_id: ${memory_id}`,
              `lifecycle_state: closed`,
            ].join("\n"),
          }],
        };
```

Replace with:

```ts
        const normalizedActorAgentId = normalizeOptionalAgentId(agent_id) ?? getActiveSessionAgentId();
        await runMutatingTool("close_task", () => memorySystem.updateMemory(
          memory_id,
          { publication_state: "closed" },
          { agent_id: normalizedActorAgentId },
        ));

        let autoClockOutLine = "";
        if (activeAgentSession) {
          const closedSession = activeAgentSession;
          activeAgentSession = undefined;
          autoClockOutLine = `\n🕐 Auto-clocked-out agent '${closedSession.agent_id}' (close_task).`;
        }

        return {
          content: [{
            type: "text",
            text: [
              `🔒 close_task: ${currentState} → closed.`,
              `memory_id: ${memory_id}`,
              `lifecycle_state: closed`,
            ].join("\n") + autoClockOutLine,
          }],
        };
```

Note: this is inserted only in the branch that performs the real `draft/closable → closed` transition, not in the earlier idempotent "already closed" early-return branch a few lines above it (which must NOT trigger auto-clock-out, per the second test in Step 1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all three tests from Step 1 PASS. Full existing suite (including `test/task-lifecycle.test.mjs`) still green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/agent-clock-in-out.test.mjs
git commit -m "feat: auto-clock-out on successful close_task transitions"
```

---

## Final verification

- [ ] Run `npm test` one final time from a clean state and confirm the entire suite passes.
- [ ] Manually smoke-test locally: run `npm run build`, then start the server (e.g. via an MCP client config pointed at `build/index.js`) and call `agent_clock_in`, `store_memory` (no `agent_id`), `server_handshake`, `agent_clock_out` in sequence to see the real end-to-end flow once, since automated tests spawn fresh temp-dir servers per test and won't show you the cumulative experience of one long-lived session.
