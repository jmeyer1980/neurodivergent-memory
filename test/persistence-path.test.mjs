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

  assert.deepEqual(candidates, [
    "/home/node/.neurodivergent-memory",
    "/root/.neurodivergent-memory",
  ]);
});

test("falls back to legacy root mount when it contains the only snapshot", () => {
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

  assert.equal(location.dir, "/root/.neurodivergent-memory");
  assert.equal(location.file, "/root/.neurodivergent-memory/memories.json");
  assert.equal(location.source, "existing snapshot");
});
