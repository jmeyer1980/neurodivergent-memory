import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";

import {
  installKeybinds,
  describeKeys,
  isBuildStale,
  RESTART_EXIT_CODE,
} from "../scripts/nd-mem-bridge-keys.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(overrides = {}) {
  const calls = [];
  const input = new PassThrough();
  const written = [];
  const rawModes = [];
  input.isTTY = true;
  input.setRawMode = (on) => { rawModes.push(on); };

  const handle = installKeybinds({
    input,
    isTTY: true,
    output: { write: (s) => written.push(String(s)) },
    onStop: () => calls.push("stop"),
    onRestart: () => calls.push("restart"),
    onOpen: () => calls.push("open"),
    onStatus: () => calls.push("status"),
    ...overrides,
  });
  return { calls, input, written, rawModes, handle };
}

const press = async (input, key) => { input.write(key); await sleep(10); };

// --- dispatch -------------------------------------------------------------

test("s and S stop", async () => {
  const { calls, input } = rig();
  await press(input, "s");
  await press(input, "S");
  assert.deepEqual(calls, ["stop", "stop"]);
});

test("r and R restart", async () => {
  const { calls, input } = rig();
  await press(input, "r");
  await press(input, "R");
  assert.deepEqual(calls, ["restart", "restart"]);
});

test("o opens the UI and i prints status", async () => {
  const { calls, input } = rig();
  await press(input, "o");
  await press(input, "i");
  assert.deepEqual(calls, ["open", "status"]);
});

test("? prints the key list", async () => {
  const { written, input } = rig();
  await press(input, "?");
  const text = written.join("");
  for (const key of ["S", "R", "O", "I"]) {
    assert.match(text, new RegExp(`\\b${key}\\b`), `key ${key} missing from help:\n${text}`);
  }
});

test("keys the bridge does not claim are ignored", async () => {
  const { calls, input } = rig();
  for (const key of ["a", "z", "1", " ", "\r", ""]) await press(input, key);
  assert.deepEqual(calls, []);
});

// --- the Ctrl+C regression guard -----------------------------------------

test("Ctrl+C still stops the bridge once raw mode is on", async () => {
  // THE risk in this feature. setRawMode(true) stops the terminal from turning
  // Ctrl+C into SIGINT — the keypress arrives as byte 0x03 and nothing else
  // happens. Without this, adding keybinds silently removes the clean shutdown
  // that #171 just landed, and the bridge becomes unkillable by the one key
  // every user reaches for first.
  const { calls, input } = rig();
  await press(input, "");
  assert.deepEqual(calls, ["stop"]);
});

test("raw mode is actually enabled, which is what breaks Ctrl+C", async () => {
  // Guards the test above from going vacuous: if raw mode were never enabled,
  // "Ctrl+C works" would prove nothing about the case that matters.
  const { rawModes } = rig();
  assert.equal(rawModes[0], true);
});

// --- terminal hygiene -----------------------------------------------------

test("dispose restores cooked mode, so the terminal still echoes afterwards", () => {
  const { handle, rawModes } = rig();
  handle.dispose();
  assert.equal(rawModes.at(-1), false, `raw mode left on: ${JSON.stringify(rawModes)}`);
});

test("dispose stops dispatching", async () => {
  const { calls, input, handle } = rig();
  handle.dispose();
  await press(input, "s");
  assert.deepEqual(calls, []);
});

test("nothing is installed when stdin is not a TTY", async () => {
  // Every existing bridge test spawns with stdio ignore/pipe. Touching raw mode
  // there throws, and resuming stdin would hold the process open.
  const calls = [];
  const input = new PassThrough();
  const handle = installKeybinds({
    input,
    isTTY: false,
    output: { write: () => {} },
    onStop: () => calls.push("stop"),
  });
  await press(input, "s");
  assert.deepEqual(calls, [], "dispatched on a non-TTY");
  assert.equal(handle.installed, false);
  handle.dispose(); // must not throw
});

test("a key handler that throws does not kill the bridge", async () => {
  const { input } = rig({ onStatus: () => { throw new Error("boom"); } });
  await press(input, "i");
  // Reaching here at all is the assertion: an unhandled throw inside a stdin
  // 'data' listener would take the process down.
  assert.ok(true);
});

// --- describeKeys ---------------------------------------------------------

test("describeKeys names every key it dispatches", () => {
  // The help text is the only place these are discoverable, so it has to list
  // every key that actually does something — including ? itself.
  const text = describeKeys();
  for (const key of ["S", "R", "O", "I", "?"]) {
    assert.ok(text.includes(`${key} =`), `${key} missing from help:\n${text}`);
  }
});

// --- isBuildStale ---------------------------------------------------------

function tempTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-stale-"));
  const src = path.join(dir, "src");
  const build = path.join(dir, "build");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(build, { recursive: true });
  return { dir, src, build };
}

