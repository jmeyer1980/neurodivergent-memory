import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-infer-district-test-"));

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

test("store_memory infers a district when none is supplied", async () => {
  const server = startServer();

  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "Feeling anxious and overwhelmed about the upcoming deadline",
    });

    // emotional_processing district: description/activities mention feeling,
    // processing, reflecting, expressing, affective states.
    assert.match(resultText(stored), /Emotional Processing District/);
    assert.match(resultText(stored), /auto-inferred/);
  } finally {
    server.stop();
  }
});

test("store_memory does not label an explicit district as inferred", async () => {
  const server = startServer();

  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "Feeling anxious and overwhelmed about the upcoming deadline",
      district: "practical_execution",
    });

    assert.match(resultText(stored), /Practical Execution District/);
    assert.doesNotMatch(resultText(stored), /auto-inferred/);
  } finally {
    server.stop();
  }
});

test("store_memory falls back to practical_execution when content has no district signal", async () => {
  const server = startServer();

  try {
    const stored = await server.callTool(1, "store_memory", {
      content: "xk7q lorem ipsum placeholder text",
    });

    assert.match(resultText(stored), /Practical Execution District/);
  } finally {
    server.stop();
  }
});
