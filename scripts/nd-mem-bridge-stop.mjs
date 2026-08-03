#!/usr/bin/env node
/**
 * Stop the bridge by PORT OWNERSHIP, never by a remembered pid.
 *
 * The pid you remember is not necessarily the pid that holds the port. In the
 * 2026-08-02 incident five bridge processes existed and only the oldest was
 * listening; the user killed the one attached to their terminal and nothing
 * changed. The port knows who owns it — ask the port.
 *
 * Before killing, this confirms the listener answers /health the way the bridge
 * does, so running it with a stale ND_MEM_BRIDGE_PORT cannot shoot an unrelated
 * dev server that happens to be on that port. --force skips the probe.
 */
import { findPortOwners, portOwnerCommand } from './nd-mem-bridge-lifecycle.mjs';

const PORT = Number(process.env.ND_MEM_BRIDGE_PORT || 3737);
const FORCE = process.argv.slice(2).includes('--force');

async function looksLikeBridge(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    // An older bridge is exactly what this script most needs to stop, so the
    // probe checks only the fields /health has always had.
    return body?.ok === true && typeof body?.memoryPath === 'string';
  } catch {
    return false;
  }
}

const owners = await findPortOwners(PORT);

if (owners.length === 0) {
  // Nothing to stop is success, or `npm run bridge:stop && npm run bridge`
  // would fail on the first clean run.
  console.log(`No process is listening on port ${PORT} — nothing to stop.`);
  process.exit(0);
}

if (!FORCE && !(await looksLikeBridge(PORT))) {
  console.error(
    `Refusing to stop pid(s) ${owners.join(', ')}: whatever holds port ${PORT} does not answer /health `
    + 'like the bridge does. Check it before killing it:\n'
    + `  ${portOwnerCommand(PORT)}\n`
    + 'Re-run with --force if you are sure.',
  );
  process.exit(1);
}

let failed = 0;
for (const pid of owners) {
  try {
    // On POSIX this reaches the SIGTERM handler installed by
    // nd-mem-bridge-lifecycle and the bridge closes cleanly. On Windows there
    // is no deliverable signal — this is a TerminateProcess and the handler
    // does not run. That is the platform's floor, not a choice.
    process.kill(pid, 'SIGTERM');
    console.log(`Stopped the process holding port ${PORT}: pid ${pid}.`);
  } catch (error) {
    failed += 1;
    console.error(`Could not stop pid ${pid} on port ${PORT}: ${error.message}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
