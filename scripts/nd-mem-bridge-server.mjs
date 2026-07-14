import express from 'express';
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureDaemon } from '../build/core/ensure-daemon.js';
import { resolveDaemonPort } from '../build/core/run-mode.js';

const app = express();
const PORT = Number(process.env.ND_MEM_BRIDGE_PORT || 3737);
const USER_HOME = os.homedir();
const DEFAULT_MEMORY_PATH = path.join(USER_HOME, '.neurodivergent-memory', 'memories.json');
const MEMORY_PATH = process.env.ND_MEM_FILE || DEFAULT_MEMORY_PATH;
const POLL_MS = Number(process.env.ND_MEM_POLL_MS || 1500);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

let clients = new Set();
let lastFingerprint = null;
let lastMtimeMs = 0;

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
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(MEMORY_PATH).mtimeMs; } catch {}
  if (mtimeMs === lastMtimeMs && fingerprint !== 'missing') return;
  lastMtimeMs = mtimeMs;
  broadcast('memory-change', { path: MEMORY_PATH, fingerprint, changedAt: new Date().toISOString() });
}
setInterval(pollForChanges, POLL_MS);

app.get('/health', (_req, res) => res.json({ ok: true, port: PORT, memoryPath: MEMORY_PATH, pollMs: POLL_MS }));
app.get('/memories', (_req, res) => { try { res.json(readSnapshot()); } catch (error) { res.status(500).json({ error: String(error), path: MEMORY_PATH }); } });
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ path: MEMORY_PATH, pollMs: POLL_MS })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Single-writer architecture: the bridge owns NO memory process. Every write
// is forwarded to the shared HTTP daemon (build/index.js --daemon), which is
// the only process that ever opens memories.json. See
// docs/superpowers/specs/2026-07-13-single-writer-daemon-design.md.
const DAEMON_PORT = resolveDaemonPort(process.env);
const DAEMON_ENTRY = process.env.ND_MEM_DAEMON_ENTRY || path.join(process.cwd(), 'build', 'index.js');
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

let rpcId = 1;
async function runMcpTool(toolName, args) {
  const health = await ensureDaemon({ port: DAEMON_PORT, entryPath: DAEMON_ENTRY, logFile: DAEMON_LOG });
  warnOnMemoryPathMismatch(health.memoryPath, health.pid);
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
  return { ok: true, result: message };
}

const HTML_PATH = path.join(process.cwd(), 'scripts', 'nd-mem-mcp-app-bridge.html');
app.get('/', (_req, res) => {
  if (fs.existsSync(HTML_PATH)) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(fs.readFileSync(HTML_PATH, 'utf-8'));
  } else {
    res.status(404).send('Bridge UI not found. Ensure scripts/nd-mem-mcp-app-bridge.html exists.');
  }
});

// Serves the pure helpers module shared between the web app (loaded as an
// ES module in the browser) and the node test suite (imported directly).
const HELPERS_PATH = path.join(process.cwd(), 'scripts', 'nd-mem-app-helpers.mjs');
app.get('/nd-mem-app-helpers.mjs', (_req, res) => {
  if (fs.existsSync(HELPERS_PATH)) {
    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(fs.readFileSync(HELPERS_PATH, 'utf-8'));
  } else {
    res.status(404).send('helpers module not found. Ensure scripts/nd-mem-app-helpers.mjs exists.');
  }
});

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

app.listen(PORT, () => console.log(JSON.stringify({ ok: true, port: PORT, memoryPath: MEMORY_PATH, pollMs: POLL_MS })));