function writeAt(file, mtimeMs) {
  fs.writeFileSync(file, "x");
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

test("isBuildStale is true when a source file is newer than the build", () => {
  const { src, build } = tempTree();
  writeAt(path.join(build, "index.js"), 1_000_000_000_000);
  writeAt(path.join(src, "index.ts"), 1_000_000_060_000);
  assert.equal(isBuildStale(src, build), true);
});

test("isBuildStale is false when the build is newer", () => {
  const { src, build } = tempTree();
  writeAt(path.join(src, "index.ts"), 1_000_000_000_000);
  writeAt(path.join(build, "index.js"), 1_000_000_060_000);
  assert.equal(isBuildStale(src, build), false);
});

test("isBuildStale looks into subdirectories, not just the top level", () => {
  const { src, build } = tempTree();
  writeAt(path.join(build, "index.js"), 1_000_000_000_000);
  fs.mkdirSync(path.join(src, "core"), { recursive: true });
  writeAt(path.join(src, "core", "daemon.ts"), 1_000_000_060_000);
  // A flat scan would call this fresh and re-exec into stale compiled code —
  // the same "looks updated but isn't" trap as the five-day-old bridge.
  assert.equal(isBuildStale(src, build), true);
});

test("isBuildStale is true when there is no build at all", () => {
  const { src, dir } = tempTree();
  writeAt(path.join(src, "index.ts"), 1_000_000_000_000);
  assert.equal(isBuildStale(src, path.join(dir, "nope")), true);
});

test("isBuildStale is false when there is no source tree to compare", () => {
  const { build, dir } = tempTree();
  writeAt(path.join(build, "index.js"), 1_000_000_000_000);
  // Nothing to rebuild from: an installed package has build/ and no src/.
  // Reporting "stale" there would make every R shell out to a doomed tsc.
  assert.equal(isBuildStale(path.join(dir, "nope"), build), false);
});

// --- the supervisor -------------------------------------------------------

function runNode(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c.toString(); });
  child.stderr.on("data", (c) => { stderr += c.toString(); });
  const done = new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

test("the supervisor relaunches a child that asks to restart", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-sup-"));
  const counter = path.join(tempDir, "runs.txt");
  const fake = path.join(tempDir, "fake-server.mjs");
  // Exits RESTART_EXIT_CODE the first two times, then 0 — so a supervisor that
  // relaunches correctly produces exactly three runs and then stops.
  fs.writeFileSync(fake, `
    import fs from 'node:fs';
    const file = ${JSON.stringify(counter)};
    const runs = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf-8')) : 0;
    fs.writeFileSync(file, String(runs + 1));
    process.exit(runs < 2 ? ${RESTART_EXIT_CODE} : 0);
  `);

  const { code } = await runNode(["scripts/nd-mem-bridge.mjs"], {
    ND_MEM_BRIDGE_ENTRY: fake,
  }).done;

  assert.equal(code, 0, "supervisor should pass through the final exit code");
  assert.equal(fs.readFileSync(counter, "utf-8"), "3", "expected 3 runs");
});

test("the supervisor passes a failure through instead of looping on it", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-sup-fail-"));
  const fake = path.join(tempDir, "fake-server.mjs");
  fs.writeFileSync(fake, "process.exit(1);");

  const { code } = await runNode(["scripts/nd-mem-bridge.mjs"], {
    ND_MEM_BRIDGE_ENTRY: fake,
  }).done;

  // A bridge that cannot bind exits 1. Relaunching that forever would spin.
  assert.equal(code, 1);
});

test("the supervisor tells the child it is supervised", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-sup-env-"));
  const fake = path.join(tempDir, "fake-server.mjs");
  fs.writeFileSync(fake, "console.log(process.env.ND_MEM_BRIDGE_SUPERVISED ?? 'unset'); process.exit(0);");

  const { stdout } = await runNode(["scripts/nd-mem-bridge.mjs"], {
    ND_MEM_BRIDGE_ENTRY: fake,
  }).done;

  // Without this the bridge cannot tell the user why R did nothing.
  assert.match(stdout, /1/);
});

// --- the real bridge ------------------------------------------------------

test("R restarts the real bridge under the real supervisor, and S stops it", async () => {
  // The whole feature, end to end: a keystroke goes down a pipe into the real
  // bridge, which shuts down and exits RESTART_EXIT_CODE, which the real
  // supervisor turns into a fresh process that rebinds the same port. Every
  // other test here covers a piece; this is the only one that covers the seam.
  const net = await import("node:net");
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });

  const child = spawn(process.execPath, ["scripts/nd-mem-bridge.mjs", "--no-open"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ND_MEM_BRIDGE_PORT: String(port),
      ND_MEM_BRIDGE_KEYS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c.toString(); });
  child.stderr.on("data", (c) => { stderr += c.toString(); });
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));

  const waitFor = async (predicate, what, ms = 25000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(100);
    }
    assert.fail(`timed out waiting for ${what}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  };

  const banners = () => (stdout.match(/"ok":true/g) ?? []).length;

  try {
    await waitFor(() => banners() >= 1, "the first startup banner");

    child.stdin.write("r");
    await waitFor(() => /restarting/i.test(stderr), "the supervisor to report a restart");
    // A second banner means a NEW process bound the same port — which only
    // happens if the old one released it first.
    await waitFor(() => banners() >= 2, "the replacement bridge to bind");

    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.ok, true, "the restarted bridge should be serving");

    child.stdin.write("s");
    const code = await Promise.race([exited, sleep(15000).then(() => "timeout")]);
    assert.notEqual(code, "timeout", `S did not stop the bridge\nstderr:\n${stderr}`);
    assert.equal(code, 0, "a requested stop is a clean exit");
  } finally {
    child.kill();
  }
});

test("a non-TTY bridge starts, serves, and never touches raw mode", async () => {
  // The regression guard for every existing bridge test: they all spawn with
  // stdio ignore/pipe, and enabling raw mode on a pipe throws ERR_TTY_INIT.
  const net = await import("node:net");
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });

  const { child, done } = runNode(["scripts/nd-mem-bridge-server.mjs", "--no-open"], {
    ND_MEM_BRIDGE_PORT: String(port),
  });
  try {
    const deadline = Date.now() + 10000;
    let health = null;
    while (Date.now() < deadline && !health) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) health = await res.json();
      } catch { await sleep(100); }
    }
    assert.ok(health, "bridge never came up on a non-TTY stdin");
    assert.equal(health.ok, true);
  } finally {
    child.kill();
    await Promise.race([done, sleep(3000)]);
  }
});
