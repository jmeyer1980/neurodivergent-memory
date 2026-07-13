import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface DaemonHealth {
  ok: boolean;
  pid?: number;
  version?: string;
  memoryPath?: string;
  mode?: string;
}

export interface EnsureDaemonOptions {
  port: number;
  /** Absolute path to build/index.js (the mode dispatcher). */
  entryPath: string;
  /** The spawned daemon's stderr (pino) is appended here — it has no console. */
  logFile: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function checkDaemonHealth(port: number, timeoutMs = 750): Promise<DaemonHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!res.ok) {
      // Drain the body so undici reclaims the socket promptly even though we don't need the payload.
      await res.arrayBuffer().catch(() => {});
      return null;
    }
    const body = (await res.json()) as DaemonHealth;
    return body.ok ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Guarantee a healthy daemon on the port, spawning one detached if needed.
 * Safe under races: if two callers spawn simultaneously, the port bind picks
 * one winner and the loser exits 0 (see createHttpListener) — both callers'
 * health polls then converge on the winner.
 *
 * NEVER falls back to opening the store in-process. If the daemon cannot be
 * reached or started, this throws — a loud failure is the only safe failure.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonHealth> {
  const { port, entryPath, logFile } = options;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  const existing = await checkDaemonHealth(port, Math.min(750, timeoutMs));
  if (existing) return existing;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  let spawnErrorMessage: string | undefined;
  try {
    const child = spawn(process.execPath, [entryPath, "--daemon"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", logFd],
      env: { ...(options.env ?? process.env), NEURODIVERGENT_MEMORY_MODE: "daemon" },
    });
    child.on("error", (err) => {
      // Surfaced in the timeout error below; the health-poll loop is what actually detects failure.
      spawnErrorMessage = err.message;
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  while (Date.now() < deadline) {
    const perCheckTimeoutMs = Math.max(50, Math.min(750, pollIntervalMs * 5, deadline - Date.now()));
    const health = await checkDaemonHealth(port, perCheckTimeoutMs);
    if (health) return health;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `Memory daemon did not become healthy on 127.0.0.1:${port} within ${timeoutMs}ms. ` +
      `Check the daemon log: ${logFile}` +
      (spawnErrorMessage ? ` (spawn error: ${spawnErrorMessage})` : ""),
  );
}
