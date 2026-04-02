import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-synthesize-prompt-test-"));

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

  function request(id, method, params) {
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
        method,
        params,
      })}\n`);
    });
  }

  function callTool(id, name, args) {
    return request(id, "tools/call", {
      name,
      arguments: args,
    });
  }

  function getPrompt(id, name) {
    return request(id, "prompts/get", { name, arguments: {} });
  }

  function stop() {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { callTool, getPrompt, stop };
}

function resourceMessages(promptResponse) {
  return (promptResponse.result?.messages ?? []).filter(message => message.content?.type === "resource");
}

function introText(promptResponse) {
  return promptResponse.result?.messages?.[0]?.content?.text ?? "";
}

function resourceJson(promptResponse) {
  return resourceMessages(promptResponse).map(message => JSON.parse(message.content.resource.text));
}

test("synthesize_memories prompt includes all memories when graph is modest", async () => {
  const server = startServer();

  try {
    for (let index = 0; index < 12; index += 1) {
      await server.callTool(index + 1, "store_memory", {
        content: `memory ${index + 1}`,
        district: index % 2 === 0 ? "logical_analysis" : "practical_execution",
        tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      });
    }

    const prompt = await server.getPrompt(100, "synthesize_memories");
    assert.match(introText(prompt), /all 12 currently stored memories/i);
    assert.equal(resourceMessages(prompt).length, 12);
  } finally {
    server.stop();
  }
});

test("synthesize_memories prompt uses a broader mixed set when memory graph is large", async () => {
  const server = startServer();

  try {
    const entries = Array.from({ length: 80 }, (_, index) => ({
      content: `bulk memory ${index + 1}`,
      district: index % 5 === 0
        ? "logical_analysis"
        : index % 5 === 1
          ? "emotional_processing"
          : index % 5 === 2
            ? "practical_execution"
            : index % 5 === 3
              ? "vigilant_monitoring"
              : "creative_synthesis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    }));

    await server.callTool(1, "import_memories", { entries });

    const prompt = await server.getPrompt(101, "synthesize_memories");
    assert.match(introText(prompt), /broad cross-section of 75 memories selected from 80 total memories/i);
    assert.equal(resourceMessages(prompt).length, 75);
  } finally {
    server.stop();
  }
});

test("synthesize_memory_packets prompt emits manifest plus slices covering the full small graph", async () => {
  const server = startServer();

  try {
    for (let index = 0; index < 12; index += 1) {
      await server.callTool(index + 1, "store_memory", {
        content: `packet memory ${index + 1}`,
        district: index % 2 === 0 ? "logical_analysis" : "practical_execution",
        tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      });
    }

    const prompt = await server.getPrompt(200, "synthesize_memory_packets");
    assert.match(introText(prompt), /1 coverage manifest plus 1 structured memory slices spanning all 12 stored memories/i);

    const packets = resourceJson(prompt);
    assert.equal(packets[0].packet_type, "coverage_manifest");
    assert.equal(packets[0].total_memories, 12);
    assert.equal(packets[0].slice_count, 1);
    assert.equal(packets.length, 2);
    assert.equal(packets[1].packet_type, "memory_slice");
    assert.equal(packets[1].memory_count, 12);
    assert.equal(new Set(packets[1].memories.map(memory => memory.id)).size, 12);
  } finally {
    server.stop();
  }
});

test("synthesize_memory_packets prompt emits bounded slice packets covering the full large graph", async () => {
  const server = startServer();

  try {
    const entries = Array.from({ length: 80 }, (_, index) => ({
      content: `packet bulk memory ${index + 1}`,
      district: index % 5 === 0
        ? "logical_analysis"
        : index % 5 === 1
          ? "emotional_processing"
          : index % 5 === 2
            ? "practical_execution"
            : index % 5 === 3
              ? "vigilant_monitoring"
              : "creative_synthesis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    }));

    await server.callTool(1, "import_memories", { entries });

    const prompt = await server.getPrompt(201, "synthesize_memory_packets");
    assert.match(introText(prompt), /1 coverage manifest plus 7 structured memory slices spanning all 80 stored memories/i);

    const packets = resourceJson(prompt);
    const manifest = packets[0];
    const slices = packets.slice(1);
    assert.equal(manifest.packet_type, "coverage_manifest");
    assert.equal(manifest.total_memories, 80);
    assert.equal(manifest.slice_count, 7);
    assert.equal(packets.length, 8);

    const coveredIds = new Set(
      slices.flatMap(packet => packet.memories.map(memory => memory.id)),
    );
    assert.equal(coveredIds.size, 80);
    assert.equal(slices.every(packet => packet.packet_type === "memory_slice"), true);
  } finally {
    server.stop();
  }
});