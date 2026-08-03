import fs from 'fs';
import path from 'path';

/**
 * Terminal keybinds for the bridge, and the staleness check behind `R`.
 *
 * Kept out of the server so the dispatch can be tested against a PassThrough
 * instead of a real terminal — a keypress feature that can only be verified by
 * a human pressing keys is a keypress feature that quietly rots.
 */

/**
 * The child tells the supervisor "relaunch me" by exiting with this.
 *
 * Node cannot re-exec itself, and the obvious alternatives both fail: spawning
 * a replacement and exiting hands the terminal back to the SHELL (the prompt
 * returns, so keypresses stop reaching the bridge after the very first
 * restart), while supervising your own replacement nests one process deeper
 * every time. A separate supervisor that loops on this code keeps exactly one
 * extra process alive no matter how many times you press R.
 *
 * 75 is EX_TEMPFAIL from sysexits.h — conventionally "try again", and outside
 * the range anything else here returns.
 */
export const RESTART_EXIT_CODE = 75;

const KEYS = [
  ['S', 'stop the bridge'],
  ['R', 'restart it, rebuilding first if src/ has moved'],
  ['O', 'open the UI in a browser'],
  ['I', 'status — port, store, connected clients, uptime'],
  ['?', 'this list'],
];

export function describeKeys() {
  return `Bridge keys: ${KEYS.map(([key, what]) => `${key} = ${what}`).join('  |  ')}`;
}

/** Newest mtime under `dir`, or 0 if it does not exist. */
function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
      continue;
    }
    try {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    } catch { /* vanished mid-scan; it cannot be the newest thing that matters */ }
  }
  return newest;
}

/**
 * Has TypeScript moved since the last compile?
 *
 * Recursive on purpose: a flat scan would miss src/core/*.ts, call the build
 * fresh, and re-exec straight into stale compiled code — the same "looks
 * updated but isn't" trap as the five-day-old bridge in #171.
 *
 * No source tree means nothing to rebuild from (an installed package has
 * build/ and no src/), so that reads as fresh rather than sending every R to a
 * doomed tsc.
 */
export function isBuildStale(srcDir, buildDir) {
  const newestSource = newestMtime(srcDir);
  if (newestSource === 0) return false;
  return newestSource > newestMtime(buildDir);
}

/**
 * Attach single-key handlers to `input`.
 *
 * Returns `{ installed, dispose }`. `dispose` is not optional politeness: raw
 * mode has to be handed back or the user's terminal stops echoing after the
 * bridge exits.
 */
export function installKeybinds(options) {
  const {
    input,
    output,
    isTTY = Boolean(input?.isTTY),
    force = false,
    onStop = () => {},
    onRestart = () => {},
    onOpen = () => {},
    onStatus = () => {},
    log = (message) => output?.write?.(`${message}\n`),
  } = options;

  // Every existing bridge test spawns with stdio ignore/pipe. Resuming stdin
  // there would hold the process open past the point it should have exited.
  //
  // `force` exists so the whole feature can be driven end to end without a
  // pseudo-terminal: a pipe carries the keystrokes, and the one thing a pipe
  // cannot do — raw mode — is simply skipped. Without it the only test
  // possible is "the pieces work", never "pressing R actually restarts it".
  if (!isTTY && !force) {
    return { installed: false, dispose() {} };
  }
  // A pipe has no setRawMode, and calling it on one throws ERR_TTY_INIT_FAILED.
  const rawModeAvailable = typeof input?.setRawMode === 'function';

  const actions = {
    s: onStop,
    r: onRestart,
    o: onOpen,
    i: onStatus,
    '?': () => log(describeKeys()),
    // Raw mode stops the terminal turning Ctrl+C into SIGINT — it arrives here
    // as byte 0x03 and nothing else happens. Without this line, adding
    // keybinds would silently remove the clean shutdown #171 landed and leave
    // the bridge deaf to the first key every user reaches for.
    '': onStop,
  };

  function onData(chunk) {
    const key = String(chunk);
    const action = actions[key] ?? actions[key.toLowerCase()];
    if (!action) return;
    try {
      action();
    } catch (error) {
      // A throw inside a stdin 'data' listener takes the whole process down.
      // A broken key is not worth the bridge.
      log(`Bridge: key "${key}" failed: ${error.message}`);
    }
  }

  if (rawModeAvailable) input.setRawMode(true);
  input.resume?.();
  input.setEncoding?.('utf8');
  input.on('data', onData);

  let disposed = false;
  return {
    installed: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      input.off?.('data', onData);
      if (rawModeAvailable) {
        try { input.setRawMode(false); } catch { /* the terminal is already gone */ }
      }
      input.pause?.();
    },
  };
}
