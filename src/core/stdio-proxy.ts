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

    // Notifications carry no id and the daemon is stateless per MCP-message —
    // drop them (the daemon's session, once minted, doesn't need them).
    if (msg.id === undefined) return;

    try {
      const health = await ensureDaemon({ port, entryPath: options.entryPath, logFile });
      warnOnMemoryPathMismatch(health.memoryPath, health.pid);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
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
