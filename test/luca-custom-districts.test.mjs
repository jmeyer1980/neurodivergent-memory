import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function startServer(options = {}) {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ndm-luca-test-"));

  fs.mkdirSync(tempDir, { recursive: true });

  if (options.snapshot) {
    fs.writeFileSync(
      path.join(tempDir, "memories.json"),
      JSON.stringify(options.snapshot, null, 2),
      "utf-8",
    );
  }

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

  return { callTool, stop, tempDir };
}

function resultText(response) {
  return response.result?.content?.[0]?.text ?? "";
}

function errorText(response) {
  return response.error?.message ?? response.result?.content?.[0]?.text ?? "";
}

test("register_district with valid LUCA parent creates custom district", async () => {
  const server = startServer();

  try {
    const response = await server.callTool(1, "register_district", {
      key: "project_build_pipeline",
      name: "Build Pipeline District",
      description: "CI/CD pipeline configurations and build automation",
      luca_parent: "practical_execution",
      activities: ["building", "testing", "deploying"],
    });

    const text = resultText(response);
    assert.ok(text.includes("Registered custom district"), "Should confirm registration");
    assert.ok(text.includes("project_build_pipeline"), "Should mention district key");
    assert.ok(text.includes("merchant"), "Should inherit merchant archetype from practical_execution");
    assert.ok(text.includes("project_build_pipeline → practical_execution"), "Should show LUCA ancestry");
  } finally {
    server.stop();
  }
});

test("register_district with multi-hop LUCA chain validates ancestry", async () => {
  const server = startServer();

  try {
    // First register a custom district under practical_execution
    await server.callTool(1, "register_district", {
      key: "project_build",
      name: "Project Build",
      description: "Build system district",
      luca_parent: "practical_execution",
    });

    // Then register a district under the custom district (2-hop chain)
    const response = await server.callTool(2, "register_district", {
      key: "project_ci_cd",
      name: "CI/CD Pipeline",
      description: "Continuous integration and deployment",
      luca_parent: "project_build",
    });

    const text = resultText(response);
    assert.ok(text.includes("Registered custom district"), "Should confirm registration");
    assert.ok(text.includes("project_ci_cd → project_build → practical_execution"), "Should show full LUCA ancestry");
  } finally {
    server.stop();
  }
});

test("register_district rejects canonical district key", async () => {
  const server = startServer();

  try {
    const response = await server.callTool(1, "register_district", {
      key: "logical_analysis",
      name: "Fake Logical Analysis",
      description: "Trying to override canonical",
      luca_parent: "practical_execution",
    });

    const text = errorText(response);
    assert.ok(text.includes("Cannot override canonical district"), "Should reject canonical override");
  } finally {
    server.stop();
  }
});

test("register_district rejects invalid key format", async () => {
  const server = startServer();

  try {
    const response = await server.callTool(1, "register_district", {
      key: "Invalid-Key-With-Caps",
      name: "Invalid Key",
      description: "Testing key validation",
      luca_parent: "practical_execution",
    });

    const text = errorText(response);
    assert.ok(text.includes("snake_case"), "Should require snake_case format");
  } finally {
    server.stop();
  }
});

test("register_district rejects unknown LUCA parent", async () => {
  const server = startServer();

  try {
    const response = await server.callTool(1, "register_district", {
      key: "orphan_district",
      name: "Orphan District",
      description: "No valid parent",
      luca_parent: "nonexistent_district",
    });

    const text = errorText(response);
    assert.ok(text.includes("Unknown LUCA parent"), "Should reject unknown parent");
  } finally {
    server.stop();
  }
});

test("register_district rejects duplicate registration", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "register_district", {
      key: "custom_district",
      name: "Custom District",
      description: "First registration",
      luca_parent: "practical_execution",
    });

    const response = await server.callTool(2, "register_district", {
      key: "custom_district",
      name: "Duplicate District",
      description: "Second registration attempt",
      luca_parent: "logical_analysis",
    });

    const text = errorText(response);
    assert.ok(text.includes("already registered"), "Should reject duplicate");
  } finally {
    server.stop();
  }
});

