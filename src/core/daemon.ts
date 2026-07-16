import * as http from "http";
import * as crypto from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { logger } from "./logger.js";

export interface DaemonRouteOptions {
  createServer: () => Server;
  version: string;
  memoryPath: string;
  getMemoryCount: () => number;
}

interface DaemonSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastActivityAt: number;
}

const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

function resolveSessionIdleMs(): number {
  const raw = process.env.NEURODIVERGENT_MEMORY_SESSION_IDLE_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_IDLE_MS;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (!data) { resolve(undefined); return; }
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

/**
 * Bind 127.0.0.1:port FIRST, before the store exists. The exclusive port bind
 * is the singleton lock: a second daemon gets EADDRINUSE and exits 0 without
 * ever constructing (or writing) the store. Requests that arrive before
 * attachDaemonRoutes() get 503 so health polls simply retry.
 */
export function createHttpListener(port: number): Promise<http.Server> {
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "daemon starting" }));
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.info({ port }, "Memory daemon already running on port; exiting (singleton lock)");
        process.exit(0);
      }
      reject(err);
    });
    httpServer.listen(port, "127.0.0.1", () => resolve(httpServer));
  });
}

export function attachDaemonRoutes(httpServer: http.Server, options: DaemonRouteOptions): void {
  const { createServer, version, memoryPath, getMemoryCount } = options;

  // Real per-connection MCP sessions: each session gets its own long-lived
  // Server+transport pair, reused across every request that carries its
  // Mcp-Session-Id. This replaces the old "fresh Server per request" pattern —
  // that pattern existed only to keep concurrent clients' JSON-RPC ids from
  // crossing wires on a shared transport, which a persistent per-session
  // transport still guarantees. It does NOT touch the single-writer
  // guarantee, which comes from the NeurodivergentMemory singleton's
  // writeMutex, not from per-request disposal.
  const sessions = new Map<string, DaemonSession>();

  const idleMs = resolveSessionIdleMs();
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastActivityAt > idleMs) {
        sessions.delete(sessionId);
        void session.transport.close();
        void session.server.close();
      }
    }
  }, Math.min(idleMs, 60_000));
  sweepInterval.unref();

  httpServer.removeAllListeners("request");
  httpServer.on("request", (req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid: process.pid, version, memoryPath, mode: "daemon", memoryCount: getMemoryCount() }));
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const rawSessionId = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found or expired" } }));
            return;
          }
          existing.lastActivityAt = Date.now();
          await existing.transport.handleRequest(req, res);
          return;
        }

        // No session header. Two callers reach this branch: a real MCP
        // client's `initialize` call (wants a session), and a caller that
        // never establishes a session at all — the bridge's runMcpTool,
        // pre-Task-3 stdio-proxy forwarding, and any bare direct HTTP
        // caller all send tools/call with no handshake. The SDK's stateful
        // transport mode rejects any non-initialize request with no
        // session (400), so those callers need the exact old stateless
        // per-request behavior preserved — read the body once to tell
        // the two cases apart.
        let parsedBody: unknown;
        try {
          parsedBody = await readJsonBody(req);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: Invalid JSON" } }));
          return;
        }
        const isInitialize = typeof parsedBody === "object" && parsedBody !== null && (parsedBody as { method?: unknown }).method === "initialize";

        if (isInitialize) {
          const server = createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, { transport, server, lastActivityAt: Date.now() });
            },
            onsessionclosed: (closedSessionId) => {
              sessions.delete(closedSessionId);
            },
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        // Stateless fallback: today's exact pre-Task-1 behavior for callers
        // that never hand shake — a throwaway Server+transport pair, closed
        // when the response ends.
        const statelessServer = createServer();
        const statelessTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void statelessTransport.close();
          void statelessServer.close();
        });
        await statelessServer.connect(statelessTransport);
        await statelessTransport.handleRequest(req, res, parsedBody);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (err) {
      logger.error({ err }, "Daemon request handling failed");
      if (!res.writableEnded) {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } }));
      }
    }
  }

  logger.info({ pid: process.pid, memoryPath, version, sessionIdleMs: idleMs }, "Memory daemon routes attached; per-connection sessions active");
}
