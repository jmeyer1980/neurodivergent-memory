#!/usr/bin/env node
/**
 * Thin mode dispatcher. IMPORTANT: importing ./server-main.js constructs the
 * memory store, which can WRITE (WAL compaction at startup). Every branch that
 * must not write therefore uses lazy `await import()` and never touches
 * server-main. Daemon/proxy branches are wired in later tasks.
 */
import * as path from "path";
import { fileURLToPath } from "url";

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "init-agent-kit" || command === "setup-agent-kit") {
    const { runInitAgentKit } = await import("./server-main.js");
    process.exitCode = runInitAgentKit(process.argv.slice(3));
    return;
  }

  // Mode dispatch lands in Tasks 3 and 5. Until then, standalone for all.
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
