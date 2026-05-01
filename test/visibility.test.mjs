import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-visibility-test-"));

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

  child.stdout.on("data", chunk => {
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

      pending.set(id, response => {
        clearTimeout(timeout);
        resolve(response);
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
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

function hasResult(response, memoryId) {
  return resultText(response).includes(memoryId);
}

// ── store_memory ─────────────────────────────────────────────────────────────

test("store_memory with visibility:private stores and shows Visibility: private", async () => {
  const server = startServer();
  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "Private research note",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "private",
    });
    assert.match(resultText(stored), /Visibility: private/);

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Visibility: private/);
  } finally {
    server.stop();
  }
});

test("store_memory with visibility:shared stores and shows Visibility: shared", async () => {
  const server = startServer();
  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "Shared planning note",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      visibility: "shared",
    });
    assert.match(resultText(stored), /Visibility: shared/);
  } finally {
    server.stop();
  }
});

test("store_memory with visibility:global stores and shows Visibility: global", async () => {
  const server = startServer();
  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "Global reference memory",
      district: "logical_analysis",
      tags: ["topic:test", "scope:global", "kind:reference", "layer:architecture"],
      visibility: "global",
    });
    assert.match(resultText(stored), /Visibility: global/);
  } finally {
    server.stop();
  }
});

test("store_memory without visibility shows Visibility: private as default", async () => {
  const server = startServer();
  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "Memory without explicit visibility",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
    });
    assert.match(resultText(stored), /Visibility: private/);
  } finally {
    server.stop();
  }
});

// ── update_memory ─────────────────────────────────────────────────────────────

test("update_memory can change visibility from private to shared", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Initially private memory",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
    });

    const updated = await server.callTool(2, "update_memory", {
      memory_id: "memory_1",
      visibility: "shared",
    });
    assert.match(resultText(updated), /Visibility: shared/);
  } finally {
    server.stop();
  }
});

test("update_memory with visibility:null clears visibility (reverts to private default)", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Shared memory to be cleared",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "shared",
    });

    const updated = await server.callTool(2, "update_memory", {
      memory_id: "memory_1",
      visibility: null,
    });
    assert.match(resultText(updated), /Visibility: private/);
  } finally {
    server.stop();
  }
});

// ── search_memories ───────────────────────────────────────────────────────────

test("search_memories with visibility filter returns only matching memories", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Private research finding alpha",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "private",
    });

    await server.callTool(2, "store_memory", {
      content: "Shared research finding alpha",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "shared",
    });

    const sharedOnly = await server.callTool(3, "search_memories", {
      query: "research finding alpha",
      visibility: ["shared"],
    });

    assert.equal(hasResult(sharedOnly, "memory_1"), false, "private memory should be excluded");
    assert.equal(hasResult(sharedOnly, "memory_2"), true, "shared memory should be included");
  } finally {
    server.stop();
  }
});

test("search_memories with no visibility filter returns all memories", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Private beta note",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "private",
    });

    await server.callTool(2, "store_memory", {
      content: "Global beta note",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "global",
    });

    const all = await server.callTool(3, "search_memories", { query: "beta note" });
    assert.equal(hasResult(all, "memory_1"), true);
    assert.equal(hasResult(all, "memory_2"), true);
  } finally {
    server.stop();
  }
});

// ── list_memories ─────────────────────────────────────────────────────────────

test("list_memories with visibility filter returns only matching memories", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Private task gamma",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      visibility: "private",
    });

    await server.callTool(2, "store_memory", {
      content: "Global task gamma",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      visibility: "global",
    });

    const globalOnly = await server.callTool(3, "list_memories", {
      visibility: ["global"],
      page_size: 20,
    });

    assert.equal(hasResult(globalOnly, "memory_1"), false, "private memory should be excluded");
    assert.equal(hasResult(globalOnly, "memory_2"), true, "global memory should be included");
  } finally {
    server.stop();
  }
});

test("list_memories with multi-value visibility filter uses OR logic", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Private delta note",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "private",
    });

    await server.callTool(2, "store_memory", {
      content: "Shared delta note",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "shared",
    });

    await server.callTool(3, "store_memory", {
      content: "Global delta note",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
      visibility: "global",
    });

    const sharedOrGlobal = await server.callTool(4, "list_memories", {
      visibility: ["shared", "global"],
      page_size: 20,
    });

    assert.equal(hasResult(sharedOrGlobal, "memory_1"), false, "private should be excluded");
    assert.equal(hasResult(sharedOrGlobal, "memory_2"), true, "shared should be included");
    assert.equal(hasResult(sharedOrGlobal, "memory_3"), true, "global should be included");
  } finally {
    server.stop();
  }
});

// ── share_memory ──────────────────────────────────────────────────────────────

test("share_memory sets visibility to shared and creates a provenance record", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Private finding to share",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:note", "layer:research"],
    });

    const shared = await server.callTool(2, "share_memory", {
      memory_id: "memory_1",
      target_agent_id: "agent_bob",
    });

    const text = resultText(shared);
    assert.match(text, /Shared memory/);
    assert.match(text, /Visibility: shared/);
    assert.match(text, /Provenance record: memory_2/);
    assert.match(text, /Shared with: agent_bob/);

    // Source memory should now be shared
    const retrieved = await server.callTool(3, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Visibility: shared/);
  } finally {
    server.stop();
  }
});

test("share_memory with new_visibility:global sets visibility to global", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Private org-wide reference",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:architecture"],
    });

    const shared = await server.callTool(2, "share_memory", {
      memory_id: "memory_1",
      target_agent_id: "agent_org",
      new_visibility: "global",
    });

    assert.match(resultText(shared), /Visibility: global/);
  } finally {
    server.stop();
  }
});

test("share_memory with target_project_id records project in output", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "Cross-project insight",
      district: "creative_synthesis",
      tags: ["topic:test", "scope:project", "kind:insight", "layer:architecture"],
    });

    const shared = await server.callTool(2, "share_memory", {
      memory_id: "memory_1",
      target_agent_id: "agent_carol",
      target_project_id: "proj_gamma",
    });

    const text = resultText(shared);
    assert.match(text, /Project: proj_gamma/);
  } finally {
    server.stop();
  }
});

test("share_memory on non-existent memory_id returns error", async () => {
  const server = startServer();
  try {
    const result = await server.callTool(1, "share_memory", {
      memory_id: "memory_9999",
      target_agent_id: "agent_x",
    });
    const text = resultText(result);
    assert.match(text, /error|not found|Error|invalid/i);
  } finally {
    server.stop();
  }
});
