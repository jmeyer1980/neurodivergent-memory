#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const targetFromArgs = process.argv.slice(2).join(" ").trim();
const target = targetFromArgs || process.env.NDM_SMOKE_TARGET || "node build/index.js";

function extractText(response) {
  return response?.result?.content?.map((entry) => entry?.text ?? "").join("\n") ?? "";
}

function isToolError(response) {
  return Boolean(response?.result?.isError);
}

function startServer(command) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-live-smoke-"));
  const child = spawn(command, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_LOG_LEVEL: process.env.NEURODIVERGENT_MEMORY_LOG_LEVEL || "error",
    },
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
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

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
  });

  function callTool(id, name, args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to request ${id} (${name})`));
      }, timeoutMs);

      pending.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      const request = {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      };

      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  function stop() {
    if (!child.killed) {
      child.kill();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  function getStderr() {
    return stderrBuffer;
  }

  return { callTool, stop, getStderr };
}

async function run() {
  console.log(`Running live smoke against target: ${target}`);
  const server = startServer(target);

  try {
    const r1 = await server.callTool(1, "store_memory", {
      content: "alpha memory for scoped retrieval",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      project_id: "alpha",
    });
    assert.equal(isToolError(r1), false, `store_memory alpha failed: ${extractText(r1)}`);

    const r2 = await server.callTool(2, "store_memory", {
      content: "beta memory for scoped retrieval",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      project_id: "beta",
    });
    assert.equal(isToolError(r2), false, `store_memory beta failed: ${extractText(r2)}`);

    const r3 = await server.callTool(3, "import_memories", {
      entries: [
        {
          content: "alpha imported memory",
          district: "logical_analysis",
          tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
          project_id: "alpha",
        },
        {
          content: "unset imported memory",
          district: "creative_synthesis",
          tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
        },
      ],
    });
    assert.equal(isToolError(r3), false, `import_memories failed: ${extractText(r3)}`);

    const listAlpha = await server.callTool(4, "list_memories", { project_id: "alpha", page_size: 20 });
    const listAlphaText = extractText(listAlpha);
    assert.equal(isToolError(listAlpha), false, `list_memories alpha failed: ${listAlphaText}`);
    assert.match(listAlphaText, /project: alpha/, "alpha list should include alpha-attributed records");
    assert.doesNotMatch(listAlphaText, /project: beta/, "alpha list should exclude beta-attributed records");

    const searchAlpha = await server.callTool(5, "search_memories", {
      query: "scoped retrieval memory",
      project_id: "alpha",
      min_score: 0,
    });
    const searchAlphaText = extractText(searchAlpha);
    assert.equal(isToolError(searchAlpha), false, `search_memories alpha failed: ${searchAlphaText}`);
    assert.match(searchAlphaText, /Found/, "alpha scoped search should return matches");

    const statsAlpha = await server.callTool(6, "memory_stats", { project_id: "alpha" });
    const statsAlphaText = extractText(statsAlpha);
    assert.equal(isToolError(statsAlpha), false, `memory_stats alpha failed: ${statsAlphaText}`);
    assert.match(statsAlphaText, /Scope project_id: alpha/);
    assert.match(statsAlphaText, /Per project:\n\s+alpha: 2/);

    const clearProject = await server.callTool(7, "update_memory", {
      memory_id: "memory_1",
      project_id: null,
    });
    assert.equal(isToolError(clearProject), false, `update_memory clear project_id failed: ${extractText(clearProject)}`);

    const listAlphaAfterClear = await server.callTool(8, "list_memories", { project_id: "alpha", page_size: 20 });
    const listAlphaAfterClearText = extractText(listAlphaAfterClear);
    assert.equal(isToolError(listAlphaAfterClear), false, `list_memories alpha after clear failed: ${listAlphaAfterClearText}`);
    assert.doesNotMatch(listAlphaAfterClearText, /memory_1/, "memory_1 should no longer be in alpha scope after clear");

    const invalidProject = await server.callTool(9, "store_memory", {
      content: "invalid project id should fail",
      district: "practical_execution",
      project_id: "bad!",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
    });
    const invalidText = extractText(invalidProject);
    assert.equal(isToolError(invalidProject), true, "invalid project_id should produce tool error response");
    assert.match(invalidText, /Code: NM_E020/, "invalid project_id should return NM_E020");

    console.log("Live project_id smoke passed.");
  } finally {
    server.stop();
    const stderr = server.getStderr();
    if (stderr.trim()) {
      console.error("Target stderr (informational):");
      console.error(stderr.trim());
    }
  }
}

run().catch((err) => {
  console.error("Live project_id smoke failed.");
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
