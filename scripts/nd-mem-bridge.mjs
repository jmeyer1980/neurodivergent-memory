#!/usr/bin/env node
/**
 * Supervisor for the bridge. This is what `npm run bridge` runs.
 *
 * It exists for one reason: NODE CANNOT RE-EXEC ITSELF, so `R` (restart) has to
 * become a fresh process, and the two obvious ways of getting one are both
 * broken. Spawning a replacement and exiting hands the terminal back to the
 * shell — the prompt returns, the grandchild keeps the console, and keypresses
 * stop reaching the bridge after the very first restart. Supervising your own
 * replacement nests one process deeper every time you press R.
 *
 * So: one supervisor, forever, spawning one server at a time. The server exits
 * RESTART_EXIT_CODE to ask for a relaunch; anything else is passed straight
 * through, so a bridge that cannot bind still fails the run instead of being
 * relaunched into the same held port forever.
 *
 * stdio is inherited, so the server child owns the real TTY and its keybinds
 * work exactly as if it had been launched directly.
 */
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { RESTART_EXIT_CODE } from './nd-mem-bridge-keys.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = process.env.ND_MEM_BRIDGE_ENTRY || path.join(SCRIPT_DIR, 'nd-mem-bridge-server.mjs');
const ARGS = process.argv.slice(2);

let current = null;

/**
 * The supervisor outlives every server it starts, so it — not the server — is
 * the last owner of the terminal. A server that is HARD-killed (Windows
 * TerminateProcess, which is what `npm run bridge:stop` and taskkill do, or
 * SIGKILL) runs no exit handler and therefore never restores cooked mode, and
 * the user's shell stops echoing. Repair it here after every child, whatever
 * killed it.
 */
function restoreTerminal() {
  if (!process.stdin.isTTY) return;
  try { process.stdin.setRawMode(false); } catch { /* already gone */ }
}

function runOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...ARGS], {
      stdio: 'inherit',
      env: { ...process.env, ND_MEM_BRIDGE_SUPERVISED: '1' },
    });
    current = child;
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      current = null;
      restoreTerminal();
      resolve({ code, signal });
    });
  });
}

// Forward, then WAIT. Without this the supervisor dies on the default signal
// disposition while the server is still running its graceful shutdown — the
// shell prompt returns while the port is still held, which is exactly the
// "something is running and you cannot see what has it" shape #171 exists to
// prevent. And a signal aimed at the supervisor alone (an IDE stop button,
// SIGTERM from a process manager) would otherwise leave the server orphaned
// holding the port forever, which `npm run bridge` did NOT do before this
// supervisor existed.
let signalsSeen = 0;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    signalsSeen += 1;
    if (current) current.kill(signal);
    // Handling a signal replaces node's default disposition, so waiting for
    // the child means a child that never exits would make THIS process
    // unkillable by the key the user just pressed. A second press gives up.
    if (signalsSeen >= 2) {
      console.error('Bridge supervisor: second signal — exiting without waiting for the server.');
      restoreTerminal();
      process.exit(1);
    }
    // Otherwise no exit here: the loop below resolves when the child does,
    // restores the terminal, and exits with the child's own code.
  });
}
process.on('exit', restoreTerminal);

let exitCode = 0;
for (;;) {
  let result;
  try {
    result = await runOnce();
  } catch (error) {
    console.error(`Bridge supervisor: could not start ${ENTRY}: ${error.message}`);
    exitCode = 1;
    break;
  }

  if (result.signal) {
    // Killed from outside (Ctrl+C reaching the group, taskkill, a stop script).
    // That is a decision about the whole bridge, not a request to relaunch —
    // and it is not a success, or a script chaining off `npm run bridge` would
    // carry on as though the bridge were still up.
    console.error(`Bridge supervisor: server terminated by ${result.signal}.`);
    exitCode = 1;
    break;
  }
  if (result.code === RESTART_EXIT_CODE) {
    console.error('Bridge supervisor: restarting.');
    continue;
  }
  exitCode = result.code ?? 0;
  break;
}

process.exitCode = exitCode;
