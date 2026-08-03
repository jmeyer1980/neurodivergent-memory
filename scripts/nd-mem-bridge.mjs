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

function runOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...ARGS], {
      stdio: 'inherit',
      env: { ...process.env, ND_MEM_BRIDGE_SUPERVISED: '1' },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

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
    // That is a decision about the whole bridge, not a request to relaunch.
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
