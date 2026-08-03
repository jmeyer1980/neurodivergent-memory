import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getFreePort, waitForHealth, stopDaemonOnPort } from "../test-support/daemon.mjs";

/** Pulls `ID: memory_N` out of store_memory's prose, which /save passes through verbatim. */
function seededId(saveBody) {
  const text = saveBody?.result?.result?.result?.content?.map((c) => c?.text).filter(Boolean).join("\n") ?? "";
  const m = /^ID:\s*(\S+)/m.exec(text);
  return m ? m[1] : null;
}

// The bridge recovers search hits by PARSING the daemon's prose. That contract
// is invisible at runtime -- if the tool's wording changes, the parser silently
// returns zero hits and search just looks broken. This test runs the REAL tool
// against a seeded store and asserts the parser still recovers what it stored,
// so a formatting change fails CI instead of production.
//
// TWO memories are seeded, and one of them shares NO token with the query. With
// only one seed, "the search returned the match" and "the search returned the
// entire store" are the same response -- and the store really did return the
// entire store, because search_memories defaults min_score to 0 and a document
// matching no query term scores exactly 0. Every card in the rolodex was
// therefore lit, and the dim-don't-filter design was inert in production while
// this test stayed green. The absence assertion below is what makes that a CI
// failure instead.
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
    const seed = async (content, district) => {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, district }),
      });
      assert.ok(res.ok, `seed save failed: ${res.status}\n${stderr}`);
      const id = seededId(await res.json());
      assert.ok(id, `store_memory did not report an ID for "${content}"\n${stderr}`);
      return id;
    };
    const matchingId = await seed("deployment pipeline rollout checklist", "practical_execution");
    // Deliberately shares not one token with the query, nor with the memory
    // above -- neither content, nor the generated name, nor any tag.
    const missId = await seed("banana bread cooled on a wire rack", "creative_synthesis");

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

    const ids = body.hits.map((h) => h.id);
    assert.ok(ids.includes(matchingId),
      `the memory that actually contains "deployment" (${matchingId}) is missing from hits: ${JSON.stringify(body)}\n${stderr}`);
    assert.ok(!ids.includes(missId),
      `SEARCH RETURNED A NON-MATCH. ${missId} shares no term with "deployment", so it must not be a hit. ` +
      `search_memories defaults min_score to 0 and scores an unmatched document exactly 0, so the bridge has to ` +
      `drop score-0 rows itself; if it stops doing that, every card in the rolodex lights and search stops ` +
      `discriminating. Response: ${JSON.stringify(body)}\n${stderr}`);
    assert.equal(body.total, body.hits.length, `total must describe the hits actually returned: ${JSON.stringify(body)}`);
  } finally {
    bridge.kill();
    await stopDaemonOnPort(daemonPort);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
