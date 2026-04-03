import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-retrieval-test-"));

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

function firstResultId(response) {
  const match = resultText(response).match(/• \[(?:\d+|\d+\.\d+)\] (memory_\d+)/);
  return match?.[1] ?? null;
}

function hasResult(response, memoryId) {
  return resultText(response).includes(memoryId);
}

test("search_memories context boosts goal-relevant memories", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "retrieval tuning archive notes",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    await server.callTool(2, "store_memory", {
      content: "retrieval tuning goal-aware context ranking",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const noContext = await server.callTool(3, "search_memories", {
      query: "retrieval tuning",
      min_score: 0,
    });
    assert.equal(firstResultId(noContext), "memory_1");

    const withContext = await server.callTool(4, "search_memories", {
      query: "retrieval tuning",
      context: "goal-aware context",
      min_score: 0,
    });
    assert.equal(firstResultId(withContext), "memory_2");
  } finally {
    server.stop();
  }
});

test("search_memories recency_weight boosts newer equally relevant memories", async () => {
  const server = startServer();

  try {
    await server.callTool(10, "store_memory", {
      content: "retrieval recency signal",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    await server.callTool(11, "store_memory", {
      content: "retrieval recency signal",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const noRecency = await server.callTool(12, "search_memories", {
      query: "retrieval recency signal",
      min_score: 0,
    });
    assert.equal(firstResultId(noRecency), "memory_1");

    const withRecency = await server.callTool(13, "search_memories", {
      query: "retrieval recency signal",
      recency_weight: 1,
      min_score: 0,
    });
    assert.equal(firstResultId(withRecency), "memory_2");
  } finally {
    server.stop();
  }
});

test("related_to context boosts the most relevant connected memory", async () => {
  const server = startServer();

  try {
    await server.callTool(20, "store_memory", {
      content: "issue 57 retrieval task root",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });

    await server.callTool(21, "store_memory", {
      content: "retrieval ranking archive",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    await server.callTool(22, "store_memory", {
      content: "retrieval ranking goal-aware context",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    await server.callTool(23, "connect_memories", { memory_id_1: "memory_1", memory_id_2: "memory_2" });
    await server.callTool(24, "connect_memories", { memory_id_1: "memory_1", memory_id_2: "memory_3" });

    const noContext = await server.callTool(25, "related_to", {
      memory_id: "memory_1",
      query: "retrieval ranking",
    });
    assert.equal(firstResultId(noContext), "memory_2");

    const withContext = await server.callTool(26, "related_to", {
      memory_id: "memory_1",
      query: "retrieval ranking",
      context: "goal-aware context",
    });
    assert.equal(firstResultId(withContext), "memory_3");
  } finally {
    server.stop();
  }
});

test("search_memories accepts min_intensity and max_intensity aliases", async () => {
  const server = startServer();

  try {
    await server.callTool(30, "store_memory", {
      content: "intensity alias candidate",
      district: "emotional_processing",
      intensity: 0.2,
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    await server.callTool(31, "store_memory", {
      content: "intensity alias candidate",
      district: "emotional_processing",
      intensity: 0.9,
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const filtered = await server.callTool(32, "search_memories", {
      query: "intensity alias candidate",
      min_intensity: 0.8,
      max_intensity: 1,
      min_score: 0,
    });

    assert.equal(hasResult(filtered, "memory_1"), false);
    assert.equal(hasResult(filtered, "memory_2"), true);
  } finally {
    server.stop();
  }
});