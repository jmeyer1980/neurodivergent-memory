import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getFreePort, waitForHealth, stopDaemonOnPort } from "../test-support/daemon.mjs";

// The bridge recovers search hits by PARSING the daemon's prose. That contract
// is invisible at runtime -- if the tool's wording changes, the parser silently
// returns zero hits and search just looks broken. This test runs the REAL tool
// against a seeded store and asserts the parser still recovers what it stored,
// so a formatting change fails CI instead of production.
test("the bridge's /search parses what search_memories actually emits", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-search-contract-"));
  const memoryFile = path.join(tempDir, "memories.json");
  const bridgePort = await getFreePort();
  const daemonPort = await getFreePort();

  const bridge = spawn(process.execPath, ["scripts/nd-mem-bridge-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ND_MEM_FILE: memoryFile,
      NEURODIVERGENT_MEMORY_FILE: memoryFile,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      ND_MEM_BRIDGE_PORT: String(bridgePort),
      ND_MEM_BRIDGE_OPEN: "0",
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  bridge.stderr.on("data", (c) => { stderr += c.toString(); });

  try {
    await waitForHealth(`http://127.0.0.1:${bridgePort}/health`);

    // Seed through the bridge's own write path so the daemon indexes it.
    const save = await fetch(`http://127.0.0.1:${bridgePort}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "deployment pipeline rollout checklist", district: "practical_execution" }),
    });
    assert.ok(save.ok, `seed save failed: ${save.status}\n${stderr}`);

    const res = await fetch(`http://127.0.0.1:${bridgePort}/search?q=${encodeURIComponent("deployment")}`);
    assert.ok(res.ok, `search failed: ${res.status}\n${stderr}`);
    const body = await res.json();

    assert.ok(Array.isArray(body.hits), `hits should be an array: ${JSON.stringify(body)}`);
    assert.ok(body.hits.length > 0,
      `THE PARSER RECOVERED NOTHING. Either search_memories' output format changed, or the regex in ` +
      `parseSearchResults no longer matches it. Response: ${JSON.stringify(body)}\n${stderr}`);
    for (const hit of body.hits) {
      assert.match(hit.id, /^memory_/, `hit id should look like a memory id: ${JSON.stringify(hit)}`);
      assert.ok(Number.isFinite(hit.score), `hit score should be a number: ${JSON.stringify(hit)}`);
    }
  } finally {
    bridge.kill();
    await stopDaemonOnPort(daemonPort);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
