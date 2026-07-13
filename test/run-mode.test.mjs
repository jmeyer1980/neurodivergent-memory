import test from "node:test";
import assert from "node:assert/strict";
import { resolveRunMode, resolveDaemonPort, DEFAULT_DAEMON_PORT } from "../build/core/run-mode.js";

test("--daemon flag wins over env", () => {
  assert.equal(resolveRunMode({ argv: ["--daemon"], env: { NEURODIVERGENT_MEMORY_MODE: "standalone" } }), "daemon");
});

test("env daemon selects daemon", () => {
  assert.equal(resolveRunMode({ argv: [], env: { NEURODIVERGENT_MEMORY_MODE: "daemon" } }), "daemon");
});

test("env standalone selects standalone", () => {
  assert.equal(resolveRunMode({ argv: [], env: { NEURODIVERGENT_MEMORY_MODE: "standalone" } }), "standalone");
});

test("no flag and no env defaults to proxy", () => {
  assert.equal(resolveRunMode({ argv: [], env: {} }), "proxy");
});

test("unknown env value falls back to proxy (safe non-writer)", () => {
  assert.equal(resolveRunMode({ argv: [], env: { NEURODIVERGENT_MEMORY_MODE: "bogus" } }), "proxy");
});

test("port defaults to 3838", () => {
  assert.equal(resolveDaemonPort({}), DEFAULT_DAEMON_PORT);
  assert.equal(DEFAULT_DAEMON_PORT, 3838);
});

test("port env override and garbage rejection", () => {
  assert.equal(resolveDaemonPort({ NEURODIVERGENT_MEMORY_DAEMON_PORT: "4141" }), 4141);
  assert.equal(resolveDaemonPort({ NEURODIVERGENT_MEMORY_DAEMON_PORT: "not-a-port" }), DEFAULT_DAEMON_PORT);
  assert.equal(resolveDaemonPort({ NEURODIVERGENT_MEMORY_DAEMON_PORT: "0" }), DEFAULT_DAEMON_PORT);
  assert.equal(resolveDaemonPort({ NEURODIVERGENT_MEMORY_DAEMON_PORT: "70000" }), DEFAULT_DAEMON_PORT);
});
