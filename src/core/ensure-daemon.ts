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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as DaemonHealth;
    return body.ok ? body : null;
  } catch {
    return null;
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

  const existing = await checkDaemonHealth(port);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [entryPath, "--daemon"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", logFd],
      env: { ...(options.env ?? process.env), NEURODIVERGENT_MEMORY_MODE: "daemon" },
    });
    child.on("error", () => { /* surfaced by the health-poll timeout below */ });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkDaemonHealth(port, Math.min(750, pollIntervalMs * 5));
    if (health) return health;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `Memory daemon did not become healthy on 127.0.0.1:${port} within ${timeoutMs}ms. ` +
      `Check the daemon log: ${logFile}`,
  );
}
