// src/core/stdio-proxy.ts
import * as path from "path";
import * as readline from "readline";
import { ensureDaemon } from "./ensure-daemon.js";
import { resolveDaemonPort } from "./run-mode.js";
import { resolvePersistenceLocation } from "./persistence.js";
import { logger } from "./logger.js";

export interface ProxyOptions {
  /** Absolute path to build/index.js — respawned with --daemon when needed. */
  entryPath: string;
  serverName: string;
  serverVersion: string;
  port?: number;
  logFile?: string;
}

// Set once per process the first time a memoryPath mismatch is detected, so the
// warning doesn't spam the log on every forwarded request.
let memoryPathMismatchWarned = false;

/** path.resolve + (on win32) lowercase, so drive-letter case and slash style don't cause false positives. */
function normalizePathForComparison(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function warnOnMemoryPathMismatch(daemonMemoryPath: string | undefined, daemonPid: number | undefined): void {
  if (memoryPathMismatchWarned || !daemonMemoryPath) return;
  const localMemoryPath = resolvePersistenceLocation().file;
  if (normalizePathForComparison(daemonMemoryPath) === normalizePathForComparison(localMemoryPath)) return;
  memoryPathMismatchWarned = true;
  logger.warn(
    { daemonMemoryPath, localMemoryPath, daemonPid },
    "Daemon memoryPath differs from this client's resolved persistence location; the daemon (started by a different client) is serving a different memory store than this client expects",
  );
}

/**
 * Proxy mode: this process NEVER opens the store. It forwards every request —
 * including `initialize` — to the daemon over HTTP, capturing the real session
 * id the daemon mints and attaching it to every subsequent call. If the daemon
 * is unreachable and cannot be spawned, requests get a JSON-RPC error — there
 * is deliberately no local fallback, because a silent fallback would re-create
 * the multi-writer bug this design exists to kill.
 */
export async function runStdioProxy(options: ProxyOptions): Promise<void> {
  const port = options.port ?? resolveDaemonPort();
  const logFile =
    options.logFile ?? path.join(resolvePersistenceLocation().dir, "daemon.log");

  // This process is genuinely one process per client — the proxy's half of
  // the original per-process assumption still holds. It just needs to carry
  // a real session id to the shared daemon instead of pretending every call
  // is independent.
  let sessionId: string | undefined;
  // The client's own handshake, replayed if the daemon forgets us. See the 404
  // branch in handleLine.
  let cachedInitialize: unknown;
  let cachedInitializedNotification: unknown;

  // Warm start (non-blocking): most sessions' first real call skips the spawn wait.
  void ensureDaemon({ port, entryPath: options.entryPath, logFile }).catch((err) => {
    logger.warn({ err }, "Proxy warm-start of daemon failed; will retry per request");
  });

  const write = (msg: unknown): void => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => { void handleLine(line); });
  rl.on("close", () => process.exit(0));

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      logger.warn({ err, linePreview: trimmed.slice(0, 120) }, "Proxy dropping unparseable stdin line");
      return;
    }

    // Remember the handshake so a session lost to the daemon's idle sweep (or a
    // daemon restart) can be re-established instead of silently degrading every
    // later write to an unattributed one. Kept verbatim: replaying the client's
    // own initialize is what makes the new session identical to the old.
    if (msg.method === "initialize") cachedInitialize = msg;
    if (msg.method === "notifications/initialized") cachedInitializedNotification = msg;

    // Notifications carry no id and the daemon is stateless per MCP-message —
    // drop them (the daemon's session, once minted, doesn't need them).
    if (msg.id === undefined) return;

    try {
      const health = await ensureDaemon({ port, entryPath: options.entryPath, logFile });
      warnOnMemoryPathMismatch(health.memoryPath, health.pid);

      const forwardOnce = async (payload: unknown = msg) => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        };
        if (sessionId) headers["mcp-session-id"] = sessionId;
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        const returnedSessionId = res.headers.get("mcp-session-id");
        if (returnedSessionId) sessionId = returnedSessionId;
        const text = await res.text();
        let response: unknown;
        try {
          response = JSON.parse(text);
        } catch {
          throw new Error(`daemon returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
        }
        return { status: res.status, response };
      };

      const sentSessionId = sessionId;
      let { status, response } = await forwardOnce();

      // The daemon sweeps sessions idle past NEURODIVERGENT_MEMORY_SESSION_IDLE_MS
      // and answers a swept session id with 404 + `id: null` in the JSON-RPC body.
      // Relaying that straight through would wedge the caller two ways: it can
      // never correlate a null id to its pending request (so the call just
      // hangs from its point of view), and we'd keep attaching the same dead
      // session id to every future call too. Clear it and retry ONCE with no
      // session header, falling through to the daemon's stateless fallback path
      // (Task 1) — that yields a properly `id`'d response, just with no bound
      // identity (`Agent: unassigned` for a memory write).
      if (status === 404 && sentSessionId) {
        sessionId = undefined;
        // Re-establish rather than degrade. Retrying sessionless does produce a
        // properly id'd response, but the stateless fallback mints no session
        // id — so `sessionId` stayed undefined for the REST OF THIS PROCESS,
        // and every later write lost its bound identity (Agent: unassigned),
        // silently and permanently. The design intent is that callers omit
        // agent_id and rely on session binding, so losing the session loses the
        // attribution entirely; the comment above described this as a one-call
        // degradation, which it was not.
        //
        // Replaying the client's own initialize mints a fresh session and
        // forwardOnce captures its id from the response header. If that fails
        // for any reason we still fall through to the sessionless retry, which
        // is exactly the old behaviour — strictly no worse than before.
        if (cachedInitialize) {
          try {
            await forwardOnce(cachedInitialize);
          } catch (err) {
            logger.warn({ err }, "Proxy could not re-initialize after session loss; falling back to a sessionless call");
            sessionId = undefined;
          }
          if (sessionId && cachedInitializedNotification) {
            // Complete the handshake, but never let it discard the session it
            // was meant to finish: a notification is answered 202 with an EMPTY
            // body, so forwardOnce's JSON.parse throws on success. Swallow it
            // separately from the initialize above, whose failure genuinely
            // does mean we have no session.
            try {
              await forwardOnce(cachedInitializedNotification);
            } catch { /* 202 + empty body is the expected outcome */ }
          }
        }
        ({ status, response } = await forwardOnce());
      }

      write(response);
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: `memory daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }
}
