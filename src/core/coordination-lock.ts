/**
 * coordination-lock.ts
 *
 * Opt-in filesystem-level coordination lock for multi-process deployments.
 *
 * Enabled via: NEURODIVERGENT_COORDINATION_MODE=filesystem-lock
 *
 * When enabled, the server acquires a `.lock` file adjacent to the snapshot
 * before every write and releases it immediately after. This prevents two
 * server processes sharing the same storage path from corrupting the snapshot
 * via concurrent writes. It does NOT protect against concurrent in-process
 * access — that is handled by AsyncMutex.
 *
 * Lock lifecycle:
 *   - acquire(): atomically creates `<snapshotFile>.lock` using O_EXCL.
 *     Retries at RETRY_INTERVAL_MS until acquireTimeoutMs elapses.
 *   - release(): removes the lock file. Idempotent (tolerates missing file).
 *
 * Lock file content: JSON with pid and iso timestamp for diagnostics.
 */

import * as fs from "fs";
import { NM_ERRORS, createNMError } from "./error-codes.js";
import { logger } from "./logger.js";

export const COORDINATION_MODE_ENV = "NEURODIVERGENT_COORDINATION_MODE";
export const FILESYSTEM_LOCK_MODE = "filesystem-lock";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 100;

export function lockFilePathFor(snapshotFile: string): string {
  return `${snapshotFile}.lock`;
}

export function isFilesystemLockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COORDINATION_MODE_ENV]?.trim() === FILESYSTEM_LOCK_MODE;
}

export interface LockDiagnostics {
  pid: number;
  timestamp: string;
}

export class FileSystemCoordinationLock {
  private readonly lockFile: string;
  private readonly acquireTimeoutMs: number;

  constructor(snapshotFile: string, acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS) {
    this.lockFile = lockFilePathFor(snapshotFile);
    this.acquireTimeoutMs = acquireTimeoutMs;
  }

  async acquire(): Promise<void> {
    const deadline = Date.now() + this.acquireTimeoutMs;
    const payload = JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() });

    while (true) {
      if (this.tryAcquireSync(payload)) return;

      if (Date.now() >= deadline) {
        const holder = this.readLockHolder();
        const holderMsg = holder
          ? ` Currently held by pid=${holder.pid} since ${holder.timestamp}.`
          : "";
        throw createNMError(
          NM_ERRORS.COORDINATION_LOCK_TIMEOUT,
          `Could not acquire filesystem coordination lock after ${this.acquireTimeoutMs}ms.${holderMsg}`,
          `Another neurodivergent-memory server process is writing to the same storage path. ` +
            `Wait for it to finish, stop the other process, or remove the stale lock file: ${this.lockFile}`,
        );
      }

      await sleep(RETRY_INTERVAL_MS);
    }
  }

  release(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch (err: unknown) {
      // ENOENT is expected when the lock file is already gone — idempotent release.
      if (isEnoent(err)) return;
      // Any other error (EPERM, EACCES, EBUSY, …) means the lock file is still
      // present. Log it so operators can diagnose the stale lock file and clean
      // it up manually before writers time out.
      logger.error(
        { lockFile: this.lockFile, err },
        "Failed to release coordination lock file — stale lock may block future writers",
      );
    }
  }

  private tryAcquireSync(payload: string): boolean {
    try {
      const fd = fs.openSync(this.lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err: unknown) {
      if (isLockContended(err)) return false;
      throw err;
    }
  }

  private readLockHolder(): LockDiagnostics | null {
    try {
      const raw = fs.readFileSync(this.lockFile, "utf-8");
      return JSON.parse(raw) as LockDiagnostics;
    } catch {
      return null;
    }
  }

  get lockFilePath(): string {
    return this.lockFile;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true when the lock-file creation failed because another process
 * already holds the lock (EEXIST from O_EXCL). Used to decide whether to
 * retry or to re-throw.
 */
function isLockContended(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    return (err as NodeJS.ErrnoException).code === "EEXIST";
  }
  return false;
}

/** Returns true when a file was missing (ENOENT). */
function isEnoent(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  return false;
}
