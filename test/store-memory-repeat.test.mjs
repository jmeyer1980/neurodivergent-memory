import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const env = options.env ?? {};
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
      ...env,
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
    assert.match(secondText, /No net-new info/);

    const stats = await server.callTool(3, "memory_stats", {});
    const statsText = stats.result?.content?.[0]?.text ?? "";
    assert.match(statsText, /recent_high_similarity_writes:/);
    assert.match(statsText, /memory_2 -> memory_1/);
  } finally {
    server.stop();
  }
});

test("store_memory does not flag unrelated content that only shares boilerplate tokens", async () => {
  const server = startServer({
    env: {
      NEURODIVERGENT_MEMORY_REPEAT_THRESHOLD: "0.85",
    },
  });

  try {
    await server.callTool(30, "store_memory", {
      content: "This is a note about quantum computing error correction and logical qubits.",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      agent_id: "agent-alpha",
    });

    const second = await server.callTool(31, "store_memory", {
      content: "This is a note about Renaissance fresco painting and workshop apprentices.",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:research"],
      agent_id: "agent-alpha",
    });

    const secondText = second.result?.content?.[0]?.text ?? "";
    assert.doesNotMatch(secondText, /repeat_detected: true/);
    assert.doesNotMatch(secondText, /No net-new info/);
  } finally {
    server.stop();
  }
});

test("store_memory still flags near-duplicate content with a small appended detail", async () => {
  const server = startServer({
    env: {
      NEURODIVERGENT_MEMORY_REPEAT_THRESHOLD: "0.85",
    },
  });

  try {
    await server.callTool(40, "store_memory", {
      content: "Plan release validation checklist for RC handshake and packaged agent kit.",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      agent_id: "agent-alpha",
    });

    const second = await server.callTool(41, "store_memory", {
      content: "Plan release validation checklist for RC handshake and packaged agent kit with Linux smoke coverage.",
      district: "practical_execution",
      tags: ["topic:test", "scope:session", "kind:task", "layer:implementation"],
      agent_id: "agent-alpha",
    });

    const secondText = second.result?.content?.[0]?.text ?? "";
    assert.match(secondText, /repeat_detected: true/);
    assert.match(secondText, /matched_memory_id: memory_1/);
  } finally {
    server.stop();
  }
});

test("retrieve_memory suggests distillation after repeated logical reads of emotional content", async () => {
  const server = startServer({
    env: {
      NEURODIVERGENT_MEMORY_DISTILL_SUGGEST_THRESHOLD: "2",
    },
  });

  try {
    await server.callTool(10, "store_memory", {
      content: "I feel overloaded and keep circling the same frustration.",
      district: "emotional_processing",
      tags: ["topic:test", "scope:session", "kind:insight", "layer:debugging"],
      agent_id: "writer",
    });

    const firstRead = await server.callTool(11, "retrieve_memory", {
      memory_id: "memory_1",
      district: "logical_analysis",
      agent_id: "planner",
    });
    const firstText = firstRead.result?.content?.[0]?.text ?? "";
    assert.doesNotMatch(firstText, /Distillation suggested/);

    const secondRead = await server.callTool(12, "retrieve_memory", {
      memory_id: "memory_1",
      district: "logical_analysis",
      agent_id: "planner",
    });
    const secondText = secondRead.result?.content?.[0]?.text ?? "";
    assert.match(secondText, /Distillation suggested/);
    assert.match(secondText, /distill_memory/);
  } finally {
    server.stop();
  }
});

test("cross-district cooldown blocks follow-up writes when enabled", async () => {
  const server = startServer({
    env: {
      NEURODIVERGENT_MEMORY_PING_PONG_THRESHOLD: "1",
      NEURODIVERGENT_MEMORY_CROSS_DISTRICT_COOLDOWN_MS: "60000",
    },
  });

  try {
    await server.callTool(20, "store_memory", {
      content: "cooldown target",
      district: "logical_analysis",
      tags: ["topic:test", "scope:session", "kind:reference", "layer:research"],
      agent_id: "writer",
    });

    await server.callTool(21, "retrieve_memory", {
      memory_id: "memory_1",
      district: "creative_synthesis",
      agent_id: "reader",
    });

    const trigger = await server.callTool(22, "update_memory", {
      memory_id: "memory_1",
      content: "cooldown target updated",
      actor_district: "logical_analysis",
      agent_id: "writer",
    });
    const triggerText = trigger.result?.content?.[0]?.text ?? "";
    assert.match(triggerText, /Cross-district cooldown started/);

    const blocked = await server.callTool(23, "update_memory", {
      memory_id: "memory_1",
      content: "cooldown target blocked",
      actor_district: "creative_synthesis",
      agent_id: "writer",
    });
    const blockedText = blocked.result?.content?.[0]?.text ?? "";
    assert.equal(blocked.result?.isError, true);
    assert.match(blockedText, /NM_E012/);
    assert.match(blockedText, /Cross-district cooldown active/);
  } finally {
    server.stop();
  }
});
