import test from "node:test";
import assert from "node:assert/strict";

import { resolveMemoryTiers } from "../build/core/persistence.js";

test("returns empty object when no tier env vars are set", () => {
  const tiers = resolveMemoryTiers({ env: {} });

  assert.deepEqual(tiers, {});
});

test("resolves project tier from NEURODIVERGENT_MEMORY_PROJECT_DIR", () => {
  const tiers = resolveMemoryTiers({
    env: { NEURODIVERGENT_MEMORY_PROJECT_DIR: "/repo/.github/agent-kit/memories" },
    platform: "linux",
  });

  assert.ok(tiers.project);
  assert.equal(tiers.project.dir, "/repo/.github/agent-kit/memories");
  assert.equal(tiers.project.file, "/repo/.github/agent-kit/memories/memories.json");
  assert.equal(tiers.project.source, "NEURODIVERGENT_MEMORY_PROJECT_DIR");
  assert.equal(tiers.user, undefined);
  assert.equal(tiers.org, undefined);
});

test("resolves user tier from NEURODIVERGENT_MEMORY_USER_DIR", () => {
  const tiers = resolveMemoryTiers({
    env: { NEURODIVERGENT_MEMORY_USER_DIR: "/home/alice/.neurodivergent-memory" },
    platform: "linux",
  });

  assert.ok(tiers.user);
  assert.equal(tiers.user.dir, "/home/alice/.neurodivergent-memory");
  assert.equal(tiers.user.file, "/home/alice/.neurodivergent-memory/memories.json");
  assert.equal(tiers.user.source, "NEURODIVERGENT_MEMORY_USER_DIR");
  assert.equal(tiers.project, undefined);
  assert.equal(tiers.org, undefined);
});

test("resolves org tier from NEURODIVERGENT_MEMORY_ORG_DIR", () => {
  const tiers = resolveMemoryTiers({
    env: { NEURODIVERGENT_MEMORY_ORG_DIR: "/mnt/shared/org-memory" },
    platform: "linux",
  });

  assert.ok(tiers.org);
  assert.equal(tiers.org.dir, "/mnt/shared/org-memory");
  assert.equal(tiers.org.file, "/mnt/shared/org-memory/memories.json");
  assert.equal(tiers.org.source, "NEURODIVERGENT_MEMORY_ORG_DIR");
  assert.equal(tiers.project, undefined);
  assert.equal(tiers.user, undefined);
});

test("resolves all three tiers when all env vars are set", () => {
  const tiers = resolveMemoryTiers({
    env: {
      NEURODIVERGENT_MEMORY_PROJECT_DIR: "/repo/.github/agent-kit/memories",
      NEURODIVERGENT_MEMORY_USER_DIR: "/home/alice/.neurodivergent-memory",
      NEURODIVERGENT_MEMORY_ORG_DIR: "/mnt/shared/org-memory",
    },
    platform: "linux",
  });

  assert.ok(tiers.project);
  assert.ok(tiers.user);
  assert.ok(tiers.org);

  assert.equal(tiers.project.dir, "/repo/.github/agent-kit/memories");
  assert.equal(tiers.user.dir, "/home/alice/.neurodivergent-memory");
  assert.equal(tiers.org.dir, "/mnt/shared/org-memory");
});

test("ignores whitespace-only tier env vars", () => {
  const tiers = resolveMemoryTiers({
    env: {
      NEURODIVERGENT_MEMORY_PROJECT_DIR: "   ",
      NEURODIVERGENT_MEMORY_USER_DIR: "\t",
    },
    platform: "linux",
  });

  assert.deepEqual(tiers, {});
});

test("trims whitespace from tier directory paths", () => {
  const tiers = resolveMemoryTiers({
    env: { NEURODIVERGENT_MEMORY_USER_DIR: "  /home/alice/.nd-memory  " },
    platform: "linux",
  });

  assert.ok(tiers.user);
  assert.equal(tiers.user.dir, "/home/alice/.nd-memory");
  assert.equal(tiers.user.file, "/home/alice/.nd-memory/memories.json");
});

test("uses Windows path separator on win32 platform", () => {
  const tiers = resolveMemoryTiers({
    env: { NEURODIVERGENT_MEMORY_USER_DIR: "C:\\Users\\alice\\nd-memory" },
    platform: "win32",
  });

  assert.ok(tiers.user);
  assert.equal(tiers.user.dir, "C:\\Users\\alice\\nd-memory");
  assert.equal(tiers.user.file, "C:\\Users\\alice\\nd-memory\\memories.json");
  assert.equal(tiers.user.source, "NEURODIVERGENT_MEMORY_USER_DIR");
});

test("does not interfere with existing NEURODIVERGENT_MEMORY_DIR resolution", () => {
  const tiers = resolveMemoryTiers({
    env: {
      NEURODIVERGENT_MEMORY_DIR: "/data/primary",
      NEURODIVERGENT_MEMORY_USER_DIR: "/home/alice/.neurodivergent-memory",
    },
    platform: "linux",
  });

  // resolveMemoryTiers only reads tier vars; NEURODIVERGENT_MEMORY_DIR is for the primary location
  assert.ok(tiers.user);
  assert.equal(tiers.user.dir, "/home/alice/.neurodivergent-memory");
  assert.equal(tiers.project, undefined);
  assert.equal(tiers.org, undefined);
});
