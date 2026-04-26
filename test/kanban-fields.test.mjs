/**
 * Tests for Issue #112: Kanban workflow fields and tools
 * Covers: status/current_slice/why_now fields, kanban_view tool, update_status tool,
 * WIP guardrail enforcement for in_progress transitions.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "../build/index.js");

let serverProcess;
let buffer = "";
let seq = 0;

function sendRequest(method, params = {}) {
  const id = ++seq;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  serverProcess.stdin.write(msg + "\n");
  return waitForResponse(id);
}

function waitForResponse(id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for response id=${id}`)), timeoutMs);
    function tryParse() {
      const lines = buffer.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timer);
            buffer = lines.slice(i + 1).join("\n");
            serverProcess.stdout.removeListener("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          // not valid JSON yet
        }
      }
    }
    function onData(chunk) {
      buffer += chunk.toString();
      tryParse();
    }
    serverProcess.stdout.on("data", onData);
    tryParse();
  });
}

async function callTool(name, args = {}) {
  const res = await sendRequest("tools/call", { name, arguments: args });
  return res;
}

function getText(res) {
  return res?.result?.content?.[0]?.text ?? "";
}

before(async () => {
  serverProcess = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NM_PERSISTENCE_PATH: "", NM_DISABLE_WAL: "true", NM_WIP_LIMIT: "1" },
  });
  serverProcess.stderr.on("data", () => {}); // suppress stderr
  await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-kanban", version: "1.0.0" },
  });
});

after(() => {
  serverProcess.stdin.end();
  serverProcess.kill();
});

describe("kanban fields: store_memory with status", () => {
  it("stores a memory with status=in_progress and shows it in output", async () => {
    const res = await callTool("store_memory", {
      content: "Implement kanban fields for issue #112",
      district: "practical_execution",
      tags: ["kind:task", "topic:kanban"],
      status: "in_progress",
      current_slice: "add status field to types",
      why_now: "unblocked by session_id PR",
    });
    const text = getText(res);
    assert.match(text, /Status: in_progress/);
  });

  it("rejects invalid status", async () => {
    const res = await callTool("store_memory", {
      content: "Task with bad status",
      district: "practical_execution",
      tags: [],
      status: "flying",
    });
    const text = getText(res);
    assert.match(text, /[Ii]nvalid status/i);
  });

  it("stores a memory without status (status shows as unset)", async () => {
    const res = await callTool("store_memory", {
      content: "Backlog task without explicit status",
      district: "practical_execution",
      tags: ["kind:task"],
    });
    const text = getText(res);
    assert.match(text, /Status: unset/);
  });
});

describe("kanban_view tool", () => {
  it("returns memories grouped by lane", async () => {
    await callTool("store_memory", {
      content: "Ready task for kanban view test",
      district: "practical_execution",
      tags: ["kind:task"],
      status: "ready",
    });
    await callTool("store_memory", {
      content: "Blocked task for kanban view test",
      district: "practical_execution",
      tags: ["kind:task"],
      status: "blocked",
    });
    const res = await callTool("kanban_view", {});
    const text = getText(res);
    assert.match(text, /IN_PROGRESS/);
    assert.match(text, /READY/);
    assert.match(text, /BLOCKED/);
    assert.match(text, /Kanban View/);
  });

  it("shows current_slice and why_now in output", async () => {
    const res = await callTool("kanban_view", {});
    const text = getText(res);
    assert.match(text, /slice:/);
    assert.match(text, /why_now:/);
  });

  it("returns empty state message when no practical_execution memories", async () => {
    // Use a non-existent agent_id scope to get empty results
    const res = await callTool("kanban_view", { agent_id: "nonexistent_agent_xyz_99" });
    const text = getText(res);
    assert.match(text, /no practical_execution memories found/i);
  });
});

describe("update_status tool", () => {
  let memoryId;

  before(async () => {
    const res = await callTool("store_memory", {
      content: "Task to transition through kanban statuses",
      district: "practical_execution",
      tags: ["kind:task"],
      status: "backlog",
      agent_id: "test-agent-kanban",
    });
    const text = getText(res);
    const match = text.match(/ID: (memory_\d+)/);
    assert.ok(match, "Should extract memory ID from store response");
    memoryId = match[1];
  });

  it("transitions from backlog to ready", async () => {
    const res = await callTool("update_status", {
      memory_id: memoryId,
      status: "ready",
    });
    const text = getText(res);
    assert.match(text, /Status: ready/);
  });

  it("transitions to in_progress and sets current_slice", async () => {
    const res = await callTool("update_status", {
      memory_id: memoryId,
      status: "in_progress",
      current_slice: "writing the test cases",
      why_now: "PR is open and reviewer is waiting",
      agent_id: "test-agent-kanban",
    });
    const text = getText(res);
    assert.match(text, /Status: in_progress/);
    assert.match(text, /Current slice: writing the test cases/);
    assert.match(text, /Why now: PR is open and reviewer is waiting/);
  });

  it("rejects invalid status", async () => {
    const res = await callTool("update_status", {
      memory_id: memoryId,
      status: "not_a_status",
    });
    const text = getText(res);
    assert.match(text, /[Ii]nvalid status/i);
  });

  it("transitions to done", async () => {
    const res = await callTool("update_status", {
      memory_id: memoryId,
      status: "done",
    });
    const text = getText(res);
    assert.match(text, /Status: done/);
  });
});

describe("WIP guardrail via update_status", () => {
  let task1Id;
  let task2Id;

  before(async () => {
    // Store first task and move to in_progress
    const r1 = await callTool("store_memory", {
      content: "WIP guardrail test task 1",
      district: "practical_execution",
      tags: ["kind:task"],
      status: "ready",
      agent_id: "wip-agent",
    });
    const m1 = getText(r1).match(/ID: (memory_\d+)/);
    task1Id = m1?.[1];

    const r2 = await callTool("store_memory", {
      content: "WIP guardrail test task 2",
      district: "practical_execution",
      tags: ["kind:task"],
      status: "ready",
      agent_id: "wip-agent",
    });
    const m2 = getText(r2).match(/ID: (memory_\d+)/);
    task2Id = m2?.[1];

    // Move task1 to in_progress (uses the 1 WIP slot)
    await callTool("update_status", {
      memory_id: task1Id,
      status: "in_progress",
      agent_id: "wip-agent",
    });
  });

  it("emits WIP guardrail warning when transitioning second task to in_progress", async () => {
    const res = await callTool("update_status", {
      memory_id: task2Id,
      status: "in_progress",
      agent_id: "wip-agent",
    });
    const text = getText(res);
    // Should succeed (not blocked) but emit the warning
    assert.match(text, /Status: in_progress/);
    assert.match(text, /WIP guardrail/i);
  });
});

describe("update_memory with kanban fields", () => {
  it("updates status via update_memory", async () => {
    const storeRes = await callTool("store_memory", {
      content: "Task for update_memory kanban test",
      district: "practical_execution",
      tags: ["kind:task"],
    });
    const match = getText(storeRes).match(/ID: (memory_\d+)/);
    const id = match?.[1];
    assert.ok(id);

    const updateRes = await callTool("update_memory", {
      memory_id: id,
      status: "in_progress",
      current_slice: "slice via update_memory",
      why_now: "because testing",
    });
    const text = getText(updateRes);
    assert.match(text, /Status: in_progress/);
  });

  it("clears status by passing null", async () => {
    const storeRes = await callTool("store_memory", {
      content: "Task to clear status",
      district: "practical_execution",
      tags: ["kind:task"],
      status: "ready",
    });
    const match = getText(storeRes).match(/ID: (memory_\d+)/);
    const id = match?.[1];
    assert.ok(id);

    const updateRes = await callTool("update_memory", {
      memory_id: id,
      status: null,
    });
    const text = getText(updateRes);
    assert.match(text, /Status: unset/);
  });
});
