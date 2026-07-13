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

const FALLBACK_PROTOCOL_VERSION = "2024-11-05";

/**
 * Proxy mode: this process NEVER opens the store. It answers `initialize`
 * locally (the daemon is stateless per request) and forwards every other
 * request to the daemon over HTTP. If the daemon is unreachable and cannot be
 * spawned, requests get a JSON-RPC error — there is deliberately no local
 * fallback, because a silent fallback would re-create the multi-writer bug
 * this design exists to kill.
 */
export async function runStdioProxy(options: ProxyOptions): Promise<void> {
  const port = options.port ?? resolveDaemonPort();
  const logFile =
    options.logFile ?? path.join(resolvePersistenceLocation().dir, "daemon.log");

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

    if (msg.method === "initialize" && msg.id !== undefined) {
      const requested = msg.params?.protocolVersion;
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: typeof requested === "string" ? requested : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: options.serverName, version: options.serverVersion },
        },
      });
      return;
    }

    // Notifications carry no id and the daemon is stateless — drop them.
    if (msg.id === undefined) return;

    try {
      await ensureDaemon({ port, entryPath: options.entryPath, logFile });
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify(msg),
      });
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
