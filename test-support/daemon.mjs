import net from "node:net";

/**
 * Shared test plumbing for suites that spawn a daemon, a proxy, or the bridge.
 *
 * WHY stopDaemonOnPort EXISTS. ensureDaemon spawns daemons `detached: true` +
 * `unref()`, deliberately, so a daemon outlives the client that started it and
 * the next client reuses it. That means killing the child a test spawned does
 * NOT kill the daemon that child caused: a proxy or bridge child is the PARENT
 * of a detached grandchild, and only the grandchild holds the port. Suites that
 * killed just their own child therefore left one daemon per run behind, on the
 * ephemeral port that run had chosen — invisible to the singleton bind, which
 * only ever protects one port.
 *
 * Measured before this helper landed: 268 live daemons on one machine holding
 * 1.4 GB, 139 of them from a single day of test runs, all but one on ephemeral
 * ports. Daemons now also self-exit when idle, but that is a 30-minute backstop;
 * a test suite should not need a timer to clean up after itself.
 */

/** An OS-assigned free port on loopback. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll an HTTP endpoint until it answers 2xx, resolving its JSON body. */
export async function waitForHealth(url, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

/**
 * Kill whatever daemon is listening on `port`, if any. Safe to call blind in a
 * `finally`: it never throws, so it cannot mask the assertion that failed.
 *
 * Asks the daemon for its own pid rather than tracking spawn parentage, because
 * the test usually is not the parent — the proxy or bridge it spawned is.
 */
export async function stopDaemonOnPort(port) {
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const { pid } = await res.json();
    if (!pid) return false;
    process.kill(pid);
    return true;
  } catch {
    return false; // no daemon there, already gone, or unreachable — all fine
  }
}
