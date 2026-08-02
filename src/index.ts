#!/usr/bin/env node
/**
 * Thin mode dispatcher. IMPORTANT: importing ./server-main.js constructs the
 * memory store, which can WRITE (WAL compaction at startup). Every branch that
 * must not write therefore uses lazy `await import()` and never touches
 * server-main. Proxy is the default stdio mode; standalone is an explicit
 * opt-in for tests, CI, and the inspector.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { resolveRunMode, resolveDaemonPort } from "./core/run-mode.js";

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "init-agent-kit" || command === "setup-agent-kit") {
    const { runInitAgentKit } = await import("./server-main.js");
    process.exitCode = runInitAgentKit(process.argv.slice(3));
    return;
  }

  const mode = resolveRunMode();

  if (mode === "daemon") {
    // Bind the port BEFORE importing server-main: the import constructs the
    // store and may compact the WAL (a write). Holding the port first means a
    // losing daemon exits before it can ever touch the file.
    const { createHttpListener, attachDaemonRoutes } = await import("./core/daemon.js");
    const httpServer = await createHttpListener(resolveDaemonPort());
    const { createMcpServer, SERVER_PACKAGE_INFO, PERSISTENCE_FILE, getMemoryCount, bindAgentSession, clearAgentSession } = await import("./server-main.js");
    attachDaemonRoutes(httpServer, {
      createServer: createMcpServer,
      version: SERVER_PACKAGE_INFO.version,
      memoryPath: PERSISTENCE_FILE,
      getMemoryCount,
      bindAgentSession,
      clearAgentSession,
    });
    return;
  }

  if (mode === "proxy") {
    const { runStdioProxy } = await import("./core/stdio-proxy.js");
    const { resolveServerPackageInfo } = await import("./core/package-info.js");
    const info = resolveServerPackageInfo(new URL("../package.json", import.meta.url));
    await runStdioProxy({
      entryPath: fileURLToPath(import.meta.url),
      serverName: info.name,
      serverVersion: info.version,
    });
    return;
  }

  // mode === "standalone" — explicit opt-in (tests, CI, inspector).
  const { runStandalone } = await import("./server-main.js");
  await runStandalone();
}

/**
 * True when this module IS the process entry point.
 *
 * Must dereference symlinks on both sides. npm installs POSIX bin entries as
 * symlinks (node_modules/.bin/neurodivergent-memory -> build/index.js), node
 * does not resolve process.argv[1], and path.resolve only normalises — so a
 * plain comparison sees the symlink path on one side and the real file on the
 * other, returns false, and main() never runs. That is the published
 * `npx -y neurodivergent-memory` path on macOS and Linux: the process would
 * exit 0 having done nothing, and the MCP client would just see its stdio
 * stream close. Windows escapes it only because npm writes .cmd shims that
 * pass the real path.
 *
 * realpathSync throws if the path no longer exists; fall back to the plain
 * comparison rather than crashing the entry point over it.
 */
function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  const canonical = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return canonical(entryPoint) === canonical(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error("neurodivergent-memory entry failed", error);
    process.exit(1);
  });
}
