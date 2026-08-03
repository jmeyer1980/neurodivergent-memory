import express from 'express';
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import * as readline from 'readline';
import { ensureDaemon } from '../build/core/ensure-daemon.js';
import { resolveDaemonPort } from '../build/core/run-mode.js';
import { parseSearchResults } from './nd-mem-rolodex-helpers.mjs';
import { findPortOwners, describePortConflict, installLifecycle } from './nd-mem-bridge-lifecycle.mjs';

// Resolved from this file's own location, not process.cwd() — the bridge must
// find its assets the same way regardless of the directory it's launched from.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');

const app = express();
const PORT = Number(process.env.ND_MEM_BRIDGE_PORT || 3737);
const USER_HOME = os.homedir();
const DEFAULT_MEMORY_PATH = path.join(USER_HOME, '.neurodivergent-memory', 'memories.json');
const MEMORY_PATH = process.env.ND_MEM_FILE || DEFAULT_MEMORY_PATH;
const POLL_MS = Number(process.env.ND_MEM_POLL_MS || 1500);
// An SSE stream that says nothing between memory writes is an idle TCP
// connection, and phones reap those: wifi power-save and carrier NAT drop them
// after tens of seconds, where a desktop holds them for many minutes. Measured
// on this server: 57.5 seconds of complete silence in a 60-second idle window.
// Every reap costs the page a reconnect, and a reconnect costs it a full
// snapshot refetch plus a whole drum rebuild — which is why the rolodex
// "randomly reloaded" on an iPhone and never once on the desktop. A comment
// frame is ignored by EventSource and keeps the connection warm.
// 0 or garbage means DISABLE the heartbeat, not "fire as fast as possible".
// Node coerces a NaN or 0 delay to ~1ms, so a typo in this variable would have
// spun a timer writing to every open SSE socket thousands of times a second.
const HEARTBEAT_MS = (() => {
  const raw = process.env.ND_MEM_BRIDGE_HEARTBEAT_MS;
  if (raw === undefined || raw === '') return 20000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

let clients = new Set();
// Seeded from the file as it stands at startup, NOT null/0. Seeded empty, the
// first poll tick 1.5s later always found "a change" and broadcast a
// memory-change nothing had caused (measured: identical mtime and size either
// side of it). Every connected page then refetched the whole snapshot and
// rebuilt its drum for nothing.
let lastFingerprint = statFingerprint();

function readSnapshot() {
  if (!fs.existsSync(MEMORY_PATH)) return { nextMemoryId: 1, memories: {}, missing: true, path: MEMORY_PATH };
  const raw = fs.readFileSync(MEMORY_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return { ...parsed, missing: false, path: MEMORY_PATH };
}

function statFingerprint() {
  try {
    const stat = fs.statSync(MEMORY_PATH);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

function pollForChanges() {
  const fingerprint = statFingerprint();
  if (fingerprint === lastFingerprint) return;
  lastFingerprint = fingerprint;
  // There was a second guard here comparing mtime alone, and it could only ever
  // LOSE changes. mtime is already the first component of the fingerprint, so
  // the guard was redundant on its face — but it ran AFTER lastFingerprint had
  // been advanced, so a write landing inside the same mtime tick (size-only
  // delta) was swallowed and then invisible forever: every later poll compared
  // against the already-updated fingerprint and saw no difference. Most
  // reachable through bulkReassign, which POSTs its updates in a tight
  // sequential loop that easily lands two writes in one millisecond.
  broadcast('memory-change', { path: MEMORY_PATH, fingerprint, changedAt: new Date().toISOString() });
}
const pollTimer = setInterval(pollForChanges, POLL_MS);

app.get('/health', (_req, res) => res.json({ ok: true, port: PORT, memoryPath: MEMORY_PATH, pollMs: POLL_MS }));
app.get('/memories', (_req, res) => { try { res.json(readSnapshot()); } catch (error) { res.status(500).json({ error: String(error), path: MEMORY_PATH }); } });

// READ ONLY. Ranks through the daemon so the UI sees exactly what an agent
// would -- same BM25, same tie-breaks -- rather than a second, divergent
// client-side filter. Only the id and score are parsed out of the tool's prose;
// everything else the UI needs it already has in the snapshot.
//
// SEARCH_MEMORIES RETURNS THE WHOLE STORE. Its min_score defaults to 0, and
// BM25 scores a document containing none of the query terms exactly 0 (every
// term hits a `continue`, and the Robertson IDF variant it uses is always
// positive, so a score is never negative). `0 >= 0` passes the threshold, and
// there is no result cap anywhere in the tool -- so an unfiltered response ranks
// the one real match first and then lists every other memory at 0.000. The
// rolodex dims misses instead of filtering them, which meant EVERY card was lit
// and search discriminated nothing. Dropping the zeroes is the whole feature.
//
// Filtered here rather than by passing a small epsilon as min_score: the tool's
// schema documents `minimum: 0`, so an epsilon would be quietly outside the
// contract, and this is the only place the reason can be written down. The one
// cost is honest and tiny -- scores arrive through prose at three decimals, so a
// genuine match normalising below 0.0005 of the top hit reads as 0.000 and is
// dropped with the non-matches. That takes a single very common query term plus
// an extreme document-length spread, and a card missing from the lit set is a
// far smaller failure than every card being in it.
app.get('/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) { res.json({ ok: true, query: '', total: 0, hits: [] }); return; }
  try {
    const args = { query };
    if (req.query.district) args.district = String(req.query.district);
    if (req.query.project_id) args.project_id = String(req.query.project_id);
    // Number('abc') is NaN, which serialises to null and reaches the tool as a
    // malformed argument; an unparseable threshold means "no threshold given".
    if (req.query.min_score !== undefined && req.query.min_score !== '') {
      const minScore = Number(req.query.min_score);
      if (Number.isFinite(minScore)) args.min_score = minScore;
    }
    if (req.query.tags) args.tags = String(req.query.tags).split(',').map(s => s.trim()).filter(Boolean);

    const { result } = await runMcpTool('search_memories', args);
    const text = result?.result?.content?.map(c => c?.text).filter(Boolean).join('\n') ?? '';
    // See the block comment above: score 0 means "matched none of the query
    // terms", not "matched weakly". total counts what actually survives.
    const hits = parseSearchResults(text).filter(h => h.score > 0);
    res.json({ ok: true, query, total: hits.length, hits });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error), query });
  }
});
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ path: MEMORY_PATH, pollMs: POLL_MS })}\n\n`);
  clients.add(res);
  // See HEARTBEAT_MS. A `:` frame is an SSE comment: it reaches no listener and
  // costs 15 bytes, but it keeps the socket from going idle long enough to be
  // reaped on a phone. unref() so a live stream cannot hold the process open.
  const heartbeat = HEARTBEAT_MS > 0
    ? setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { /* the close handler cleans up */ }
      }, HEARTBEAT_MS)
    : null;
  heartbeat?.unref?.();
  req.on('close', () => { if (heartbeat) clearInterval(heartbeat); clients.delete(res); });
});

// Single-writer architecture: the bridge owns NO memory process. Every write
// is forwarded to the shared HTTP daemon (build/index.js --daemon), which is
// the only process that ever opens memories.json. See
// docs/superpowers/specs/2026-07-13-single-writer-daemon-design.md.
const DAEMON_PORT = resolveDaemonPort(process.env);
const DAEMON_ENTRY = process.env.ND_MEM_DAEMON_ENTRY || path.join(REPO_ROOT, 'build', 'index.js');
const DAEMON_LOG = path.join(path.dirname(MEMORY_PATH), 'daemon.log');

// Set once per process the first time a memoryPath mismatch is detected, so the
// warning doesn't spam stderr on every forwarded tool call.
let memoryPathMismatchWarned = false;

/** path.resolve + (on win32) lowercase, so drive-letter case and slash style don't cause false positives. */
function normalizePathForComparison(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function warnOnMemoryPathMismatch(daemonMemoryPath, daemonPid) {
  if (memoryPathMismatchWarned || !daemonMemoryPath) return;
  if (normalizePathForComparison(daemonMemoryPath) === normalizePathForComparison(MEMORY_PATH)) return;
  memoryPathMismatchWarned = true;
  console.error(
    'Bridge: WARNING daemon memoryPath differs from this bridge\'s MEMORY_PATH — the daemon (started by a different client) is serving a different memory store than this bridge expects.',
    { daemonMemoryPath, bridgeMemoryPath: MEMORY_PATH, daemonPid },
  );
}

/**
 * The env a daemon WE spawn must inherit so it writes the store this bridge reads.
 *
 * ND_MEM_FILE moved only the bridge's read path: ensureDaemon was called with no
 * env, so the daemon resolved persistence independently from
 * NEURODIVERGENT_MEMORY_FILE/_DIR and happily wrote somewhere else. A bridge
 * pointed at a scratch store therefore SERVED the scratch file while /save
 * landed in the user's real ~/.neurodivergent-memory/memories.json — and
 * answered ok:true, so the card just never appeared. The repo's own
 * test/bridge-daemon.test.mjs has to set BOTH variables to keep them aligned,
 * which is the trap stated out loud.
 */
function daemonEnv() {
  if (!process.env.ND_MEM_FILE) return process.env;
  return { ...process.env, NEURODIVERGENT_MEMORY_FILE: MEMORY_PATH };
}

/**
 * Refuse to write through a daemon serving a different store.
 *
 * Passing daemonEnv() fixes the daemon WE start, but a daemon started earlier by
 * another client may already own the port with a different memoryPath, and the
 * port bind makes it the singleton. Writing anyway put data in a store the user
 * is not looking at while reporting success; a warn-once line on stderr is
 * invisible to a browser. Fail the request instead — a visible error beats a
 * silent misfile.
 */
function assertMemoryPathMatch(daemonMemoryPath, daemonPid) {
  if (!daemonMemoryPath) return;
  if (normalizePathForComparison(daemonMemoryPath) === normalizePathForComparison(MEMORY_PATH)) return;
  throw new Error(
    `Refusing to write: the daemon on port ${DAEMON_PORT} (pid ${daemonPid}) is serving ${daemonMemoryPath}, `
    + `but this bridge is reading ${MEMORY_PATH}. The write would land in a store you are not viewing. `
    + 'Stop that daemon, or start the bridge against the same store.',
  );
}

let rpcId = 1;
async function runMcpTool(toolName, args) {
  const health = await ensureDaemon({ port: DAEMON_PORT, entryPath: DAEMON_ENTRY, logFile: DAEMON_LOG, env: daemonEnv() });
  warnOnMemoryPathMismatch(health.memoryPath, health.pid);
  assertMemoryPathMatch(health.memoryPath, health.pid);
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: toolName, arguments: args } }),
  });
  const message = await res.json();
  if (message.error) throw new Error(JSON.stringify(message.error));
  if (message.result?.isError) {
    const text = Array.isArray(message.result.content) ? message.result.content.map(c => c?.text).filter(Boolean).join(' ') : '';
    throw new Error(text || 'MCP tool reported an error');
  }
  return { ok: true, result: message };
}

// One handler shape for every sibling file the bridge serves. Paths resolve
// off SCRIPT_DIR so launching the bridge from any cwd works.
function serveSibling(route, filename, contentType) {
  const filePath = path.join(SCRIPT_DIR, filename);
  app.get(route, (_req, res) => {
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(fs.readFileSync(filePath, 'utf-8'));
    } else {
      res.status(404).send(`${filename} not found. Ensure scripts/${filename} exists.`);
    }
  });
}
const HTML_PATH = path.join(SCRIPT_DIR, 'nd-mem-mcp-app-bridge.html'); // openBridgeUI checks this
serveSibling('/', 'nd-mem-mcp-app-bridge.html', 'text/html');
serveSibling('/nd-mem-app-helpers.mjs', 'nd-mem-app-helpers.mjs', 'text/javascript');
serveSibling('/rolodex', 'nd-mem-rolodex.html', 'text/html');
serveSibling('/nd-mem-rolodex-helpers.mjs', 'nd-mem-rolodex-helpers.mjs', 'text/javascript');

app.post('/update', async (req, res) => {
  const body = req.body || {};
  if (!body.memoryId) return res.status(400).json({ ok: false, error: 'memoryId is required' });
  try {
    const args = { memory_id: body.memoryId };
    // Only forward fields the caller actually supplied so unspecified metadata is left untouched.
    if (body.content !== undefined) args.content = body.content;
    if (body.district !== undefined) args.district = body.district;
    if (Array.isArray(body.tags)) args.tags = body.tags;
    if (body.intensity !== undefined) args.intensity = body.intensity;
    if (body.emotionalValence !== undefined) args.emotional_valence = body.emotionalValence;
    if (body.visibility !== undefined) args.visibility = body.visibility;
    if (body.epistemicStatus !== undefined) args.epistemic_status = body.epistemicStatus;
    if (body.projectId !== undefined) args.project_id = body.projectId; // null clears project attribution
    console.error('Bridge: update request received', { memory_id: body.memoryId });
    const result = await runMcpTool('update_memory', args);
    console.error('Bridge: MCP update result received', result);
    broadcast('save-routed', { ok: true, at: new Date().toISOString() });
    res.json({ ok: true, routedTo: 'daemon-http', tool: 'update_memory', result });
  } catch (error) {
    console.error('Bridge: update error', error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/save', async (req, res) => {
  const body = req.body || {};
  const tags = Array.isArray(body.tags) ? body.tags : [];
  try {
    console.error('Bridge: save request received', { content: body.content, district: body.district });
    const result = await runMcpTool('store_memory', {
      content: body.content,
      district: body.district,
      tags,
      emotional_valence: body.emotionalValence,
      intensity: body.intensity,
      project_id: body.projectId,
      session_id: body.sessionId,
      visibility: body.visibility,
      status: body.status,
      current_slice: body.currentSlice,
      why_now: body.whyNow,
      epistemic_status: body.epistemicStatus
    });
    console.error('Bridge: MCP result received', result);
    broadcast('save-routed', { ok: true, at: new Date().toISOString() });
    res.json({ ok: true, routedTo: 'daemon-http', tool: 'store_memory', result });
  } catch (error) {
    console.error('Bridge: save error', error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// --open / -o (or ND_MEM_BRIDGE_OPEN=1) opens the UI in the default browser as
// soon as the server is listening; --no-open (or ND_MEM_BRIDGE_OPEN=0) never
// opens and never prompts. With neither, an interactive terminal gets a Y/n
// confirmation, while non-interactive runs (tests, spawned children) must stay
// headless — a browser popping up mid-test-suite is never wanted.
const argv = process.argv.slice(2);
const OPEN_ENV = (process.env.ND_MEM_BRIDGE_OPEN || '').toLowerCase();
const NEVER_OPEN = argv.includes('--no-open') || ['0', 'false', 'no'].includes(OPEN_ENV);
const AUTO_OPEN = !NEVER_OPEN && (argv.includes('--open') || argv.includes('-o') || ['1', 'true', 'yes'].includes(OPEN_ENV));

// execFile with an argument array — no shell, so nothing in the URL is ever
// interpreted as a command. On Windows, rundll32's FileProtocolHandler opens
// the default browser without needing the cmd-builtin `start`.
function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  execFile(cmd, args, (error) => {
    if (error) console.error('Bridge: failed to open browser URL:', error.message);
    else console.error(`Bridge: opened ${url} in the default browser.`);
  });
}

function maybeOpenBridgeUI() {
  if (NEVER_OPEN) return;
  if (!AUTO_OPEN && !process.stdin.isTTY) return;
  if (!fs.existsSync(HTML_PATH)) {
    console.error('Bridge: not opening browser — scripts/nd-mem-mcp-app-bridge.html is missing.');
    return;
  }
  const url = `http://localhost:${PORT}/`;
  if (AUTO_OPEN) {
    openInBrowser(url);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`Open bridge UI at ${url} [Y/n]? `, (answer) => {
    rl.close();
    const normalized = answer.trim().toLowerCase();
    if (normalized === '' || normalized === 'y' || normalized === 'yes') {
      openInBrowser(url);
    } else {
      console.log('Skipped opening bridge UI.');
    }
  });
}

