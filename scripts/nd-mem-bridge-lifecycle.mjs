import { execFile as nodeExecFile } from 'child_process';

/**
 * Port ownership and orderly shutdown for the bridge.
 *
 * Both halves exist because of one incident (2026-08-02): the rolodex reported
 * "Search could not reach the bridge" while a bridge was demonstrably running.
 * Port 3737 was held by a bridge started five days before the /search route was
 * written. Restarting did not help — the relaunched processes COULD NOT BIND
 * AND STAYED ALIVE ANYWAY, so every signal the user had (a live process,
 * /health answering 200) pointed at their network instead of their process
 * list. A process that is running but not listening is worse than one that
 * died.
 *
 * Kept in its own module so the wiring can be tested with fakes. Signals are
 * not deliverable to a child process on Windows — child.kill('SIGTERM') is
 * TerminateProcess and no handler runs — so a spawn-and-signal test would have
 * to skip on the exact platform this incident happened on.
 */

const LOOKUP_TIMEOUT_MS = 4000;

/**
 * Parse a port from configuration, or throw naming the setting at fault.
 *
 * Number('abc') is NaN, and NOTHING CAN EVER BE LISTENING ON NaN — so an
 * unvalidated port turns every ownership lookup into an empty result, and
 * bridge:stop would announce "nothing to stop" and exit 0 for a run that never
 * checked anything. A misconfigured port must not read as a clean machine.
 * Shared so both scripts fail the same way, and so neither reports a state it
 * did not verify.
 */
