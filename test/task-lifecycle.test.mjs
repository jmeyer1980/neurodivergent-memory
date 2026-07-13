/**
 * Regression tests for Issue #119: Task Publication Lifecycle State Machine
 * Covers: publish_task, resume_task, close_task tools
 * Scenarios from the acceptance matrix in the issue.
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

function waitForResponse(id, timeoutMs = 8000) {
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
  return sendRequest("tools/call", { name, arguments: args });
}

function getText(res) {
  return res?.result?.content?.[0]?.text ?? "";
}

/** Create a fresh task memory in practical_execution and return its id. */
async function createTask(content = "Test task for lifecycle") {
  const res = await callTool("store_memory", {
    content,
    district: "practical_execution",
    tags: ["kind:task", "topic:lifecycle-test"],
  });
  const text = getText(res);
  const match = text.match(/ID:\s*(memory_\d+)/);
  if (!match) throw new Error(`Could not extract memory ID from: ${text}`);
  return match[1];
}

before(async () => {
  serverProcess = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NEURODIVERGENT_MEMORY_MODE: "standalone", NM_PERSISTENCE_PATH: "", NM_DISABLE_WAL: "true" },
  });
  serverProcess.stderr.on("data", () => {}); // suppress stderr
  await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-task-lifecycle", version: "1.0.0" },
  });
});

after(() => {
  serverProcess.stdin.end();
  serverProcess.kill();
});

// ── Publish path ────────────────────────────────────────────────────────────

describe("publish path: partial success", () => {
  it("sets state to published_partial when completed=false", async () => {
    const id = await createTask("PR partially published");
    const res = await callTool("publish_task", { memory_id: id, completed: false, last_step: "pr_created" });
    const text = getText(res);
    assert.match(text, /published_partial/);
    assert.match(text, /pr_created/);
  });

  it("advances from published_partial to published_complete on retry", async () => {
    const id = await createTask("PR retry scenario");
    // Step 1: partial
    await callTool("publish_task", { memory_id: id, completed: false, last_step: "pr_created" });
    // Step 2: complete (retry after partial)
    const res = await callTool("publish_task", { memory_id: id, completed: true, last_step: "reviewer_requested" });
    const text = getText(res);
    assert.match(text, /published_complete/);
  });
});

describe("publish path: idempotency", () => {
  it("returns already published_complete when retrying with completed=true", async () => {
    const id = await createTask("Idempotent publish test");
    await callTool("publish_task", { memory_id: id, completed: true, last_step: "reviewer_requested" });
    // Second call
    const res = await callTool("publish_task", { memory_id: id, completed: true });
    const text = getText(res);
    assert.match(text, /already published_complete/i);
  });
});

// ── Resume path ─────────────────────────────────────────────────────────────

describe("resume path: valid resume from resumable state", () => {
  it("resumes a task that was set to resumable and transitions to published_partial", async () => {
    const id = await createTask("Resumable task scenario");
    // Get to published_partial first
    await callTool("publish_task", { memory_id: id, completed: false, last_step: "pr_created" });
    // Mark as resumable via update_memory
    await callTool("update_memory", { memory_id: id, publication_state: "resumable" });
    // Now resume
    const res = await callTool("resume_task", { memory_id: id });
    const text = getText(res);
    assert.match(text, /resumable/i);
    // Should confirm task is resumable, returning lifecycle context
    assert.match(text, /last_successful_step|pr_created/);
  });
});

describe("resume path: stale or nonexistent task reference", () => {
  it("returns MEMORY_NOT_FOUND error with recovery hint for nonexistent memory_id", async () => {
    const res = await callTool("resume_task", { memory_id: "memory_99999" });
    const text = getText(res);
    // Should return error content or a structured error
    assert.ok(
      text.match(/not found/i) || res?.result?.isError || res?.error,
      `Expected not-found diagnostic, got: ${text}`
    );
  });
});

describe("resume path: task in non-resumable state", () => {
  it("returns diagnostic when resuming a draft task (no publish steps done)", async () => {
    const id = await createTask("Draft task — not yet published");
    const res = await callTool("resume_task", { memory_id: id });
    const text = getText(res);
    // Should explain the task is not resumable and suggest publish_task
    assert.match(text, /not in a resumable state/i);
    assert.match(text, /publish_task|lifecycle_state/i);
  });

  it("returns diagnostic when task is already closed", async () => {
    const id = await createTask("Closed task resume attempt");
    // Fast-path to closable
    await callTool("publish_task", { memory_id: id, completed: true });
    await callTool("update_memory", { memory_id: id, publication_state: "closable" });
    await callTool("close_task", { memory_id: id });
    // Now try to resume
    const res = await callTool("resume_task", { memory_id: id });
    const text = getText(res);
    assert.match(text, /closed|not in a resumable state/i);
  });
});

// ── Close path ──────────────────────────────────────────────────────────────

describe("close path: valid close from closable state", () => {
  it("closes a task that is in closable state", async () => {
    const id = await createTask("Task ready to close");
    await callTool("publish_task", { memory_id: id, completed: true });
    await callTool("update_memory", { memory_id: id, publication_state: "closable" });
    const res = await callTool("close_task", { memory_id: id });
    const text = getText(res);
    assert.match(text, /closed/i);
    assert.match(text, /lifecycle_state: closed/i);
  });
});

describe("close path: idempotency", () => {
  it("returns already-closed without mutation when close is called twice", async () => {
    const id = await createTask("Double-close test");
    await callTool("publish_task", { memory_id: id, completed: true });
    await callTool("update_memory", { memory_id: id, publication_state: "closable" });
    await callTool("close_task", { memory_id: id });
    // Second call
    const res = await callTool("close_task", { memory_id: id });
    const text = getText(res);
    assert.match(text, /already closed/i);
  });
});

describe("close path: non-closable state error", () => {
  it("returns deterministic guidance when closing from draft state", async () => {
    const id = await createTask("Cannot close draft");
    const res = await callTool("close_task", { memory_id: id });
    const text = getText(res);
    // Should be an error with guidance about allowed transitions
    assert.ok(
      text.match(/cannot close|invalid.*transition|closable/i) ||
        res?.result?.isError ||
        res?.error,
      `Expected close error from draft state, got: ${text}`
    );
  });

  it("returns deterministic guidance when closing from published_partial state", async () => {
    const id = await createTask("Cannot close partial");
    await callTool("publish_task", { memory_id: id, completed: false, last_step: "pr_created" });
    const res = await callTool("close_task", { memory_id: id });
    const text = getText(res);
    assert.ok(
      text.match(/cannot close|invalid.*transition|closable/i) ||
        res?.result?.isError ||
        res?.error,
      `Expected close error from published_partial state, got: ${text}`
    );
  });
});

// ── Persistence ─────────────────────────────────────────────────────────────

describe("publication_state is persisted via update_memory", () => {
  it("stores publication_state on a memory and retrieves it", async () => {
    const id = await createTask("Persisted lifecycle state");
    await callTool("publish_task", { memory_id: id, completed: true, last_step: "reviewer_requested" });
    // Retrieve and verify
    const res = await callTool("retrieve_memory", { memory_id: id });
    const text = getText(res);
    assert.match(text, /published_complete|publication_state/i);
  });
});
