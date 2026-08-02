import { spawn } from "node:child_process";

/**
 * `npm test`, with a short daemon idle-exit for the whole run.
 *
 * Suites spawn daemons on ephemeral ports and reap them in their own `finally`
 * blocks, but node --test runs files in PARALLEL, so those teardowns race:
 * killing a proxy and its daemon are two steps, and under load a proxy can
 * respawn a daemon in between. Measured: careful per-suite reaping still left
 * ~4 daemons per full run, while leaving none when the same suites ran alone.
 *
 * Every suite spawns children with `{ ...process.env, ... }`, so setting this
 * here reaches every daemon the run creates, however deep. Whatever survives a
 * racy teardown removes itself shortly after the run instead of living until
 * the machine reboots — which is how one machine reached 268 daemons and
 * 1.4 GB, 139 of them from a single day of test runs.
 *
 * Deliberately not the production default (30 min): a real client's daemon
 * should stay warm between calls. This is a test-lifetime value only, and it
 * does not override an explicit setting from the environment.
 */
const IDLE_EXIT_MS = "15000";

const env = { ...process.env };
if (!env.NEURODIVERGENT_MEMORY_DAEMON_IDLE_EXIT_MS) {
  env.NEURODIVERGENT_MEMORY_DAEMON_IDLE_EXIT_MS = IDLE_EXIT_MS;
}

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
