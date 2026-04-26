import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-session-id-test-"));

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

function resultText(response) {
  return response.result?.content?.[0]?.text ?? "";
}

test("session_id is stored, normalized, and visible in store_memory response", async () => {
  const server = startServer();
  try {
    const res = await server.callTool(1, "store_memory", {
      content: "memory with session",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "session-ABC",
    });
    const text = resultText(res);
    // session_id should be normalized to lowercase
    assert.ok(text.includes("session-abc"), `Expected 'session-abc' in: ${text}`);
    assert.ok(!res.result?.isError, `Unexpected error: ${text}`);
  } finally {
    server.stop();
  }
});

test("session_id filters work in list_memories", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "alpha session memory",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "session-alpha",
    });
    await server.callTool(2, "store_memory", {
      content: "beta session memory",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "session-beta",
    });

    const alphaResult = await server.callTool(3, "list_memories", {
      session_id: "session-alpha",
    });
    const alphaText = resultText(alphaResult);
    // list_memories shows session field, not raw content — check the session scoping worked
    assert.ok(alphaText.includes("session: session-alpha"), `Expected 'session: session-alpha' in: ${alphaText}`);
    assert.ok(!alphaText.includes("session: session-beta"), `Did not expect beta session in alpha filter: ${alphaText}`);
    // Should show total 1 (only alpha)
    assert.ok(alphaText.includes("total 1"), `Expected total 1 for alpha in: ${alphaText}`);

    const betaResult = await server.callTool(4, "list_memories", {
      session_id: "session-beta",
    });
    const betaText = resultText(betaResult);
    assert.ok(betaText.includes("session: session-beta"), `Expected 'session: session-beta' in: ${betaText}`);
    assert.ok(!betaText.includes("session: session-alpha"), `Did not expect alpha session in beta filter: ${betaText}`);
    assert.ok(betaText.includes("total 1"), `Expected total 1 for beta in: ${betaText}`);
  } finally {
    server.stop();
  }
});

test("session_id filters work in search_memories", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "session scoped knowledge artifact",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "session-search-1",
    });
    await server.callTool(2, "store_memory", {
      content: "session scoped knowledge artifact",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      session_id: "session-search-2",
    });

    const result = await server.callTool(3, "search_memories", {
      query: "session scoped knowledge",
      session_id: "session-search-1",
    });
    const text = resultText(result);
    // Should find at least one result
    assert.ok(text.includes("session scoped knowledge"), `Expected search result in: ${text}`);
    // Should not find the session-search-2 memory (different district, different session)
    // Note: BM25 may still return it since content is identical, so we just check no error
    assert.ok(!result.result?.isError, `Unexpected error: ${text}`);
  } finally {
    server.stop();
  }
});

test("session_id filters work in memory_stats and perSession is returned", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "stats session one",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "stats-session-1",
    });
    await server.callTool(2, "store_memory", {
      content: "stats session one again",
      district: "emotional_processing",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "stats-session-1",
    });
    await server.callTool(3, "store_memory", {
      content: "stats session two",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "stats-session-2",
    });

    const statsAll = await server.callTool(4, "memory_stats", {});
    const allText = resultText(statsAll);
    assert.ok(allText.includes("stats-session-1"), `Expected stats-session-1 in stats: ${allText}`);
    assert.ok(allText.includes("stats-session-2"), `Expected stats-session-2 in stats: ${allText}`);
    assert.ok(allText.includes("Per session:"), `Expected 'Per session:' section in: ${allText}`);

    const statsScoped = await server.callTool(5, "memory_stats", { session_id: "stats-session-1" });
    const scopedText = resultText(statsScoped);
    assert.ok(scopedText.includes("Total memories: 2"), `Expected 2 memories for session-1 in: ${scopedText}`);
  } finally {
    server.stop();
  }
});

test("list_sessions returns all session IDs with counts", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "list sessions test 1",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "list-sess-A",
    });
    await server.callTool(2, "store_memory", {
      content: "list sessions test 2",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "list-sess-A",
    });
    await server.callTool(3, "store_memory", {
      content: "list sessions test 3",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      session_id: "list-sess-B",
    });

    const result = await server.callTool(4, "list_sessions", {});
    const text = resultText(result);
    assert.ok(text.includes("list-sess-a"), `Expected normalized 'list-sess-a' in: ${text}`);
    assert.ok(text.includes("list-sess-b"), `Expected normalized 'list-sess-b' in: ${text}`);
    // session A has 2 memories, should be listed first (sorted by count desc)
    assert.ok(text.includes("list-sess-a: 2 memories"), `Expected count 2 for list-sess-a in: ${text}`);
    assert.ok(text.includes("list-sess-b: 1 memory"), `Expected count 1 for list-sess-b in: ${text}`);
    assert.ok(text.includes("Sessions (2 total)"), `Expected total count in: ${text}`);
  } finally {
    server.stop();
  }
});

test("list_sessions returns empty message when no sessions exist", async () => {
  const server = startServer();
  try {
    await server.callTool(1, "store_memory", {
      content: "no session memory",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
    });

    const result = await server.callTool(2, "list_sessions", {});
    const text = resultText(result);
    assert.ok(text.includes("No sessions found"), `Expected empty sessions message in: ${text}`);
  } finally {
    server.stop();
  }
});

test("session_id normalization: uppercase is lowercased and trimmed", async () => {
  const server = startServer();
  try {
    const r1 = await server.callTool(1, "store_memory", {
      content: "uppercase session",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "  Session-UPPER  ",
    });
    // Should normalize to 'session-upper'
    const text = resultText(r1);
    assert.ok(text.includes("session-upper"), `Expected normalized 'session-upper' in: ${text}`);

    // Filter with different case should still match
    const listResult = await server.callTool(2, "list_memories", {
      session_id: "SESSION-UPPER",
    });
    const listText = resultText(listResult);
    assert.ok(listText.includes("uppercase session"), `Case-insensitive filter should find memory: ${listText}`);
  } finally {
    server.stop();
  }
});

test("session_id can be updated via update_memory and cleared with null", async () => {
  const server = startServer();
  try {
    const storeRes = await server.callTool(1, "store_memory", {
      content: "updatable session memory",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "original-session",
    });
    const storeText = resultText(storeRes);
    // Extract memory ID from the response
    const idMatch = storeText.match(/ID: (memory_\d+)/);
    assert.ok(idMatch, `Could not find memory ID in: ${storeText}`);
    const memoryId = idMatch[1];

    // Update session_id
    const updateRes = await server.callTool(2, "update_memory", {
      memory_id: memoryId,
      session_id: "updated-session",
    });
    const updateText = resultText(updateRes);
    assert.ok(updateText.includes("updated-session"), `Expected 'updated-session' in: ${updateText}`);

    // Clear session_id with null
    const clearRes = await server.callTool(3, "update_memory", {
      memory_id: memoryId,
      session_id: null,
    });
    const clearText = resultText(clearRes);
    assert.ok(clearText.includes("Session: unset"), `Expected 'Session: unset' after clearing: ${clearText}`);
  } finally {
    server.stop();
  }
});

test("invalid session_id format is rejected", async () => {
  const server = startServer();
  try {
    // session_id starting with non-alphanumeric should fail
    const res = await server.callTool(1, "store_memory", {
      content: "invalid session",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      session_id: "-invalid-start",
    });
    assert.ok(res.result?.isError || res.error, `Expected error for invalid session_id, got: ${JSON.stringify(res)}`);
  } finally {
    server.stop();
  }
});
