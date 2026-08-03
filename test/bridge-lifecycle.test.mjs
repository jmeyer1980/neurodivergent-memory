import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

import {
  findPortOwners,
  describePortConflict,
  installLifecycle,
} from "../scripts/nd-mem-bridge-lifecycle.mjs";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, () => resolve(srv));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- describePortConflict -------------------------------------------------
// The message IS the fix for #171: the user saw a silent non-listening process
// and went looking at their network. Everything they needed has to be in here.

test("describePortConflict names the port and every holding pid", () => {
  const message = describePortConflict(3737, [47640]);
  assert.match(message, /3737/);
  assert.match(message, /47640/);
});

test("describePortConflict lists multiple owners", () => {
  const message = describePortConflict(3737, [111, 222]);
  assert.match(message, /111/);
  assert.match(message, /222/);
});

test("describePortConflict still names the port when ownership cannot be resolved", () => {
  const message = describePortConflict(3737, []);
  assert.match(message, /3737/);
  // No pid is worse than a pid, but it must not read as "no conflict".
  assert.match(message, /in use|already/i);
});

test("describePortConflict tells the reader how to find the owner themselves", () => {
  // The pid lookup is best-effort; when it comes back empty the message has to
  // hand over the command that answers the question, or the user is back to
  // guessing — which is the whole failure this issue exists to stop.
  const message = describePortConflict(3737, []);
  assert.match(message, /Get-NetTCPConnection|lsof/);
});

// --- findPortOwners -------------------------------------------------------

