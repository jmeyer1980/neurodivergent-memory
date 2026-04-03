import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DEFAULT_DIR_NAME = ".neurodivergent-memory";
const DEFAULT_FILE_NAME = "memories.json";
// /root is intentionally excluded: the image runs as USER node which cannot traverse /root.
// Mounting data at /root/.neurodivergent-memory is a breaking change from pre-v0.1.9 configs.
const LEGACY_CONTAINER_HOMES = ["/home/node"];

export interface PersistenceLocation {
  dir: string;
  file: string;
  source: string;
}

export interface MemoryTiers {
  project?: PersistenceLocation;
  user?: PersistenceLocation;
  org?: PersistenceLocation;
}

interface ResolvePersistenceLocationOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathExists?: (candidatePath: string) => boolean;
}

function trimEnvValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isWindowsAbsolutePath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\");
}

function isUsableHomePath(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return isWindowsAbsolutePath(candidate);
  }
  return candidate.startsWith("/");
}

function pathApiFor(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function snapshotFileForPlatform(dir: string, platform: NodeJS.Platform): string {
  return pathApiFor(platform).join(dir, DEFAULT_FILE_NAME);
}

function uniquePaths(paths: string[], platform: NodeJS.Platform): string[] {
  const pathApi = pathApiFor(platform);
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const candidate of paths) {
    const normalized = pathApi.normalize(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

export function buildPersistenceDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = pathApiFor(platform);
  const candidates: string[] = [];

  const defaultHomeDir = pathApi.join(homeDir, DEFAULT_DIR_NAME);
  candidates.push(defaultHomeDir);

  for (const rawHome of [trimEnvValue(env.HOME), trimEnvValue(env.USERPROFILE)]) {
    if (!rawHome || !isUsableHomePath(rawHome, platform)) continue;
    candidates.push(pathApi.join(rawHome, DEFAULT_DIR_NAME));
  }

  if (platform !== "win32") {
    for (const legacyHome of LEGACY_CONTAINER_HOMES) {
      candidates.push(pathApi.join(legacyHome, DEFAULT_DIR_NAME));
    }
  }

  return uniquePaths(candidates, platform);
}

export function resolvePersistenceLocation(
  options: ResolvePersistenceLocationOptions = {},
): PersistenceLocation {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? fs.existsSync;
  const pathApi = pathApiFor(platform);

  const explicitFile = trimEnvValue(env.NEURODIVERGENT_MEMORY_FILE);
  if (explicitFile) {
    return {
      dir: pathApi.dirname(explicitFile),
      file: explicitFile,
      source: "NEURODIVERGENT_MEMORY_FILE",
    };
  }

  const explicitDir = trimEnvValue(env.NEURODIVERGENT_MEMORY_DIR);
  if (explicitDir) {
    return {
      dir: explicitDir,
      file: snapshotFileForPlatform(explicitDir, platform),
      source: "NEURODIVERGENT_MEMORY_DIR",
    };
  }

  const candidateDirs = buildPersistenceDirCandidates(env, homeDir, platform);

  for (const dir of candidateDirs) {
    const candidateFile = snapshotFileForPlatform(dir, platform);
    if (pathExists(candidateFile)) {
      return { dir, file: candidateFile, source: "existing snapshot" };
    }
  }

  for (const dir of candidateDirs) {
    if (pathExists(dir)) {
      return { dir, file: snapshotFileForPlatform(dir, platform), source: "existing directory" };
    }
  }

  const fallbackDir = candidateDirs[0] ?? pathApi.join(homeDir, DEFAULT_DIR_NAME);
  return {
    dir: fallbackDir,
    file: snapshotFileForPlatform(fallbackDir, platform),
    source: "default home directory",
  };
}

export function walPathForSnapshot(snapshotFile: string): string {
  return `${snapshotFile}.wal.jsonl`;
}

export function resolveMemoryTiers(
  options: ResolvePersistenceLocationOptions = {},
): MemoryTiers {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const tiers: MemoryTiers = {};

  const projectDir = trimEnvValue(env.NEURODIVERGENT_MEMORY_PROJECT_DIR);
  if (projectDir) {
    tiers.project = {
      dir: projectDir,
      file: snapshotFileForPlatform(projectDir, platform),
      source: "NEURODIVERGENT_MEMORY_PROJECT_DIR",
    };
  }

  const userDir = trimEnvValue(env.NEURODIVERGENT_MEMORY_USER_DIR);
  if (userDir) {
    tiers.user = {
      dir: userDir,
      file: snapshotFileForPlatform(userDir, platform),
      source: "NEURODIVERGENT_MEMORY_USER_DIR",
    };
  }

  const orgDir = trimEnvValue(env.NEURODIVERGENT_MEMORY_ORG_DIR);
  if (orgDir) {
    tiers.org = {
      dir: orgDir,
      file: snapshotFileForPlatform(orgDir, platform),
      source: "NEURODIVERGENT_MEMORY_ORG_DIR",
    };
  }

  return tiers;
}
