import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SYNC_SCRIPT = path.join(process.cwd(), "build", "scripts", "sync-memories.js");

function createTempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-sync-test-"));
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  return { base, source, target };
}

function writeSnapshot(dir, data) {
  fs.writeFileSync(path.join(dir, "memories.json"), JSON.stringify(data, null, 2));
}

function readSnapshot(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "memories.json"), "utf-8"));
}

function snapshotPath(dir) {
  return path.join(dir, "memories.json");
}

function runSync(args, env = {}) {
  try {
    return execFileSync(process.execPath, [SYNC_SCRIPT, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
  } catch (err) {
    throw new Error(`sync-memories exited ${err.status}: ${err.stderr}`);
  }
}

test("preserves customDistricts and other top-level fields in target snapshot", () => {
  const { base, source, target } = createTempDirs();

  try {
    const customDistricts = { research: { name: "Research", archetype: "scholar" } };

    writeSnapshot(source, {
      nextMemoryId: 2,
      memories: {
        memory_1: {
          id: "memory_1",
          content: "durable insight",
          district: "logical_analysis",
          tags: ["persistence:durable", "kind:insight"],
        },
      },
    });

    writeSnapshot(target, {
      nextMemoryId: 1,
      customDistricts,
      memories: {},
    });

    runSync(["--from", snapshotPath(source), "--to", snapshotPath(target)]);

    const result = readSnapshot(target);
    assert.deepEqual(result.customDistricts, customDistricts, "customDistricts should be preserved");
    assert.ok(result.memories.memory_1, "imported memory should exist");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("strips connections and abstracted_from from imported memories", () => {
  const { base, source, target } = createTempDirs();

  try {
    writeSnapshot(source, {
      nextMemoryId: 2,
      memories: {
        memory_1: {
          id: "memory_1",
          content: "connected insight",
          district: "logical_analysis",
          tags: ["persistence:durable", "kind:insight"],
          connections: ["memory_99", "memory_100"],
          abstracted_from: "memory_88",
          source_memory_id: "memory_77",
          access_count: 5,
        },
      },
    });

    writeSnapshot(target, { nextMemoryId: 1, memories: {} });

    runSync(["--from", snapshotPath(source), "--to", snapshotPath(target)]);

    const result = readSnapshot(target);
    const imported = result.memories.memory_1;

    assert.ok(imported, "memory should be imported");
    assert.equal(imported.connections, undefined, "connections should be stripped");
    assert.equal(imported.abstracted_from, undefined, "abstracted_from should be stripped");
    assert.equal(imported.source_memory_id, undefined, "source_memory_id should be stripped");
    assert.equal(imported.access_count, 5, "non-reference fields should be preserved");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("content-hash dedupe skips memories already in target", () => {
  const { base, source, target } = createTempDirs();

  try {
    const sharedMemory = {
      id: "memory_1",
      content: "shared knowledge",
      district: "logical_analysis",
      tags: ["persistence:durable", "kind:insight"],
    };

    writeSnapshot(source, {
      nextMemoryId: 3,
      memories: {
        memory_1: { ...sharedMemory },
        memory_2: {
          id: "memory_2",
          content: "new insight",
          district: "practical_execution",
          tags: ["persistence:durable", "kind:task"],
        },
      },
    });

    writeSnapshot(target, {
      nextMemoryId: 2,
      memories: {
        memory_1: { ...sharedMemory },
      },
    });

    const output = runSync(["--from", snapshotPath(source), "--to", snapshotPath(target)]);
    assert.match(output, /imported:\s+1/);
    assert.match(output, /skipped:\s+1/);

    const result = readSnapshot(target);
    assert.ok(result.memories.memory_1, "original target memory preserved");
    assert.ok(result.memories.memory_2, "new memory imported");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("dry-run reports counts without writing", () => {
  const { base, source, target } = createTempDirs();

  try {
    writeSnapshot(source, {
      nextMemoryId: 2,
      memories: {
        memory_1: {
          id: "memory_1",
          content: "durable insight",
          district: "logical_analysis",
          tags: ["persistence:durable", "kind:insight"],
        },
      },
    });

    writeSnapshot(target, { nextMemoryId: 1, memories: {} });

    const output = runSync(["--from", snapshotPath(source), "--to", snapshotPath(target), "--dry-run"]);
    assert.match(output, /dry-run/);
    assert.match(output, /would_import: 1/);

    const result = readSnapshot(target);
    assert.deepEqual(result.memories, {}, "target should be unchanged after dry-run");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("any-tag flag uses OR matching", () => {
  const { base, source, target } = createTempDirs();

  try {
    writeSnapshot(source, {
      nextMemoryId: 3,
      memories: {
        memory_1: {
          id: "memory_1",
          content: "has durable",
          district: "logical_analysis",
          tags: ["persistence:durable"],
        },
        memory_2: {
          id: "memory_2",
          content: "has ephemeral",
          district: "logical_analysis",
          tags: ["persistence:ephemeral"],
        },
        memory_3: {
          id: "memory_3",
          content: "has neither",
          district: "logical_analysis",
          tags: ["kind:insight"],
        },
      },
    });

    writeSnapshot(target, { nextMemoryId: 1, memories: {} });

    const output = runSync(["--from", snapshotPath(source), "--to", snapshotPath(target), "--tags", "persistence:durable,persistence:ephemeral", "--any-tag"]);
    assert.match(output, /matched:\s+2/);
    assert.match(output, /imported:\s+2/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});