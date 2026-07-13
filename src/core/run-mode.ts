export type RunMode = "daemon" | "proxy" | "standalone";

export interface RunModeOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the process run mode. Proxy is the default for any stdio launch so
 * that no MCP config (current or forgotten) can ever open the store directly —
 * that is the structural single-writer guarantee. Unknown env values also fall
 * back to proxy: the safe failure mode is "not a writer".
 */
export function resolveRunMode(options: RunModeOptions = {}): RunMode {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;

  if (argv.includes("--daemon")) return "daemon";

  const raw = env.NEURODIVERGENT_MEMORY_MODE?.trim().toLowerCase();
  if (raw === "daemon") return "daemon";
  if (raw === "standalone") return "standalone";
  return "proxy";
}

export const DEFAULT_DAEMON_PORT = 3838;

export function resolveDaemonPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NEURODIVERGENT_MEMORY_DAEMON_PORT?.trim();
  if (!raw) return DEFAULT_DAEMON_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_DAEMON_PORT;
  return parsed;
}
