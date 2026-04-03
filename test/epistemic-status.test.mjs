import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-epistemic-test-"));

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

function hasResult(response, memoryId) {
  return resultText(response).includes(memoryId);
}

test("planning task memories default to draft when epistemic_status is omitted", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "Plan the next release validation slice",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Epistemic status: draft/);
  } finally {
    server.stop();
  }
});

test("non-task memories remain unset when epistemic_status is omitted", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "Reference note that should remain unset",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:implementation"],
    });

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Epistemic status: unset/);
  } finally {
    server.stop();
  }
});

test("import_memories applies the draft default to practical task entries without epistemic_status", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "import_memories", {
      entries: [
        {
          content: "Imported planning task",
          district: "practical_execution",
          tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
        },
      ],
    });

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Epistemic status: draft/);
  } finally {
    server.stop();
  }
});

test("list_memories filters by epistemic_statuses", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "Draft planning note",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });

    await server.callTool(2, "store_memory", {
      content: "Validated release note",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      epistemic_status: "validated",
    });

    const filtered = await server.callTool(3, "list_memories", {
      epistemic_statuses: ["validated"],
      page_size: 20,
    });

    assert.equal(hasResult(filtered, "memory_1"), false);
    assert.equal(hasResult(filtered, "memory_2"), true);
  } finally {
    server.stop();
  }
});

test("related_to filters by epistemic_statuses", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "Planning root memory",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });

    await server.callTool(2, "store_memory", {
      content: "Connected draft follow-up",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });

    await server.callTool(3, "store_memory", {
      content: "Connected validated follow-up",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      epistemic_status: "validated",
    });

    await server.callTool(4, "connect_memories", { memory_id_1: "memory_1", memory_id_2: "memory_2" });
    await server.callTool(5, "connect_memories", { memory_id_1: "memory_1", memory_id_2: "memory_3" });

    const filtered = await server.callTool(6, "related_to", {
      memory_id: "memory_1",
      query: "Connected follow-up",
      epistemic_statuses: ["validated"],
    });

    assert.equal(hasResult(filtered, "memory_2"), false);
    assert.equal(hasResult(filtered, "memory_3"), true);
  } finally {
    server.stop();
  }
});