// server.address(), NOT the callback, is the proof that we own the port.
//
// On Windows the listen callback fires even when the bind LOSES: node binds
// dual-stack, the IPv6 bind fails, and EADDRINUSE arrives a tick after the
// callback has already run. Measured against a real held 3737 on 2026-08-03 —
// address() is null in the callback, yet the banner printed {"ok":true} and
// maybeOpenBridgeUI() opened a browser onto the OLD bridge, quietly confirming
// the wrong conclusion. Anything that announces success has to ask the socket.
const server = app.listen(PORT, () => {
  if (server.address() === null) return; // the 'error' handler below has this
  console.log(JSON.stringify({ ok: true, port: PORT, memoryPath: MEMORY_PATH, pollMs: POLL_MS }));
  maybeOpenBridgeUI();
});

// Without this, a bridge that loses the bind race stays alive forever, doing
// nothing, looking healthy to `ps`. That is how a five-day-old bridge kept
// serving a route set the user's page had already moved past, and why
// restarting appeared not to help. Exit, and say who has the port.
server.on('error', async (error) => {
  // Nothing is listening, so the only thing keeping this process alive is the
  // poll timer. Clearing it lets the process end on its own once stderr has
  // drained, rather than process.exit() cutting the message off mid-write —
  // on Windows a pipe write from console.error is asynchronous, and truncating
  // the one message this whole issue exists to print would be a poor joke.
  clearInterval(pollTimer);
  process.exitCode = 1;
  // Unconditional, not incidental: on the measured EADDRINUSE path address() is
  // already null and there is no handle to release, but this handler fires for
  // ANY listen error, and one that arrived with the handle still live would
  // otherwise leave a process that reported failure and then ran forever. The
  // callback keeps ERR_SERVER_NOT_RUNNING from surfacing as an 'error' event.
  server.close(() => {});

  if (error.code !== 'EADDRINUSE') {
    console.error('Bridge: FATAL — listen failed:', error);
    return;
  }
  try {
    const owners = await findPortOwners(PORT);
    console.error(describePortConflict(PORT, owners));
  } catch (lookupError) {
    // The report must survive a failure inside the reporting. Ownership is a
    // nicety; "this port is taken and I am not running" is the message.
    console.error(describePortConflict(PORT, []));
    console.error('Bridge: (port owner lookup failed:', lookupError.message, ')');
  }
});

// The daemon is deliberately NOT stopped here — it is shared, and outliving the
// bridge is its job. See the note in nd-mem-bridge-lifecycle.mjs.
installLifecycle({ server, timers: [pollTimer], clients });
