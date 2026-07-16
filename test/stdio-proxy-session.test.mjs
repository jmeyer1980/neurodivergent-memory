import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
import { spawn } from "node:child_process";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

test("stdio-proxy forwards initialize to the daemon and reuses the returned session for later calls", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-proxy-session-test-"));
  const daemonPort = await getFreePort();
  const memoryFile = path.join(tempDir, "memories.json");

  const proxy = spawn(process.execPath, [path.join(process.cwd(), "build", "index.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_MODE: "proxy",
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
      NEURODIVERGENT_MEMORY_FILE: memoryFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  proxy.stderr.on("data", (c) => { stderr += c.toString(); });

  const rl = readline.createInterface({ input: proxy.stdout });
  const pending = new Map();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore non-JSON noise */ }
  });

  function send(id, method, params) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  try {
    const initResult = await send(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "proxy-test-agent", version: "1.0.0" },
    });
    assert.ok(initResult.result, `initialize failed: ${JSON.stringify(initResult)}\n${stderr}`);

    const storeResult = await send(2, "tools/call", { name: "store_memory", arguments: { content: "stdio proxy session identity test" } });
    assert.ok(!storeResult.error, `store_memory failed: ${JSON.stringify(storeResult)}\n${stderr}`);
    const text = storeResult.result.content[0].text;
    assert.match(text, /Agent: proxy-test-agent/, "identity should flow from clientInfo through the proxy to the daemon");
  } finally {
    proxy.kill();
  }
});