export function resolvePort(raw, fallback, settingName = 'ND_MEM_BRIDGE_PORT') {
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${settingName}=${raw} is not a usable port. Expected a whole number between 1 and 65535.`,
    );
  }
  return port;
}

/** The command that answers "who holds this port", for a human to run. */
export function portOwnerCommand(port, platform = process.platform) {
  return platform === 'win32'
    ? `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select -Expand OwningProcess -Unique`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

function run(execFileImpl, cmd, args) {
  return new Promise((resolve) => {
    try {
      execFileImpl(cmd, args, { timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 1 << 24 }, (error, stdout) => {
        // A non-zero exit is normal here: lsof exits 1 when nothing matches.
        resolve(error && !stdout ? '' : String(stdout || ''));
      });
    } catch {
      resolve('');
    }
  });
}

/**
 * Windows `netstat -ano -p TCP` rows look like:
 *   TCP    0.0.0.0:3737    0.0.0.0:0    LISTENING    47640
 *
 * The state word is localised on non-English Windows, so it is deliberately not
 * matched. A listening socket is identified by its shape instead: the local
 * address ends in the port we asked about, and the foreign address is the
 * wildcard. That holds in every locale.
 */
export function parseNetstat(stdout, port) {
  const owners = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const [proto, local, foreign, , pid] = cols;
    if (!/^TCP/i.test(proto)) continue;
    if (!local.endsWith(`:${port}`)) continue;
    if (!/^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign)) continue;
    const numeric = Number(pid);
    if (Number.isInteger(numeric) && numeric > 0) owners.push(numeric);
  }
  return owners;
}

function parsePids(stdout) {
  return stdout
    .split(/\s+/)
    .map((token) => Number(token))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Best-effort list of pids listening on `port`. Returns [] rather than throwing
 * on any failure: this runs inside the error path of a startup failure, and a
 * crash there would replace a useful message with a useless one. "Port is in
 * use, owner unknown" is still worth printing.
 */
export async function findPortOwners(port, options = {}) {
  const { execFileImpl = nodeExecFile, platform = process.platform } = options;

  if (platform === 'win32') {
    // NOT `-p TCP`: that selects the IPv4 table only, and an IPv6 listener is
    // then invisible — which made this return [] while a bridge held the port,
    // and made bridge:stop announce "nothing to stop". Node resolves localhost
    // to ::1 first, so IPv6-only listeners are ordinary, not exotic. Plain
    // -ano lists every table; parseNetstat filters by row shape.
    const stdout = await run(execFileImpl, 'netstat', ['-ano']);
    return [...new Set(parseNetstat(stdout, port))];
  }

  const lsof = await run(execFileImpl, 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const fromLsof = [...new Set(parsePids(lsof))];
  if (fromLsof.length > 0) return fromLsof;

  // Containers and slim images routinely ship without lsof.
  const ss = await run(execFileImpl, 'ss', ['-ltnp']);
  const owners = [];
  for (const line of ss.split(/\r?\n/)) {
    if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
    // One row can name several pids — SO_REUSEPORT siblings appear as
    // users:(("node",pid=123,fd=20),("node",pid=456,fd=21)). Taking only the
    // first would leave a holder alive and the port still busy.
    for (const match of line.matchAll(/pid=(\d+)/g)) owners.push(Number(match[1]));
  }
  return [...new Set(owners)];
}

/**
 * The message printed when the bridge cannot bind. This message is the fix:
 * had the relaunch said "port 3737 is already held by pid 47640", the incident
 * above would have ended in one line instead of an afternoon.
 */
export function describePortConflict(port, owners, platform = process.platform) {
  const held = owners.length === 1
    ? `held by pid ${owners[0]}`
    : owners.length > 1
      ? `held by pids ${owners.join(', ')}`
      : 'held by a process this bridge could not identify';

  return [
    `Bridge: FATAL — port ${port} is already in use, ${held}.`,
    'This bridge is exiting rather than staying alive without listening.',
    owners.length > 0
      ? 'The holder may be an OLDER bridge: /health answers 200 from it while newer routes 404. '
        + 'Stop it with `npm run bridge:stop`, or start this one elsewhere with ND_MEM_BRIDGE_PORT.'
      : `Find the owner with: ${portOwnerCommand(port, platform)}`,
  ].join('\n');
}

/**
 * Register SIGINT/SIGTERM teardown and return the `shutdown` it installs.
 *
 * NOTE FOR ANYONE TEMPTED TO DELETE THIS AGAIN. An earlier version of the
 * bridge had a signal block, and the single-writer migration
 * (docs/superpowers/plans/2026-07-13-single-writer-daemon.md) deleted it with
 * the note "there is no child to kill — the daemon deliberately outlives the
 * bridge". That is still true, and it is still not a reason to have no
 * handlers: the poll interval, the open SSE responses, and the listening socket
 * all outlive the bridge too if nothing tears them down. THIS HANDLER MUST NOT
 * STOP THE DAEMON — the daemon is shared, and other clients are using it.
 *
 * @param {object} o
 * @param {{close: Function}} o.server           listening server to close
 * @param {Array} o.timers                       intervals to clear
 * @param {Set} o.clients                        open SSE responses to end
 * @param {import('events').EventEmitter} [o.emitter]  signal source (default: process)
 * @param {(code: number) => void} [o.onExit]    exit hook (default: process.exit)
 * @param {number} [o.forceExitMs]               deadline for server.close()
 */
export function installLifecycle(options) {
  const {
    server,
    timers = [],
    clients = new Set(),
    emitter = process,
    signals = ['SIGINT', 'SIGTERM'],
    onExit = (code) => process.exit(code),
    log = (message) => console.error(message),
    forceExitMs = 5000,
  } = options;

  let shuttingDown = false;

  /**
   * @param {string} signal what asked for the shutdown, for the log line
   * @param {number} exitCode what to exit WITH — the restart path (#175) uses
   *   this to tell the supervisor to relaunch instead of stopping.
   */
  function shutdown(signal, exitCode = 0) {
    // Ctrl+C twice, or a signal arriving mid-teardown, must not re-enter: the
    // second pass would close an already-closing server and exit twice.
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Bridge: ${signal} received — shutting down.`);

    for (const timer of timers) clearInterval(timer);

    // server.close() waits for open connections to drain, and an SSE stream
    // never drains on its own — every connected phone would hold the bridge
    // open indefinitely. End them first, then close.
    for (const client of clients) {
      try { client.end(); } catch { /* the socket is already gone; keep going */ }
    }
    clients.clear();

    const deadline = setTimeout(() => {
      log('Bridge: connections did not close in time — exiting anyway.');
      // A restart that was asked for still has to happen even if close hangs,
      // so a requested code wins; a plain stop that had to be forced is a
      // failure and says so.
      onExit(exitCode || 1);
    }, forceExitMs);
    deadline.unref?.();

    server.close(() => {
      clearTimeout(deadline);
      onExit(exitCode);
    });
  }

  for (const signal of signals) emitter.on(signal, () => shutdown(signal));

  return { shutdown };
}
