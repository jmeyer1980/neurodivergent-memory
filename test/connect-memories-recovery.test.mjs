import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-connect-recovery-test-"));

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

test("connect_memories NM_E004 prefers project-scoped recent hints when enough scoped memories exist", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "store_memory", {
      content: "alpha root memory",
      district: "practical_execution",
      project_id: "alpha",
      tags: ["topic:test", "scope:project", "kind:task", "layer:implementation"],
    });

    await server.callTool(2, "store_memory", {
      content: "alpha sibling one",
      district: "logical_analysis",
      project_id: "alpha",
      tags: ["topic:test", "scope:project", "kind:reference", "layer:research"],
    });

    await server.callTool(3, "store_memory", {
      content: "alpha sibling two",
      district: "logical_analysis",
      project_id: "alpha",
      tags: ["topic:test", "scope:project", "kind:reference", "layer:research"],
    });

    await server.callTool(4, "store_memory", {
      content: "alpha sibling three",
      district: "creative_synthesis",
      project_id: "alpha",
      tags: ["topic:test", "scope:project", "kind:insight", "layer:research"],
    });

    await server.callTool(5, "store_memory", {
      content: "global distractor memory",
      district: "vigilant_monitoring",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:debugging"],
    });

    const failed = await server.callTool(6, "connect_memories", {
      memory_id_1: "memory_4",
      memory_id_2: "memory_999",
    });

    const text = resultText(failed);
    assert.match(text, /Code: NM_E004/);
    assert.match(text, /recent_memory_hints:/);
    assert.match(text, /scope_used: project:alpha/);
    assert.doesNotMatch(text, /global_fallback/);
    assert.match(text, /memory_3 —/);
    assert.match(text, /memory_2 —/);
    assert.match(text, /memory_1 —/);
    assert.doesNotMatch(text, /memory_5 —/);
    assert.match(text, /tip: connect_memories requires exact memory_id strings/);
  } finally {
    server.stop();
  }
});

test("connect_memories NM_E004 falls back to global recent hints when scoped set is too small", async () => {
  const server = startServer();

  try {
    await server.callTool(10, "store_memory", {
      content: "alpha root memory",
      district: "practical_execution",
      project_id: "alpha",
      tags: ["topic:test", "scope:project", "kind:task", "layer:implementation"],
    });

    await server.callTool(11, "store_memory", {
      content: "alpha only sibling",
      district: "logical_analysis",
      project_id: "alpha",
      tags: ["topic:test", "scope:project", "kind:reference", "layer:research"],
    });

    await server.callTool(12, "store_memory", {
      content: "global recent one",
      district: "creative_synthesis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
    });

    await server.callTool(13, "store_memory", {
      content: "global recent two",
      district: "vigilant_monitoring",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:debugging"],
    });

    const failed = await server.callTool(14, "connect_memories", {
      memory_id_1: "memory_1",
      memory_id_2: "memory_404",
    });

    const text = resultText(failed);
    assert.match(text, /Code: NM_E004/);
    assert.match(text, /scope_used: project:alpha\+global_fallback/);
    assert.match(text, /memory_2 —/);
    assert.match(text, /memory_4 —/);
    assert.match(text, /memory_3 —/);
    assert.match(text, /missing_id: memory_404/);
  } finally {
    server.stop();
  }
});

test("connect_memories NM_E004 uses global recent hints when neither requested memory exists", async () => {
  const server = startServer();

  try {
    await server.callTool(20, "store_memory", {
      content: "global recent one",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });

    await server.callTool(21, "store_memory", {
      content: "global recent two",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    });

    await server.callTool(22, "store_memory", {
      content: "global recent three",
      district: "creative_synthesis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
    });

    const failed = await server.callTool(23, "connect_memories", {
      memory_id_1: "memory_404",
      memory_id_2: "memory_405",
    });

    const text = resultText(failed);
    assert.match(text, /Code: NM_E004/);
    assert.match(text, /scope_used: global/);
    assert.match(text, /memory_3 —/);
    assert.match(text, /memory_2 —/);
    assert.match(text, /memory_1 —/);
    assert.match(text, /missing_id: memory_404/);
  } finally {
    server.stop();
  }
});