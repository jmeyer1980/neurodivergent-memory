import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stopDaemonOnPort } from "../test-support/daemon.mjs";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

test('bridge serves the rolodex page, its helpers, and still serves the classic app', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndm-rolodex-routes-'));
  const bridgePort = await getFreePort();
  const daemonPort = await getFreePort();
  const bridge = spawn(process.execPath, ['scripts/nd-mem-bridge-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ND_MEM_BRIDGE_PORT: String(bridgePort),
      ND_MEM_FILE: path.join(tempDir, 'memories.json'),
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_DAEMON_PORT: String(daemonPort),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitFor(`http://127.0.0.1:${bridgePort}/health`);

    const page = await fetch(`http://127.0.0.1:${bridgePort}/rolodex`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /rolodex/i);

    const mod = await fetch(`http://127.0.0.1:${bridgePort}/nd-mem-rolodex-helpers.mjs`);
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get('content-type'), /javascript/);
    assert.match(await mod.text(), /export function/);

    const classic = await fetch(`http://127.0.0.1:${bridgePort}/`);
    assert.equal(classic.status, 200);
    assert.match(await classic.text(), /ND-Mem MCP App/);

    const classicHelpers = await fetch(`http://127.0.0.1:${bridgePort}/nd-mem-app-helpers.mjs`);
    assert.equal(classicHelpers.status, 200);
  } finally {
    bridge.kill();
    // Reap AFTER the child dies: a live proxy/bridge respawns a daemon the
    // instant the one it was using disappears.
    await stopDaemonOnPort(daemonPort);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
