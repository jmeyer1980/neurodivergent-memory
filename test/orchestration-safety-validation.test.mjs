import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startServer(options = {}) {
  const tempDir = options.tempDir ?? makeTempDir("ndm-orchestration-safety-");
  fs.mkdirSync(tempDir, { recursive: true });

  if (options.snapshot) {
    fs.writeFileSync(path.join(tempDir, "memories.json"), JSON.stringify(options.snapshot, null, 2), "utf-8");
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
      NEURODIVERGENT_MEMORY_MODE: "standalone",
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

  function stop(options = {}) {
    child.kill();
    if (!options.keepTempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return { tempDir, callTool, stop };
}

function resultText(response) {
  return response.result?.content?.[0]?.text ?? "";
}

test("single-process concurrent write stress preserves all writes", async () => {
  const server = startServer({
    env: {
      NM_DISABLE_WAL: "true",
      NEURODIVERGENT_MEMORY_MAX: "50",
    },
  });

  try {
    const writeCount = 50;
    const writes = [];
    for (let i = 0; i < writeCount; i += 1) {
      writes.push(server.callTool(1000 + i, "store_memory", {
        content: `stress write ${i}`,
        district: "practical_execution",
        tags: ["topic:orchestration", "scope:test", "kind:task", "layer:implementation"],
      }));
    }

    await Promise.all(writes);

    const stats = await server.callTool(2000, "memory_stats", {});
    assert.match(resultText(stats), /Total memories: 50/);
  } finally {
    server.stop();
  }
});

test("crash-and-recovery startup replays WAL and compacts it", async () => {
  const tempDir = makeTempDir("ndm-orchestration-recovery-");
  const walFile = path.join(tempDir, "memories.json.wal.jsonl");
  const snapshotFile = path.join(tempDir, "memories.json");

  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(snapshotFile, JSON.stringify({ nextMemoryId: 1, memories: {} }, null, 2), "utf-8");

  const walEntry = {
    op: "store",
    payload: {
      memory: {
        id: "memory_1",
        name: "Recovered entry",
        archetype: "merchant",
        district: "practical_execution",
        content: "recovered from wal",
        traits: ["practical"],
        concerns: ["results"],
        connections: [],
        tags: ["topic:wal", "scope:test", "kind:task", "layer:debugging"],
        created: "2026-05-08T00:00:00.000Z",
        last_accessed: "2026-05-08T00:00:00.000Z",
        access_count: 1,
      },
    },
    timestamp: new Date().toISOString(),
    seq: 1,
  };
  fs.writeFileSync(walFile, `${JSON.stringify(walEntry)}\n`, "utf-8");

  const server = startServer({ tempDir });

  try {
    const retrieved = await server.callTool(2100, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /recovered from wal/);

    const walAfterStartup = fs.readFileSync(walFile, "utf-8").trim();
    assert.equal(walAfterStartup, "", "WAL should be compacted after replay");
  } finally {
    server.stop({ keepTempDir: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("eviction-at-capacity honors LRU policy in live flow", async () => {
  const server = startServer({
    env: {
      NEURODIVERGENT_MEMORY_MAX: "2",
      NEURODIVERGENT_MEMORY_EVICTION: "lru",
      NM_DISABLE_WAL: "true",
    },
  });

  try {
    await server.callTool(2200, "store_memory", {
      content: "entry-a",
      district: "logical_analysis",
      tags: ["topic:eviction", "scope:test", "kind:reference", "layer:debugging"],
    });
    await server.callTool(2201, "store_memory", {
      content: "entry-b",
      district: "logical_analysis",
      tags: ["topic:eviction", "scope:test", "kind:reference", "layer:debugging"],
    });

    await server.callTool(2203, "store_memory", {
      content: "entry-c",
      district: "logical_analysis",
      tags: ["topic:eviction", "scope:test", "kind:reference", "layer:debugging"],
    });

    const missing = await server.callTool(2204, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(missing), /Code: NM_E004/);

    const present = await server.callTool(2206, "retrieve_memory", { memory_id: "memory_2" });
    assert.match(resultText(present), /entry-b/);

    const remaining = await server.callTool(2205, "memory_stats", {});
    assert.match(resultText(remaining), /Total memories: 2/);
  } finally {
    server.stop();
  }
});