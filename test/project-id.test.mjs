import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-project-id-test-"));

  fs.mkdirSync(tempDir, { recursive: true });

  if (options.snapshot) {
    fs.writeFileSync(
      path.join(tempDir, "memories.json"),
      JSON.stringify(options.snapshot, null, 2),
      "utf-8",
    );
  }

  if (Array.isArray(options.walLines) && options.walLines.length > 0) {
    fs.writeFileSync(
      path.join(tempDir, "memories.json.wal.jsonl"),
      `${options.walLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf-8",
    );
  }

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

test("project_id is normalized on write and filters are case-insensitive across list/search/stats", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "alpha scoped memory",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      project_id: "Alpha",
    });

    await server.callTool(2, "store_memory", {
      content: "beta scoped memory",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      project_id: "BETA",
    });

    const imported = await server.callTool(3, "import_memories", {
      entries: [
        {
          content: "alpha import memory",
          district: "logical_analysis",
          tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
          project_id: "ALPHA",
        },
        {
          content: "unset import memory",
          district: "creative_synthesis",
          tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
        },
      ],
    });
    assert.match(resultText(imported), /Imported 2 memories/);

    const listAlpha = await server.callTool(4, "list_memories", { project_id: "aLpHa", page_size: 20 });
    const listAlphaText = resultText(listAlpha);
    assert.match(listAlphaText, /project: alpha/);
    assert.doesNotMatch(listAlphaText, /project: beta/);
    assert.doesNotMatch(listAlphaText, /project: Alpha|project: ALPHA/);

    const searchAlpha = await server.callTool(5, "search_memories", {
      query: "scoped memory",
      project_id: "ALPHA",
    });
    const searchAlphaText = resultText(searchAlpha);
    assert.match(searchAlphaText, /Found/);
    assert.match(searchAlphaText, /alpha scoped memory|alpha import memory/);

    const statsAlpha = await server.callTool(6, "memory_stats", { project_id: "AlPhA" });
    const statsAlphaText = resultText(statsAlpha);
    assert.match(statsAlphaText, /Scope project_id: AlPhA/);
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
    assert.match(statsText, /Per project:\n  \(unset\): 1/);
  } finally {
    server.stop();
  }
});

test("update_memory accepts project_id null to clear project attribution", async () => {
  const server = startServer();

  try {
    await server.callTool(30, "store_memory", {
      content: "clearable project memory",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      project_id: "Alpha",
    });

    const updateProject = await server.callTool(305, "update_memory", {
      memory_id: "memory_1",
      project_id: "BeTa",
    });
    assert.match(resultText(updateProject), /Project: beta/);

    const clearProject = await server.callTool(31, "update_memory", {
      memory_id: "memory_1",
      project_id: null,
    });
    assert.match(resultText(clearProject), /Project: unset/);

    const listAlpha = await server.callTool(32, "list_memories", { project_id: "alpha", page_size: 20 });
    assert.match(resultText(listAlpha), /No memories found/);

    const listAll = await server.callTool(33, "list_memories", { page_size: 20 });
    assert.match(resultText(listAll), /project: unset/);
  } finally {
    server.stop();
  }
});

test("search_memories surfaces did_you_mean for near-miss project_id queries", async () => {
  const server = startServer();

  try {
    await server.callTool(90, "store_memory", {
      content: "alpha suggestion target",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      project_id: "Alpha",
    });

    const noMatch = await server.callTool(91, "search_memories", {
      query: "alpha",
      project_id: "alpah",
    });

    assert.match(resultText(noMatch), /No memories found matching query: "alpha"/);
    assert.match(resultText(noMatch), /Did you mean project_id: alpha\?/);
  } finally {
    server.stop();
  }
});

test("search_memories surfaces partial matches for single-token typo misses", async () => {
  const server = startServer();

  try {
    await server.callTool(92, "store_memory", {
      content: "Yorkz planning board for weak-client workflow hardening",
      district: "practical_execution",
      tags: ["topic:yorkz", "scope:session", "kind:task", "layer:implementation"],
      project_id: "Yorkz",
    });

    const noMatch = await server.callTool(93, "search_memories", {
      query: "yorks",
    });

    assert.match(resultText(noMatch), /No memories found matching query: "yorks"/);
    assert.match(resultText(noMatch), /Partial matches:/);
    assert.match(resultText(noMatch), /yorkz \(similarity=0\.800, field=project_id, memories=memory_1, projects=yorkz\)/);
  } finally {
    server.stop();
  }
});

test("startup tolerates WAL updates targeting unknown districts", async () => {
  const snapshot = {
    nextMemoryId: 2,
    memories: {
      memory_1: {
        id: "memory_1",
        name: "Legacy Memory",
        archetype: "scholar",
        district: "logical_analysis",
        content: "legacy snapshot entry",
        traits: ["analytical"],
        concerns: ["accuracy"],
        connections: [],
        tags: ["topic:legacy", "scope:project", "kind:reference", "layer:architecture"],
        created: "2026-03-31T00:00:00.000Z",
        last_accessed: "2026-03-31T00:00:00.000Z",
        access_count: 1,
      },
    },
  };

  const walLines = [
    {
      op: "update",
      payload: {
        memory_id: "memory_1",
        updates: {
          district: "unknown_district",
        },
      },
      timestamp: new Date().toISOString(),
      seq: 1,
    },
  ];

  const server = startServer({ snapshot, walLines });

  try {
    const listLogical = await server.callTool(40, "list_memories", {
      district: "logical_analysis",
      page_size: 20,
    });
    assert.match(resultText(listLogical), /memory_1/);

    const listUnknown = await server.callTool(41, "list_memories", {
      district: "unknown_district",
      page_size: 20,
    });
    assert.match(resultText(listUnknown), /No memories found/);
  } finally {
    server.stop();
  }
});

test("startup enforces NEURODIVERGENT_MEMORY_MAX against snapshot+WAL state", async () => {
  const snapshot = {
    nextMemoryId: 4,
    memories: {
      memory_1: {
        id: "memory_1",
        name: "Snapshot 1",
        archetype: "scholar",
        district: "logical_analysis",
        content: "snapshot memory 1",
        traits: ["analytical"],
        concerns: ["accuracy"],
        connections: [],
        tags: ["topic:test", "scope:project", "kind:reference", "layer:research"],
        created: "2026-03-31T00:00:00.000Z",
        last_accessed: "2026-03-31T00:00:00.000Z",
        access_count: 1,
      },
      memory_2: {
        id: "memory_2",
        name: "Snapshot 2",
        archetype: "merchant",
        district: "practical_execution",
        content: "snapshot memory 2",
        traits: ["practical"],
        concerns: ["results"],
        connections: [],
        tags: ["topic:test", "scope:project", "kind:task", "layer:implementation"],
        created: "2026-03-31T00:00:01.000Z",
        last_accessed: "2026-03-31T00:00:01.000Z",
        access_count: 1,
      },
    },
  };

  const walLines = [
    {
      op: "store",
      payload: {
        memory: {
          id: "memory_3",
          name: "Wal 3",
          archetype: "guard",
          district: "vigilant_monitoring",
          content: "wal memory 3",
          traits: ["vigilant"],
          concerns: ["safety"],
          connections: [],
          tags: ["topic:test", "scope:project", "kind:task", "layer:debugging"],
          created: "2026-03-31T00:00:02.000Z",
          last_accessed: "2026-03-31T00:00:02.000Z",
          access_count: 1,
        },
      },
      timestamp: new Date().toISOString(),
      seq: 1,
    },
  ];

  const server = startServer({
    snapshot,
    walLines,
    env: {
      NEURODIVERGENT_MEMORY_MAX: "2",
      NEURODIVERGENT_MEMORY_EVICTION: "lru",
    },
  });

  try {
    const stats = await server.callTool(50, "memory_stats", {});
    assert.match(resultText(stats), /Total memories: 2/);
  } finally {
    server.stop();
  }
});

test("retrieve_memory is side-effect free for access counters", async () => {
  const server = startServer();

  try {
    await server.callTool(60, "store_memory", {
      content: "retrieve target",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const before = await server.callTool(61, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(before), /Access count: 1/);

    const after = await server.callTool(62, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(after), /Access count: 1/);
  } finally {
    server.stop();
  }
});

test("retrieve_memory contributes read context for ping-pong telemetry", async () => {
  const server = startServer({
    env: {
      NEURODIVERGENT_MEMORY_PING_PONG_THRESHOLD: "1",
    },
  });

  try {
    await server.callTool(70, "store_memory", {
      content: "telemetry target",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      agent_id: "writer",
    });

    await server.callTool(71, "retrieve_memory", {
      memory_id: "memory_1",
      district: "creative_synthesis",
      agent_id: "reader",
    });

    await server.callTool(72, "update_memory", {
      memory_id: "memory_1",
      content: "telemetry target updated",
      actor_district: "logical_analysis",
      agent_id: "writer",
    });

    const stats = await server.callTool(73, "memory_stats", {});
    assert.match(resultText(stats), /ping_pong_counter=1/);
  } finally {
    server.stop();
  }
});

test("wal replay restores telemetry fields from update entries", async () => {
  const snapshot = {
    nextMemoryId: 2,
    memories: {
      memory_1: {
        id: "memory_1",
        name: "Baseline",
        archetype: "scholar",
        district: "logical_analysis",
        content: "baseline memory",
        traits: ["analytical"],
        concerns: ["accuracy"],
        connections: [],
        tags: ["topic:test", "scope:project", "kind:task", "layer:implementation"],
        created: "2026-03-31T00:00:00.000Z",
        last_accessed: "2026-03-31T00:00:00.000Z",
        access_count: 1,
      },
    },
  };

  const walLines = [
    {
      op: "update",
      payload: {
        memory_id: "memory_1",
        updates: {
          repeat_write_count: 4,
          repeat_count: 4,
          last_similarity_score: 0.932,
          ping_pong_counter: 2,
        },
      },
      timestamp: new Date().toISOString(),
      seq: 1,
    },
  ];

  const server = startServer({ snapshot, walLines });

  try {
    const stats = await server.callTool(80, "memory_stats", {});
    const statsText = resultText(stats);
    assert.match(statsText, /repeat_write_count=4/);
    assert.match(statsText, /last_similarity=0.932/);
    assert.match(statsText, /ping_pong_counter=2/);
  } finally {
    server.stop();
  }
});
