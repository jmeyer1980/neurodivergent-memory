import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-agent-identity-test-"));

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

test("store_memory records agent_id and it appears in retrieve_memory output", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "agent identity test memory",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      agent_id: "test-agent-alpha",
    });

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Agent: test-agent-alpha/);
  } finally {
    server.stop();
  }
});

test("store_memory without agent_id shows unassigned in retrieve_memory output", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "anonymous memory no agent",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Agent: unassigned/);
  } finally {
    server.stop();
  }
});

test("memory_stats reports per-agent contribution breakdown", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "memory from agent-a",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      agent_id: "agent-a",
    });

    await server.callTool(2, "store_memory", {
      content: "another memory from agent-a",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      agent_id: "agent-a",
    });

    await server.callTool(3, "store_memory", {
      content: "memory from agent-b",
      district: "vigilant_monitoring",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      agent_id: "agent-b",
    });

    const stats = await server.callTool(4, "memory_stats", {});
    const text = resultText(stats);

    assert.match(text, /Per agent:/);
    assert.match(text, /agent-a: 2/);
    assert.match(text, /agent-b: 1/);
  } finally {
    server.stop();
  }
});

test("memory_stats counts unassigned memories when no agent_id provided", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "unattributed memory",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    const stats = await server.callTool(2, "memory_stats", {});
    assert.match(resultText(stats), /unassigned: 1/);
  } finally {
    server.stop();
  }
});

test("import_memories stores agent_id from per-entry field", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "import_memories", {
      entries: [
        {
          content: "imported memory with agent",
          district: "logical_analysis",
          tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
          agent_id: "import-agent",
        },
      ],
    });

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Agent: import-agent/);
  } finally {
    server.stop();
  }
});

test("import_memories remains backward-compatible without agent_id", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "import_memories", {
      entries: [
        {
          content: "imported memory without agent attribution",
          district: "logical_analysis",
          tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
        },
      ],
    });

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Agent: unassigned/);
  } finally {
    server.stop();
  }
});

test("import_memories applies default agent_id to entries without one", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "import_memories", {
      entries: [
        {
          content: "imported memory inheriting default agent",
          district: "logical_analysis",
          tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
        },
      ],
      agent_id: "default-import-agent",
    });

    const retrieved = await server.callTool(2, "retrieve_memory", { memory_id: "memory_1" });
    assert.match(resultText(retrieved), /Agent: default-import-agent/);
  } finally {
    server.stop();
  }
});

test("connect_memories remains backward-compatible without agent_id", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "first node",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    await server.callTool(2, "store_memory", {
      content: "second node",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });

    const connected = await server.callTool(3, "connect_memories", {
      memory_id_1: "memory_1",
      memory_id_2: "memory_2",
    });

    assert.match(resultText(connected), /Connected memories memory_1 and memory_2/);
    assert.match(resultText(connected), /Agent: unassigned/);
  } finally {
    server.stop();
  }
});

test("connect_memories accepts agent_id without error and confirms connection", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "first node",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    await server.callTool(2, "store_memory", {
      content: "second node",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });

    const connected = await server.callTool(3, "connect_memories", {
      memory_id_1: "memory_1",
      memory_id_2: "memory_2",
      agent_id: "connector-agent",
    });

    assert.match(resultText(connected), /Connected memories memory_1 and memory_2/);
    assert.match(resultText(connected), /Agent: connector-agent/);
  } finally {
    server.stop();
  }
});

test("agent_id does not affect unfiltered search inclusion", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "search ranking test alpha content",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      agent_id: "agent-x",
    });

    await server.callTool(2, "store_memory", {
      content: "search ranking test beta content extra match",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      agent_id: "agent-y",
    });

    // Without agent filter, both memories should appear — agent_id doesn't affect ranking
    const results = await server.callTool(3, "search_memories", {
      query: "search ranking test",
      min_score: 0,
    });

    const text = resultText(results);
    assert.ok(text.includes("memory_1"), "memory from agent-x should appear in unfiltered search");
    assert.ok(text.includes("memory_2"), "memory from agent-y should appear in unfiltered search");
  } finally {
    server.stop();
  }
});
