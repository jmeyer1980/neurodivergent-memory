import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FileSystemCoordinationLock,
  isFilesystemLockEnabled,
  lockFilePathFor,
  COORDINATION_MODE_ENV,
  FILESYSTEM_LOCK_MODE,
} from "../build/core/coordination-lock.js";

// ── isFilesystemLockEnabled ──────────────────────────────────────────────────

test("isFilesystemLockEnabled returns false when env var is absent", () => {
  const env = {};
  assert.equal(isFilesystemLockEnabled(env), false);
});

test("isFilesystemLockEnabled returns false for unknown mode", () => {
  const env = { [COORDINATION_MODE_ENV]: "shared-snapshot" };
  assert.equal(isFilesystemLockEnabled(env), false);
});

test("isFilesystemLockEnabled returns true for filesystem-lock", () => {
  const env = { [COORDINATION_MODE_ENV]: FILESYSTEM_LOCK_MODE };
  assert.equal(isFilesystemLockEnabled(env), true);
});

test("isFilesystemLockEnabled trims whitespace", () => {
  const env = { [COORDINATION_MODE_ENV]: "  filesystem-lock  " };
  assert.equal(isFilesystemLockEnabled(env), true);
});

// ── lockFilePathFor ──────────────────────────────────────────────────────────

test("lockFilePathFor appends .lock to snapshot file path", () => {
  assert.equal(lockFilePathFor("/data/memories.json"), "/data/memories.json.lock");
});

// ── FileSystemCoordinationLock: basic acquire/release ────────────────────────

function makeTempSnapshot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nd-lock-test-"));
  return path.join(dir, "memories.json");
}

test("acquire creates lock file and release removes it", async () => {
  const snapshot = makeTempSnapshot();
  const lock = new FileSystemCoordinationLock(snapshot, 1_000);

  await lock.acquire();
  assert.ok(fs.existsSync(lock.lockFilePath), "lock file should exist after acquire");

  const content = JSON.parse(fs.readFileSync(lock.lockFilePath, "utf-8"));
  assert.equal(typeof content.pid, "number", "lock file should contain pid");
  assert.equal(typeof content.timestamp, "string", "lock file should contain timestamp");

  lock.release();
  assert.ok(!fs.existsSync(lock.lockFilePath), "lock file should be removed after release");
});

test("release is idempotent when lock file does not exist", () => {
  const snapshot = makeTempSnapshot();
  const lock = new FileSystemCoordinationLock(snapshot, 1_000);
  // Should not throw even if lock was never acquired
  assert.doesNotThrow(() => lock.release());
});

// ── FileSystemCoordinationLock: contention ───────────────────────────────────

test("second acquire times out when lock is already held", async () => {
  const snapshot = makeTempSnapshot();
  const holder = new FileSystemCoordinationLock(snapshot, 500);
  const contender = new FileSystemCoordinationLock(snapshot, 300);

  await holder.acquire();

  try {
    await assert.rejects(
      () => contender.acquire(),
      (err) => {
        assert.ok(err instanceof Error, "should throw an Error");
        assert.ok(
          err.message.includes("Could not acquire filesystem coordination lock"),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    holder.release();
  }
});

test("acquire succeeds after contending lock is released", async () => {
  const snapshot = makeTempSnapshot();
  const holder = new FileSystemCoordinationLock(snapshot, 1_000);
  const waiter = new FileSystemCoordinationLock(snapshot, 2_000);

  await holder.acquire();

  // Release the holder after 150ms while waiter is trying to acquire
  setTimeout(() => holder.release(), 150);

  // waiter should succeed once holder releases
  await assert.doesNotReject(() => waiter.acquire());
  waiter.release();
});

// ── lockFilePath accessor ─────────────────────────────────────────────────────

test("lockFilePath returns expected path", () => {
  const snapshot = "/tmp/memories.json";
  const lock = new FileSystemCoordinationLock(snapshot, 1_000);
  assert.equal(lock.lockFilePath, "/tmp/memories.json.lock");
});
