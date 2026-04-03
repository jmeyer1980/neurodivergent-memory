import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-handshake-test-"));

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

  function request(id, method, params = {}, timeoutMs = 15000) {
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
        method,
        params,
      })}\n`);
    });
  }

  function callTool(id, name, args, timeoutMs = 15000) {
    return request(id, "tools/call", { name, arguments: args }, timeoutMs);
  }

  function listTools(id, timeoutMs = 15000) {
    return request(id, "tools/list", {}, timeoutMs);
  }

  function stop() {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { callTool, listTools, stop };
}

function resultText(response) {
  return response.result?.content?.[0]?.text ?? "";
}

test("tools/list includes server_handshake", async () => {
  const server = startServer();

  try {
    const response = await server.listTools(1);
    const tools = response.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);

    assert.equal(names.includes("server_handshake"), true);
  } finally {
    server.stop();
  }
});

test("server_handshake returns runtime version details", async () => {
  const server = startServer();

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

    const response = await server.callTool(2, "server_handshake", {});
    const text = resultText(response);

    assert.match(text, /Server Handshake/);
    assert.match(text, new RegExp(`Name: ${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(text, new RegExp(`Version: ${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(text, /Started:/);
    assert.match(text, /PID:/);
    assert.match(text, /Node\.js:/);
    assert.match(text, /Transport: stdio/);
  } finally {
    server.stop();
  }
});
