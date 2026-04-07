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

test("dedupe skips do not consume memory ids on real import", async () => {
  const server = startServer();

  try {
    await server.callTool(60, "store_memory", {
      content: "existing duplicate seed",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const imported = await server.callTool(61, "import_memories", {
      entries: [
        {
          content: "existing duplicate seed",
          district: "logical_analysis",
          tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
        },
        {
          content: "only imported row",
          district: "practical_execution",
          tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
        },
      ],
      dedupe: "content_hash",
    });
    assert.equal(isToolError(imported), false, resultText(imported));
    assert.match(resultText(imported), /Imported 1 memories/);
    assert.match(resultText(imported), /memory_2/);

    const stored = await server.callTool(62, "store_memory", {
      content: "next id after skipped dedupe",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });
    assert.match(resultText(stored), /ID: memory_3/);
  } finally {
    server.stop();
  }
});

test("invalid dedupe policy is rejected with validation error", async () => {
  const server = startServer();

  try {
    const response = await server.callTool(70, "import_memories", {
      entries: [
        {
          content: "bad dedupe policy",
          district: "logical_analysis",
        },
      ],
      dedupe: "bogus_policy",
    });

    assert.equal(isToolError(response), true, resultText(response));
    assert.match(resultText(response), /Invalid dedupe policy/);
    assert.match(resultText(response), /Code: NM_E020/);
  } finally {
    server.stop();
  }
});

test("snapshot import rejects key and embedded id mismatches", async () => {
  const server = startServer();

  try {
    const snapshotPath = writeSnapshotFile(server.tempDir, "mismatch-snapshot.json", {
      nextMemoryId: 2,
      memories: {
        memory_1: {
          id: "memory_999",
          name: "Mismatched Snapshot",
          archetype: "scholar",
          district: "logical_analysis",
          content: "mismatch",
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

    const response = await server.callTool(71, "import_memories", {
      file_path: snapshotPath,
      dry_run: true,
    });

    assert.equal(isToolError(response), true, resultText(response));
    assert.match(resultText(response), /Snapshot memory id mismatch/);
  } finally {
    server.stop();
  }
});

test("snapshot import validates project_id field paths with snapshot context", async () => {
  const server = startServer();

  try {
    const snapshotPath = writeSnapshotFile(server.tempDir, "invalid-project-snapshot.json", {
      nextMemoryId: 2,
      memories: {
        memory_1: {
          id: "memory_1",
          name: "Bad Project Snapshot",
          archetype: "scholar",
          district: "logical_analysis",
          content: "invalid project id",
          traits: ["analytical"],
          concerns: ["accuracy"],
          connections: [],
          tags: ["topic:test", "scope:project", "kind:reference", "layer:architecture"],
          created: "2026-04-01T00:00:00.000Z",
          last_accessed: "2026-04-01T00:00:00.000Z",
          access_count: 1,
          intensity: 0.5,
          project_id: "bad!",
        },
      },
    });

    const response = await server.callTool(72, "import_memories", {
      file_path: snapshotPath,
      dry_run: true,
    });

    assert.equal(isToolError(response), false, resultText(response));
    assert.match(resultText(response), /snapshot\[memory_1\]\.project_id/);
  } finally {
    server.stop();
  }
});

test("snapshot import rejects external file paths unless explicitly enabled", async () => {
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-external-import-"));
  const externalSnapshotPath = writeSnapshotFile(externalDir, "external-snapshot.json", {
    nextMemoryId: 2,
    memories: {
      memory_1: {
        id: "memory_1",
        name: "External Snapshot",
        archetype: "scholar",
        district: "logical_analysis",
        content: "external file path import",
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

  const server = startServer();

  try {
    const blocked = await server.callTool(73, "import_memories", {
      file_path: externalSnapshotPath,
      dry_run: true,
    });

    assert.equal(isToolError(blocked), true, resultText(blocked));
    assert.match(resultText(blocked), /outside the allowed persistence directory/);
  } finally {
    server.stop();
  }

  const allowedServer = startServer({
    env: {
      NEURODIVERGENT_MEMORY_IMPORT_ALLOW_EXTERNAL_FILE: "true",
    },
  });

  try {
    const allowed = await allowedServer.callTool(74, "import_memories", {
      file_path: externalSnapshotPath,
      dry_run: true,
    });

    assert.equal(isToolError(allowed), false, resultText(allowed));
    assert.match(resultText(allowed), /Would import: 1/);
  } finally {
    allowedServer.stop();
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test("import_memories accepts Windows snapshot paths when only the drive-letter casing differs", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific path normalization regression");
    return;
  }

  const server = startServer();
  const snapshotPath = writeSnapshotFile(server.tempDir, "mixed-drive-letter.json", {
    nextMemoryId: 2,
    memories: {
      memory_1: {
        id: "memory_1",
        name: "Mixed Drive Letter",
        archetype: "scholar",
        district: "logical_analysis",
        content: "mixed drive letter import",
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

  const origDriveLetter = snapshotPath[0];
  const toggledDriveLetter =
    origDriveLetter === origDriveLetter.toUpperCase()
      ? origDriveLetter.toLowerCase()
      : origDriveLetter.toUpperCase();
  const mixedCaseDrivePath = `${toggledDriveLetter}${snapshotPath.slice(1)}`;
  assert.notEqual(
    mixedCaseDrivePath,
    snapshotPath,
    "mixed-case drive path must differ from original to exercise the regression",
  );

  try {
    const response = await server.callTool(75, "import_memories", {
      file_path: mixedCaseDrivePath,
      dry_run: true,
    });

    assert.equal(isToolError(response), false, resultText(response));
    assert.match(resultText(response), /Would import: 1/);
  } finally {
    server.stop();
  }
});