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

  function listPrompts(id) {
    return request(id, "prompts/list", {});
  }

  function getPrompt(id, name) {
    return request(id, "prompts/get", { name, arguments: {} });
  }

  function stop() {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { callTool, getPrompt, listPrompts, stop };
}

function resourceMessages(promptResponse) {
  return (promptResponse.result?.messages ?? []).filter(message => message.content?.type === "resource");
}

function toolResourceContentBlocks(toolResponse) {
  return (toolResponse.result?.content ?? []).filter(content => content.type === "resource");
}

function toolTextContent(toolResponse) {
  return (toolResponse.result?.content ?? []).filter(content => content.type === "text").map(content => content.text ?? "");
}

function introText(promptResponse) {
  return promptResponse.result?.messages?.[0]?.content?.text ?? "";
}

function resourceJson(promptResponse) {
  return resourceMessages(promptResponse).map(message => JSON.parse(message.content.resource.text));
}

function resourceUris(promptResponse) {
  return resourceMessages(promptResponse).map(message => message.content.resource.uri);
}

test("prompts/list exposes explicit prompt metadata for compatibility-sensitive clients", async () => {
  const server = startServer();

  try {
    const prompts = await server.listPrompts(50);
    assert.deepEqual(
      prompts.result?.prompts?.map(prompt => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
      })),
      [
        {
          name: "explore_memory_city",
          description: "Explore the neurodivergent memory city and its districts",
          arguments: [],
        },
        {
          name: "synthesize_memories",
          description: "Create new insights by connecting existing memories",
          arguments: [],
        },
        {
          name: "synthesize_memory_packets",
          description: "Create new insights from packetized memory slices for attachment-constrained clients",
          arguments: [],
        },
      ],
    );
  } finally {
    server.stop();
  }
});

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

test("synthesize_memories prompt preserves explicit older coverage in mixed mode", async () => {
  const server = startServer();

  try {
    for (let index = 0; index < 80; index += 1) {
      await server.callTool(index + 1, "store_memory", {
        content: `coverage memory ${index + 1}`,
        district: "logical_analysis",
        tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      });
    }

    const prompt = await server.getPrompt(150, "synthesize_memories");
    const uris = new Set(resourceUris(prompt));
    assert.equal(uris.size, 75);
    assert.equal(uris.has("memory://memory/memory_1"), true);
    assert.equal(uris.has("memory://memory/memory_80"), true);
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
    assert.equal(manifest.max_memories_per_slice, 20);

    const coveredIds = new Set(
      slices.flatMap(packet => packet.memories.map(memory => memory.id)),
    );
    assert.equal(coveredIds.size, 80);
    assert.equal(slices.every(packet => packet.packet_type === "memory_slice"), true);
  } finally {
    server.stop();
  }
});

test("synthesize_memory_packets prompt grows slice count to keep packet sizes bounded", async () => {
  const server = startServer();

  try {
    const entries = Array.from({ length: 250 }, (_, index) => ({
      content: `very large packet memory ${index + 1}`,
      district: index % 2 === 0 ? "logical_analysis" : "practical_execution",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
    }));

    await server.callTool(1, "import_memories", { entries });

    const prompt = await server.getPrompt(202, "synthesize_memory_packets");
    const packets = resourceJson(prompt);
    const manifest = packets[0];
    const slices = packets.slice(1);

    assert.equal(manifest.total_memories, 250);
    assert.equal(manifest.slice_count > 8, true);
    assert.equal(slices.every(packet => packet.memories.length <= 20), true);
  } finally {
    server.stop();
  }
});

test("prepare_synthesis_context tool mirrors the synthesize_memories prompt payload", async () => {
  const server = startServer();

  try {
    for (let index = 0; index < 12; index += 1) {
      await server.callTool(index + 1, "store_memory", {
        content: `mirror memory ${index + 1}`,
        district: index % 2 === 0 ? "logical_analysis" : "practical_execution",
        tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      });
    }

    const prompt = await server.getPrompt(300, "synthesize_memories");
    const tool = await server.callTool(301, "prepare_synthesis_context", {});

    assert.deepEqual(
      toolTextContent(tool),
      (prompt.result?.messages ?? [])
        .filter(message => message.content?.type === "text")
        .map(message => message.content.text ?? ""),
    );
    assert.deepEqual(
      toolResourceContentBlocks(tool).map(content => content.resource.uri),
      resourceUris(prompt),
    );
  } finally {
    server.stop();
  }
});

test("prepare_packetized_synthesis_context tool mirrors packet prompt resources", async () => {
  const server = startServer();

  try {
    for (let index = 0; index < 24; index += 1) {
      await server.callTool(index + 1, "store_memory", {
        content: `packet mirror memory ${index + 1}`,
        district: [
          "logical_analysis",
          "emotional_processing",
          "practical_execution",
          "vigilant_monitoring",
          "creative_synthesis",
        ][index % 5],
        tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      });
    }

    const prompt = await server.getPrompt(400, "synthesize_memory_packets");
    const tool = await server.callTool(401, "prepare_packetized_synthesis_context", {});

    assert.deepEqual(
      toolResourceContentBlocks(tool).map(content => content.resource.uri),
      resourceUris(prompt),
    );
    assert.deepEqual(
      toolTextContent(tool),
      (prompt.result?.messages ?? [])
        .filter(message => message.content?.type === "text")
        .map(message => message.content.text ?? ""),
    );
  } finally {
    server.stop();
  }
});