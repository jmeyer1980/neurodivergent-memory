import * as http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { logger } from "./logger.js";

export interface DaemonRouteOptions {
  createServer: () => Server;
  version: string;
  memoryPath: string;
  getMemoryCount: () => number;
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
        // Stateless: a fresh Server + transport per request means concurrent
        // clients' JSON-RPC ids can never cross wires. All servers share the
        // one store singleton; its writeMutex serializes mutations.
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
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

  logger.info({ pid: process.pid, memoryPath, version }, "Memory daemon routes attached; single writer active");
}
