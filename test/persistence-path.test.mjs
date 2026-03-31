import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPersistenceDirCandidates,
  resolvePersistenceLocation,
} from "../build/core/persistence.js";

test("prefers explicit file override", () => {
  const location = resolvePersistenceLocation({
    env: {
      NEURODIVERGENT_MEMORY_FILE: "/custom/location/state.json",
    },
    homeDir: "/home/node",
    platform: "linux",
    pathExists: () => false,
  });

  assert.equal(location.file, "/custom/location/state.json");
  assert.equal(location.dir, "/custom/location");
  assert.equal(location.source, "NEURODIVERGENT_MEMORY_FILE");
});

test("prefers explicit directory override", () => {
  const location = resolvePersistenceLocation({
    env: {
      NEURODIVERGENT_MEMORY_DIR: "/data/nd-memory",
    },
    homeDir: "/home/node",
    platform: "linux",
    pathExists: () => false,
  });

  assert.equal(location.dir, "/data/nd-memory");
  assert.equal(location.file, "/data/nd-memory/memories.json");
  assert.equal(location.source, "NEURODIVERGENT_MEMORY_DIR");
});

test("ignores broken Windows HOME values inside Linux containers", () => {
  const candidates = buildPersistenceDirCandidates(
    {
      HOME: "C:Usersjerio",
    },
    "/home/node",
    "linux",
  );

  // /root is no longer scanned — the container runs as USER node which cannot read /root
  assert.deepEqual(candidates, [
    "/home/node/.neurodivergent-memory",
  ]);
});

// Regression for breaking change introduced in v0.1.9:
// /root is no longer in LEGACY_CONTAINER_HOMES because USER node cannot read /root.
// A snapshot that only exists at /root/.neurodivergent-memory is invisible to the resolver;
// it falls back to the default home directory instead of silently returning stale data.
test("does not find /root snapshot (breaking change: USER node cannot read /root)", () => {
  const existingPaths = new Set([
    "/root/.neurodivergent-memory/memories.json",
  ]);

  const location = resolvePersistenceLocation({
    env: {
      HOME: "C:Usersjerio",
    },
    homeDir: "/home/node",
    platform: "linux",
    pathExists: (candidatePath) => existingPaths.has(candidatePath),
  });

  // /root is not scanned, so resolver falls through to default home
  assert.equal(location.dir, "/home/node/.neurodivergent-memory");
  assert.equal(location.source, "default home directory");
});
