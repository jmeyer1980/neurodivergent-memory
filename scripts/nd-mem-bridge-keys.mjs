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
 * How to invoke `npm run build` from inside the bridge.
 *
 * NOT a bare `npm.cmd`. Since the CVE-2024-27980 fix (node 18.20.2 / 20.12 /
 * 22+), spawning a .bat or .cmd WITHOUT shell:true is refused outright:
 * spawnSync returns status null and error EINVAL. A caller testing
 * `status !== 0` reads that as a failed compile and tells the user to fix an
 * error that does not exist — so R could never rebuild on Windows at all. It
 * restarted only when the build was already fresh, which is precisely when a
 * restart was not needed.
 *
 * Preference order:
 * 1. `npm_execpath`, set whenever npm launched us, pointing at npm-cli.js.
 *    Running that with node needs no shell at all.
 * 2. Windows without it: `cmd.exe /c npm run build`. Deliberately NOT
 *    `shell: true` — that also works, but node then warns DEP0190 on every
 *    press of R about unescaped arguments. Naming cmd.exe explicitly keeps the
 *    arguments a real argv array, so there is nothing to escape and nothing to
 *    warn about.
 * 3. Everywhere else: plain npm, no shell.
 */
export function resolveBuildCommand(env = process.env, platform = process.platform) {
  const cli = env.npm_execpath;
  if (cli && /\.[cm]?js$/i.test(cli)) {
    return { command: process.execPath, args: [cli, 'run', 'build'], shell: false };
  }
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/c', 'npm', 'run', 'build'], shell: false };
  }
  return { command: 'npm', args: ['run', 'build'], shell: false };
}

/**
 * Decide what `R` does. Extracted so the build branch is reachable from a test
 * without shelling out — its absence of coverage is exactly how the .cmd bug
 * above survived a full green suite.
 *
 * @param {object} o
 * @param {boolean} o.supervised   can anything actually relaunch us?
 * @param {boolean} o.stale        has src/ moved since the last compile?
 * @param {() => {ok: boolean, reason?: string}} o.runBuild
 * @param {(signal: string, code: number) => void} o.shutdown
 */
export function runRestart({ supervised, stale, runBuild, shutdown, log }) {
  if (!supervised) {
    log(
      'Bridge: R needs the supervisor — a process cannot replace itself. '
      + 'Start with `npm run bridge` (or `node scripts/nd-mem-bridge.mjs`) and R will work.',
    );
    return false;
  }

  // BUILD BEFORE SHUTTING ANYTHING DOWN. If the compile fails, the bridge that
  // is already up stays up on the code that works; shutting down first and
  // then discovering the build is broken leaves nothing running.
  if (stale) {
    log('Bridge: R — src/ is newer than build/, compiling first…');
    const built = runBuild();
    if (!built.ok) {
      log(
        `Bridge: build FAILED (${built.reason ?? 'unknown error'}) — staying up on the code `
        + 'already running. Fix it and press R again.',
      );
      return false;
    }
  }

  log('Bridge: R — restarting.');
  shutdown('R', RESTART_EXIT_CODE);
  return true;
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

  // Null-prototype: a piped chunk under `force` could otherwise name something
  // off Object.prototype and reach a function that is not a key handler.
  const actions = Object.assign(Object.create(null), {
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
  });

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