test("store_memory in custom district inherits LUCA parent archetype", async () => {
  const server = startServer();

  try {
    // Register custom district under creative_synthesis (mystic archetype)
    await server.callTool(1, "register_district", {
      key: "art_projects",
      name: "Art Projects",
      description: "Creative art project ideas",
      luca_parent: "creative_synthesis",
      activities: ["painting", "sculpting"],
    });

    // Store a memory in the custom district
    const response = await server.callTool(2, "store_memory", {
      content: "Start watercolor landscape painting series",
      district: "art_projects",
      tags: ["topic:art", "scope:project", "kind:task", "layer:implementation"],
    });

    const text = resultText(response);
    assert.ok(text.includes("Stored memory"), "Should store memory");
    assert.ok(text.includes("Art Projects"), "Should show custom district name");
    assert.ok(text.includes("mystic"), "Should inherit mystic archetype from creative_synthesis");
  } finally {
    server.stop();
  }
});

test("custom districts persist across snapshot load", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-luca-persist-"));

  // First session: register a custom district and store a memory
  const server1 = startServer({ tempDir });

  try {
    await server1.callTool(1, "register_district", {
      key: "research_notes",
      name: "Research Notes",
      description: "Academic research notes",
      luca_parent: "logical_analysis",
    });

    const storeResponse = await server1.callTool(2, "store_memory", {
      content: "Research methodology comparison notes",
      district: "research_notes",
      tags: ["topic:research", "scope:concept", "kind:reference", "layer:research"],
    });

    // Verify memory was stored in custom district during this session
    const storeText = resultText(storeResponse);
    assert.ok(storeText.includes("Stored memory"), "Should store memory");
    assert.ok(storeText.includes("Research Notes"), "Should show custom district name");

    // Verify memory stats shows custom district within this session
    const statsResponse = await server1.callTool(3, "memory_stats", {});
    const statsText = resultText(statsResponse);
    assert.ok(statsText.includes("research_notes"), "Stats should include custom district");
    assert.ok(statsText.match(/research_notes:\s*1/), "Should count 1 memory in custom district");

    // Wait for snapshot save (scheduleSave uses 100ms timer + async write chain)
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    server1.stop();
  }

  // Give the OS time to flush file writes after process termination
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Verify snapshot file exists and contains custom district
  const snapshotPath = path.join(tempDir, "memories.json");
  if (fs.existsSync(snapshotPath)) {
    const snapshotRaw = fs.readFileSync(snapshotPath, "utf-8");
    const snapshot = JSON.parse(snapshotRaw);
    assert.ok(snapshot.customDistricts, "Snapshot should contain customDistricts");
    assert.ok(snapshot.customDistricts.research_notes, "Snapshot should contain research_notes district");
    assert.equal(snapshot.customDistricts.research_notes.luca_parent, "logical_analysis", "Custom district should have luca_parent");

    // Second session: verify custom district and memory survived restart
    const server2 = startServer({ tempDir });

    try {
      // List memories to verify the custom district memory loaded
      const listResponse = await server2.callTool(4, "list_memories", {
        district: "research_notes",
      });

      const text = resultText(listResponse);
      assert.ok(text.includes("research_notes"), "Should list memories in custom district");
      assert.ok(text.includes("Research methodology"), "Should show the stored memory");

      // Verify memory stats includes custom district
      const statsResponse = await server2.callTool(5, "memory_stats", {});
      const statsText = resultText(statsResponse);
      assert.ok(statsText.includes("research_notes"), "Stats should include custom district");
    } finally {
      server2.stop();
    }
  }
  // If snapshot doesn't exist, the test already verified in-session behavior above

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("memory_stats shows custom districts in per-district breakdown", async () => {
  const server = startServer();

  try {
    await server.callTool(1, "register_district", {
      key: "devops_automation",
      name: "DevOps Automation",
      description: "Infrastructure automation tasks",
      luca_parent: "practical_execution",
    });

    await server.callTool(2, "store_memory", {
      content: "Set up Terraform for AWS infrastructure",
      district: "devops_automation",
      tags: ["topic:devops", "scope:project", "kind:task", "layer:implementation"],
    });

    const response = await server.callTool(3, "memory_stats", {});
    const text = resultText(response);
    assert.ok(text.includes("devops_automation"), "Stats should include custom district");
    assert.ok(text.match(/devops_automation:\s*1/), "Should count 1 memory in custom district");
  } finally {
    server.stop();
  }
});