test("findPortOwners finds this process holding a port it is listening on", async () => {
  const port = await getFreePort();
  const server = await listenOn(port);
  try {
    const owners = await findPortOwners(port);
    assert.ok(
      owners.includes(process.pid),
      `expected ${process.pid} among owners of ${port}, got ${JSON.stringify(owners)}`,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("findPortOwners returns nothing for a port nobody holds", async () => {
  const port = await getFreePort();
  assert.deepEqual(await findPortOwners(port), []);
});

test("findPortOwners resolves to an empty list rather than throwing when the lookup fails", async () => {
  // Best-effort by contract: a machine without lsof, or a locked-down
  // PowerShell, must degrade to "port is in use, owner unknown" — never to a
  // crash inside the error path of another crash.
  const owners = await findPortOwners(3737, {
    execFileImpl: (_cmd, _args, _opts, cb) => cb(new Error("ENOENT")),
  });
  assert.deepEqual(owners, []);
});

// --- installLifecycle -----------------------------------------------------

function fakeShutdownRig() {
  const closed = [];
  const exits = [];
  const server = { close(cb) { closed.push(true); cb?.(); } };
  const emitter = new EventEmitter();
  return { closed, exits, server, emitter };
}

test("shutdown stops the timers it was given", async () => {
  const { server, emitter, exits } = fakeShutdownRig();
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);

  const { shutdown } = installLifecycle({
    server, emitter, timers: [timer], clients: new Set(),
    onExit: (code) => exits.push(code), log: () => {},
  });

  await sleep(30);
  assert.ok(ticks > 0, "timer should have been running before shutdown");
  shutdown("SIGINT");
  const atShutdown = ticks;
  await sleep(30);
  assert.equal(ticks, atShutdown, "timer kept firing after shutdown");
});

test("shutdown ends open SSE responses, which would otherwise hold the server open", () => {
  const { server, emitter, exits } = fakeShutdownRig();
  const ended = [];
  const clients = new Set([
    { end: () => ended.push("a") },
    { end: () => ended.push("b") },
  ]);

  const { shutdown } = installLifecycle({
    server, emitter, timers: [], clients,
    onExit: (code) => exits.push(code), log: () => {},
  });
  shutdown("SIGTERM");

  assert.deepEqual(ended.sort(), ["a", "b"]);
  assert.equal(clients.size, 0, "client set should be emptied");
});

test("shutdown survives a response that throws on end", () => {
  const { server, emitter, exits } = fakeShutdownRig();
  const ended = [];
  const clients = new Set([
    { end: () => { throw new Error("socket already gone"); } },
    { end: () => ended.push("b") },
  ]);

  const { shutdown } = installLifecycle({
    server, emitter, timers: [], clients,
    onExit: (code) => exits.push(code), log: () => {},
  });
  shutdown("SIGTERM");

  // One dead socket must not strand the rest of the teardown.
  assert.deepEqual(ended, ["b"]);
  assert.deepEqual(exits, [0]);
});

test("shutdown closes the server and exits 0", () => {
  const { server, emitter, exits, closed } = fakeShutdownRig();
  const { shutdown } = installLifecycle({
    server, emitter, timers: [], clients: new Set(),
    onExit: (code) => exits.push(code), log: () => {},
  });
  shutdown("SIGINT");
  assert.deepEqual(closed, [true]);
  assert.deepEqual(exits, [0]);
});

test("a second signal does not run the teardown twice", () => {
  const { server, emitter, exits, closed } = fakeShutdownRig();
  installLifecycle({
    server, emitter, timers: [], clients: new Set(),
    onExit: (code) => exits.push(code), log: () => {},
  });
  emitter.emit("SIGINT");
  emitter.emit("SIGINT");
  emitter.emit("SIGTERM");
  assert.deepEqual(closed, [true], "server.close ran more than once");
  assert.deepEqual(exits, [0], "exited more than once");
});

test("installLifecycle listens for both SIGINT and SIGTERM", () => {
  const { server, emitter, exits } = fakeShutdownRig();
  installLifecycle({
    server, emitter, timers: [], clients: new Set(),
    onExit: (code) => exits.push(code), log: () => {},
  });
  assert.equal(emitter.listenerCount("SIGINT"), 1);
  assert.equal(emitter.listenerCount("SIGTERM"), 1);
});

test("a server that hangs on close still exits, on a deadline", async () => {
  // server.close() waits for every keep-alive connection to drain. A phone
  // holding an SSE stream that we failed to end would keep the bridge alive
  // forever, which is the exact "running but useless" state #171 is about.
  const emitter = new EventEmitter();
  const exits = [];
  const server = { close() { /* never calls back */ } };

  installLifecycle({
    server, emitter, timers: [], clients: new Set(),
    onExit: (code) => exits.push(code), log: () => {}, forceExitMs: 20,
  });
  emitter.emit("SIGINT");
  assert.deepEqual(exits, [], "should not have exited synchronously");
  await sleep(60);
  assert.deepEqual(exits, [1], "should have force-exited after the deadline");
});

// --- the bridge itself ----------------------------------------------------

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
  return { child, done, out: () => ({ stdout, stderr }) };
}

test("the bridge exits loudly instead of lingering when its port is held", async () => {
  const port = await getFreePort();
  const squatter = await listenOn(port);
  try {
    const { child, done } = runNode(["scripts/nd-mem-bridge-server.mjs", "--no-open"], {
      ND_MEM_BRIDGE_PORT: String(port),
    });
    const timeout = setTimeout(() => child.kill(), 20000);
    const { code, stdout, stderr } = await done;
    clearTimeout(timeout);

    const output = `${stdout}\n${stderr}`;
    // "Running but not listening" is the state that made the user distrust
    // their network instead of their process list. It must not be reachable.
    assert.equal(code, 1, `expected exit 1, got ${code}. output:\n${output}`);
    assert.match(output, new RegExp(String(port)), `port not named:\n${output}`);

    // On Windows the listen CALLBACK fires even when the bind loses: the
    // dual-stack IPv6 bind fails a tick later, and server.address() is null the
    // whole time. Measured 2026-08-03 against a real bridge on 3737 — the
    // startup banner printed ok:true and maybeOpenBridgeUI() ran, which would
    // open a browser onto the OLD bridge and confirm the wrong conclusion.
    assert.doesNotMatch(stdout, /"ok":\s*true/, `announced success on a failed bind:\n${output}`);

    // The contract is "say who holds it, or say how to find out" — the pid
    // lookup shells out and a machine without lsof/netstat cannot answer.
    // Asserting the pid unconditionally would fail on tooling, not behaviour;
    // findPortOwners has its own test for whether the lookup itself works.
    const resolvable = (await findPortOwners(port)).includes(process.pid);
    if (resolvable) {
      assert.match(output, new RegExp(String(process.pid)), `holding pid not named:\n${output}`);
    } else {
      assert.match(output, /Get-NetTCPConnection|lsof/, `no way to find the owner offered:\n${output}`);
    }
  } finally {
    await new Promise((r) => squatter.close(r));
  }
});

test("bridge:stop kills whoever holds the port, without being told a pid", async () => {
  const port = await getFreePort();
  // A stand-in bridge: it answers /health the way the real one does, which is
  // what the stop script uses to confirm it is not shooting an unrelated
  // process that happens to be on this port.
  const source = `
    const http = require('http');
    http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, port: ${port}, memoryPath: 'x', pollMs: 1500 }));
    }).listen(${port}, '127.0.0.1');
  `;
  const { child, done } = runNode(["-e", source]);

  try {
    const deadline = Date.now() + 8000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await sleep(100); }
    }
    assert.ok(up, "stand-in bridge never came up");

    const stop = runNode(["scripts/nd-mem-bridge-stop.mjs"], { ND_MEM_BRIDGE_PORT: String(port) });
    const stopped = await stop.done;
    assert.equal(stopped.code, 0, `stop failed:\n${stopped.stdout}\n${stopped.stderr}`);
    assert.match(`${stopped.stdout}${stopped.stderr}`, new RegExp(String(child.pid)));

    const exit = await Promise.race([done, sleep(5000).then(() => "timeout")]);
    assert.notEqual(exit, "timeout", "port holder was still alive after bridge:stop");
  } finally {
    child.kill();
  }
});

test("bridge:stop reports plainly when nothing holds the port", async () => {
  const port = await getFreePort();
  const { done } = runNode(["scripts/nd-mem-bridge-stop.mjs"], { ND_MEM_BRIDGE_PORT: String(port) });
  const { code, stdout, stderr } = await done;
  // Nothing to stop is a success, not a failure — otherwise `bridge:stop &&
  // bridge` breaks on the first clean run.
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(`${stdout}${stderr}`, /no .*(process|listener)|nothing/i);
});
