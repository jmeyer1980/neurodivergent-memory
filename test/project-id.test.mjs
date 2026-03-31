import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-project-id-test-"));

  if (options.snapshot) {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "memories.json"),
      JSON.stringify(options.snapshot, null, 2),
      "utf-8",
    );
  }

  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_LOG_LEVEL: "error",
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

test("project_id supports scoped list/search/stats and mixed import entries", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "alpha scoped memory",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      project_id: "alpha",
    });

    await server.callTool(2, "store_memory", {
      content: "beta scoped memory",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      project_id: "beta",
    });

    const imported = await server.callTool(3, "import_memories", {
      entries: [
        {
          content: "alpha import memory",
          district: "logical_analysis",
          tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
          project_id: "alpha",
        },
        {
          content: "unset import memory",
          district: "creative_synthesis",
          tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
        },
      ],
    });
    assert.match(resultText(imported), /Imported 2 memories/);

    const listAlpha = await server.callTool(4, "list_memories", { project_id: "alpha", page_size: 20 });
    const listAlphaText = resultText(listAlpha);
    assert.match(listAlphaText, /project: alpha/);
    assert.doesNotMatch(listAlphaText, /project: beta/);

    const searchAlpha = await server.callTool(5, "search_memories", {
      query: "scoped memory",
      project_id: "alpha",
    });
    const searchAlphaText = resultText(searchAlpha);
    assert.match(searchAlphaText, /Found/);
    assert.match(searchAlphaText, /alpha scoped memory|alpha import memory/);

    const statsAlpha = await server.callTool(6, "memory_stats", { project_id: "alpha" });
    const statsAlphaText = resultText(statsAlpha);
    assert.match(statsAlphaText, /Scope project_id: alpha/);
    assert.match(statsAlphaText, /Per project:\n  alpha: 2/);
  } finally {
    server.stop();
  }
});

test("invalid project_id values return NM_E020 across tool surfaces", async () => {
  const server = startServer();

  try {
    const invalidStore = await server.callTool(10, "store_memory", {
      content: "bad project id",
      district: "practical_execution",
      project_id: "-invalid",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });
    assert.match(resultText(invalidStore), /Code: NM_E020/);

    await server.callTool(11, "store_memory", {
      content: "valid seed",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      project_id: "seed",
    });

    const invalidUpdate = await server.callTool(12, "update_memory", {
      memory_id: "memory_1",
      project_id: "bad space",
    });
    assert.match(resultText(invalidUpdate), /Code: NM_E020/);

    const invalidList = await server.callTool(13, "list_memories", { project_id: "bad!" });
    assert.match(resultText(invalidList), /Code: NM_E020/);

    const invalidSearch = await server.callTool(14, "search_memories", {
      query: "seed",
      project_id: "bad!",
    });
    assert.match(resultText(invalidSearch), /Code: NM_E020/);

    const invalidStats = await server.callTool(15, "memory_stats", { project_id: "bad!" });
    assert.match(resultText(invalidStats), /Code: NM_E020/);

    const invalidImport = await server.callTool(16, "import_memories", {
      entries: [
        {
          content: "import bad",
          district: "logical_analysis",
          project_id: "bad!",
        },
      ],
    });
    assert.match(resultText(invalidImport), /Code: NM_E020/);
  } finally {
    server.stop();
  }
});

test("legacy snapshots without project_id load successfully", async () => {
  const snapshot = {
    nextMemoryId: 2,
    memories: {
      memory_1: {
        id: "memory_1",
        name: "Legacy Memory",
        archetype: "scholar",
        district: "logical_analysis",
        content: "legacy snapshot entry without project",
        traits: ["analytical", "methodical"],
        concerns: ["accuracy", "knowledge"],
        connections: [],
        tags: ["topic:legacy", "scope:project", "kind:reference", "layer:architecture"],
        created: "2026-03-31T00:00:00.000Z",
        last_accessed: "2026-03-31T00:00:00.000Z",
        access_count: 1,
        intensity: 0.5,
      },
    },
  };

  const server = startServer({ snapshot });

  try {
    const list = await server.callTool(20, "list_memories", { page_size: 20 });
    const listText = resultText(list);
    assert.match(listText, /memory_1/);
    assert.match(listText, /project: unset/);

    const stats = await server.callTool(21, "memory_stats", {});
    const statsText = resultText(stats);
    assert.match(statsText, /Per project:\n  unset: 1/);
  } finally {
    server.stop();
  }
});
