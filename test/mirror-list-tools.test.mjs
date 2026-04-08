// Ensure all async resources are closed after tests
import process from "node:process";
// Last-resort: force exit after all tests complete
test("cleanup", async () => {
  setTimeout(() => process.exit(0), 100);
});
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { suggestToolName } from "../build/index.js";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-mirror-list-tools-test-"));
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
        params: { name, arguments: args },
      })}\n`);
    });
  }
  function stop() {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return { callTool, stop };
}

test("mirror_list_tools returns available tools for weak-client recovery", async () => {
  const server = startServer();
  const timeout = setTimeout(() => {
    server.stop();
    throw new Error("Test timed out: mirror_list_tools did not respond in time");
  }, 10000); // 10 seconds
  try {
    const response = await server.callTool(1, "mirror_list_tools", {});
    clearTimeout(timeout);
    assert.ok(response.result);
    assert.ok(Array.isArray(response.result.tools));
    assert.ok(response.result.tools.length > 0);
    assert.ok(response.result.tools.some(t => t.name === "mirror_list_tools"));
  } finally {
    server.stop();
  }
});

test("suggestToolName returns best match for typo-tolerant queries", async () => {
  const tools = [
    { name: "list_tools" },
    { name: "store_memory" },
    { name: "connect_memories" },
    { name: "mirror_list_tools" },
  ];
  assert.strictEqual(suggestToolName(tools, "listtols"), "list_tools");
  assert.strictEqual(suggestToolName(tools, "conect_memories"), "connect_memories");
  assert.strictEqual(suggestToolName(tools, "mirrorlisttools"), "mirror_list_tools");
  assert.strictEqual(suggestToolName(tools, "storememory"), "store_memory");
});
