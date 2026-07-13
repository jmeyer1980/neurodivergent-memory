#!/usr/bin/env node
/**
 * Thin mode dispatcher. IMPORTANT: importing ./server-main.js constructs the
 * memory store, which can WRITE (WAL compaction at startup). Every branch that
 * must not write therefore uses lazy `await import()` and never touches
 * server-main. Daemon/proxy branches are wired in later tasks.
 */
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
    const { createMcpServer, SERVER_PACKAGE_INFO, PERSISTENCE_FILE } = await import("./server-main.js");
    attachDaemonRoutes(httpServer, {
      createServer: createMcpServer,
      version: SERVER_PACKAGE_INFO.version,
      memoryPath: PERSISTENCE_FILE,
    });
    return;
  }

  // Mode dispatch for proxy lands in Task 5. Until then, standalone for all.
  const { runStandalone } = await import("./server-main.js");
  await runStandalone();
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  return path.resolve(entryPoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error("neurodivergent-memory entry failed", error);
    process.exit(1);
  });
}
