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
 *
 * Exits via process.exitCode rather than process.exit(): on Windows a write to
 * a pipe is asynchronous, and process.exit() can cut off the very line that
 * explains what happened. Letting the script end on its own flushes it.
 */
import { findPortOwners, portOwnerCommand, resolvePort } from './nd-mem-bridge-lifecycle.mjs';

const FORCE = process.argv.slice(2).includes('--force');

async function looksLikeBridge(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    // The DAEMON also answers {ok:true, ..., memoryPath} — plus mode:"daemon" —
    // and it is the one process the architecture says must outlive the bridge.
    // Its port and the bridge's are both env-driven neighbours, so a stale
    // ND_MEM_BRIDGE_PORT aimed at the daemon is an ordinary mistake. Refuse
    // anything that calls itself the daemon, and require pollMs, which is the
    // bridge's own /health field and nothing else's.
    if (body?.mode === 'daemon') return false;
    return body?.ok === true && typeof body?.memoryPath === 'string' && typeof body?.pollMs === 'number';
  } catch {
    return false;
  }
}

async function main() {
  let port;
  try {
    port = resolvePort(process.env.ND_MEM_BRIDGE_PORT, 3737);
  } catch (error) {
    console.error(`Cannot stop the bridge: ${error.message}`);
    return 1;
  }

  const owners = await findPortOwners(port);

  if (owners.length === 0) {
    // Nothing to stop is success, or `npm run bridge:stop && npm run bridge`
    // would fail on the first clean run.
    console.log(`No process is listening on port ${port} — nothing to stop.`);
    return 0;
  }

  if (!FORCE && !(await looksLikeBridge(port))) {
    console.error(
      `Refusing to stop pid(s) ${owners.join(', ')}: whatever holds port ${port} does not answer /health `
      + 'like the bridge does. Check it before killing it:\n'
      + `  ${portOwnerCommand(port)}\n`
      + 'Re-run with --force if you are sure.',
    );
    return 1;
  }

  let failed = 0;
  for (const pid of owners) {
    try {
      // On POSIX this reaches the SIGTERM handler installed by
      // nd-mem-bridge-lifecycle and the bridge closes cleanly. On Windows there
      // is no deliverable signal — this is a TerminateProcess and the handler
      // does not run. That is the platform's floor, not a choice.
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped the process holding port ${port}: pid ${pid}.`);
    } catch (error) {
      failed += 1;
      console.error(`Could not stop pid ${pid} on port ${port}: ${error.message}`);
    }
  }

  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
