import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-import-diagnostics-"));

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

  function callTool(id, name, args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to request ${id}`));
      }, timeoutMs);

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

  return { callTool, stop, tempDir };
}

function resultText(response) {
  return response.result?.content?.[0]?.text ?? "";
}

function isToolError(response) {
  return Boolean(response.result?.isError);
}

function writeSnapshotFile(tempDir, fileName, snapshot) {
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
  return filePath;
}

test("storage_diagnostics reports resolved snapshot and WAL paths", async () => {
  const server = startServer();

  try {
    const response = await server.callTool(1, "storage_diagnostics", {});
    const text = resultText(response);

    assert.equal(isToolError(response), false, text);
    assert.match(text, /Storage Diagnostics/);
    assert.match(text, new RegExp(server.tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /memories\.json/);
    assert.match(text, /memories\.json\.wal\.jsonl/);
    assert.match(text, /Resolved source: NEURODIVERGENT_MEMORY_DIR/);
  } finally {
    server.stop();
  }
});

test("import_memories dry_run reports deterministic counts and does not write", async () => {
  const server = startServer();

  try {
    await server.callTool(10, "store_memory", {
      content: "duplicate candidate",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const dryRun = await server.callTool(11, "import_memories", {
      entries: [
        {
          content: "duplicate candidate",
          district: "logical_analysis",
          tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
        },
        {
          content: "fresh import candidate",
          district: "practical_execution",
          tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
        },
        {
          content: "bad district entry",
          district: "unknown_district",
          tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
        },
      ],
      dry_run: true,
      dedupe: "content_hash",
    });
    const dryRunText = resultText(dryRun);

    assert.equal(isToolError(dryRun), false, dryRunText);
    assert.match(dryRunText, /Would import: 1/);
    assert.match(dryRunText, /Would skip: 1/);
    assert.match(dryRunText, /Would fail: 1/);
    assert.match(dryRunText, /DEDUPE_CONTENT_HASH/);
    assert.match(dryRunText, /UNKNOWN_DISTRICT/);

    const stats = await server.callTool(12, "memory_stats", {});
    const statsText = resultText(stats);
    assert.match(statsText, /Total memories: 1/);
  } finally {
    server.stop();
  }
});

test("content_plus_tags dedupe skips only identical content plus tag sets", async () => {
  const server = startServer();

  try {
    await server.callTool(20, "store_memory", {
      content: "same content different tag semantics",
      district: "logical_analysis",
      tags: ["topic:test", "kind:reference"],
    });

    const dryRun = await server.callTool(21, "import_memories", {
      entries: [
        {
          content: "same content different tag semantics",
          district: "logical_analysis",
          tags: ["kind:reference", "topic:test"],
        },
        {
          content: "same content different tag semantics",
          district: "logical_analysis",
          tags: ["topic:test", "kind:insight"],
        },
      ],
      dry_run: true,
      dedupe: "content_plus_tags",
    });
    const text = resultText(dryRun);

    assert.equal(isToolError(dryRun), false, text);
    assert.match(text, /Would import: 1/);
    assert.match(text, /Would skip: 1/);
    assert.match(text, /Would fail: 0/);
    assert.match(text, /DEDUPE_CONTENT_PLUS_TAGS/);
  } finally {
    server.stop();
  }
});

test("snapshot file import can preserve ids and merge connections", async () => {
  const server = startServer();

  try {
    const snapshotPath = writeSnapshotFile(server.tempDir, "incoming-snapshot.json", {
      nextMemoryId: 12,
      memories: {
        memory_10: {
          id: "memory_10",
          name: "Imported Ten",
          archetype: "scholar",
          district: "logical_analysis",
          content: "snapshot import ten",
          traits: ["analytical"],
          concerns: ["accuracy"],
          connections: ["memory_11"],
          tags: ["topic:test", "scope:project", "kind:reference", "layer:architecture"],
          created: "2026-04-01T00:00:00.000Z",
          last_accessed: "2026-04-01T00:00:00.000Z",
          access_count: 3,
          intensity: 0.4,
        },
        memory_11: {
          id: "memory_11",
          name: "Imported Eleven",
          archetype: "merchant",
          district: "practical_execution",
          content: "snapshot import eleven",
          traits: ["organized"],
          concerns: ["throughput"],
          connections: ["memory_10"],
          tags: ["topic:test", "scope:project", "kind:task", "layer:implementation"],
          created: "2026-04-01T00:00:00.000Z",
          last_accessed: "2026-04-01T00:00:00.000Z",
          access_count: 2,
          intensity: 0.7,
        },
      },
    });

    const imported = await server.callTool(30, "import_memories", {
      file_path: snapshotPath,
      preserve_ids: true,
      merge_connections: true,
    });
    const importedText = resultText(imported);

    assert.equal(isToolError(imported), false, importedText);
    assert.match(importedText, /Imported 2 memories/);
    assert.match(importedText, /memory_10/);
    assert.match(importedText, /memory_11/);

    const traversed = await server.callTool(31, "traverse_from", {
      memory_id: "memory_10",
      depth: 1,
    });
    assert.match(resultText(traversed), /memory_11/);

    const stored = await server.callTool(32, "store_memory", {
      content: "post import id continuity",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    assert.match(resultText(stored), /ID: memory_12/);
  } finally {
    server.stop();
  }
});

test("snapshot import dry_run reports invalid connection targets", async () => {
  const server = startServer();

  try {
    const snapshotPath = writeSnapshotFile(server.tempDir, "invalid-connection-snapshot.json", {
      nextMemoryId: 3,
      memories: {
        memory_1: {
          id: "memory_1",
          name: "Broken Connection",
          archetype: "scholar",
          district: "logical_analysis",
          content: "broken connection import",
          traits: ["analytical"],
          concerns: ["accuracy"],
          connections: ["memory_999"],
          tags: ["topic:test", "scope:project", "kind:reference", "layer:architecture"],
          created: "2026-04-01T00:00:00.000Z",
          last_accessed: "2026-04-01T00:00:00.000Z",
          access_count: 1,
          intensity: 0.5,
        },
      },
    });

    const dryRun = await server.callTool(40, "import_memories", {
      file_path: snapshotPath,
      dry_run: true,
      merge_connections: true,
    });
    const text = resultText(dryRun);

    assert.equal(isToolError(dryRun), false, text);
    assert.match(text, /Would import: 0/);
    assert.match(text, /Would fail: 1/);
    assert.match(text, /INVALID_CONNECTION_TARGET/);
  } finally {
    server.stop();
  }
});

test("snapshot import rejects preserve_ids conflicts with clear error", async () => {
  const server = startServer();

  try {
    await server.callTool(50, "store_memory", {
      content: "existing memory one",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const snapshotPath = writeSnapshotFile(server.tempDir, "conflict-snapshot.json", {
      nextMemoryId: 2,
      memories: {
        memory_1: {
          id: "memory_1",
          name: "Conflicting Memory",
          archetype: "scholar",
          district: "logical_analysis",
          content: "conflicting import",
          traits: ["analytical"],
          concerns: ["accuracy"],
          connections: [],
          tags: ["topic:test", "scope:project", "kind:reference", "layer:architecture"],
          created: "2026-04-01T00:00:00.000Z",
          last_accessed: "2026-04-01T00:00:00.000Z",
          access_count: 1,
          intensity: 0.5,
        },
      },
    });

    const response = await server.callTool(51, "import_memories", {
      file_path: snapshotPath,
      preserve_ids: true,
    });
    const text = resultText(response);

    assert.equal(isToolError(response), true, text);
    assert.match(text, /ID_CONFLICT/);
    assert.match(text, /dry_run=true/);
  } finally {
    server.stop();
  }
});