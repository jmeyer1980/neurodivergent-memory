import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-repeat-test-"));
  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_REPEAT_THRESHOLD: "0.01",
      NEURODIVERGENT_MEMORY_LOOP_WINDOW: "40",
      NEURODIVERGENT_MEMORY_PING_PONG_THRESHOLD: "2",
      NEURODIVERGENT_MEMORY_LOG_LEVEL: "error",
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

test("store_memory repeat detection surfaces in tool response and memory_stats telemetry", async () => {
  const server = startServer();

  try {
    const first = await server.callTool(1, "store_memory", {
      content: "repeatable planning note for telemetry regression",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      agent_id: "agent-alpha",
    });

    assert.ok(first.result);

    const second = await server.callTool(2, "store_memory", {
      content: "repeatable planning note for telemetry regression",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      agent_id: "agent-alpha",
    });

    const secondText = second.result?.content?.[0]?.text ?? "";
    assert.match(secondText, /repeat_detected: true/);
    assert.match(secondText, /matched_memory_id: memory_1/);

    const stats = await server.callTool(3, "memory_stats", {});
    const statsText = stats.result?.content?.[0]?.text ?? "";
    assert.match(statsText, /recent_high_similarity_writes:/);
    assert.match(statsText, /memory_2 -> memory_1/);
  } finally {
    server.stop();
  }
});
