#!/usr/bin/env node

/**
 * sync-memories — promote memories between persistence tiers.
 *
 * Reads a source-tier snapshot, filters memories by tag, and merges the
 * matching memories into a target-tier snapshot using content-hash dedupe.
 * Runs without a live MCP server — operates directly on snapshot files.
 *
 * Usage (after `npm run build`):
 *   node build/scripts/sync-memories.js --from <path|tier> --to <path|tier> [options]
 *
 * Tier names resolve from env vars:
 *   project  →  NEURODIVERGENT_MEMORY_PROJECT_DIR
 *   user     →  NEURODIVERGENT_MEMORY_USER_DIR
 *   org      →  NEURODIVERGENT_MEMORY_ORG_DIR
 *
 * Options:
 *   --from <path|tier>      Source tier directory or path  (required)
 *   --to   <path|tier>      Target tier directory or path  (required)
 *   --tags <tag1,tag2,...>  Promote memories matching ALL tags (default: persistence:durable)
 *   --any-tag               Promote memories matching ANY of the specified tags (OR logic)
 *   --dry-run               Print counts without writing anything
 *
 * Exit codes:
 *   0  — success (or dry-run completed)
 *   1  — argument / configuration error
 *   2  — source snapshot not found or unreadable
 *   3  — target directory not writable
 *   4  — no memories matched the tag filter
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { resolveMemoryTiers, walPathForSnapshot } from "../core/persistence.js";

// ── Types (minimal, mirroring the server's persisted shape) ─────────────────

interface PersistedMemory {
  id: string;
  content: string;
  district: string;
  tags: string[];
  [key: string]: unknown;
}

interface MemorySnapshot {
  nextMemoryId?: number;
  memories?: Record<string, PersistedMemory>;
}

// ── CLI argument parsing ─────────────────────────────────────────────────────

interface CliArgs {
  from: string;
  to: string;
  tags: string[];
  anyTag: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let from: string | undefined;
  let to: string | undefined;
  const tags: string[] = [];
  let anyTag = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--from":
        from = args[++i];
        break;
      case "--to":
        to = args[++i];
        break;
      case "--tags":
        tags.push(...(args[++i] ?? "").split(",").map((t) => t.trim()).filter(Boolean));
        break;
      case "--any-tag":
        anyTag = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        die(`Unknown argument: ${args[i]}`, 1);
    }
  }

  if (!from) die("--from <path|tier> is required", 1);
  if (!to) die("--to <path|tier> is required", 1);

  return {
    from: from as string,
    to: to as string,
    tags: tags.length > 0 ? tags : ["persistence:durable"],
    anyTag,
    dryRun,
  };
}

function die(message: string, code: number): never {
  process.stderr.write(`sync-memories: ${message}\n`);
  process.exit(code);
}

// ── Tier resolution ──────────────────────────────────────────────────────────

function resolveDir(spec: string): string {
  const tiers = resolveMemoryTiers();

  switch (spec) {
    case "project":
      if (!tiers.project) {
        die(
          "Tier 'project' requires NEURODIVERGENT_MEMORY_PROJECT_DIR to be set.",
          1,
        );
      }
      return tiers.project.dir;
    case "user":
      if (!tiers.user) {
        die(
          "Tier 'user' requires NEURODIVERGENT_MEMORY_USER_DIR to be set.",
          1,
        );
      }
      return tiers.user.dir;
    case "org":
      if (!tiers.org) {
        die(
          "Tier 'org' requires NEURODIVERGENT_MEMORY_ORG_DIR to be set.",
          1,
        );
      }
      return tiers.org.dir;
    default:
      return spec;
  }
}

function snapshotPathForDir(dir: string): string {
  const tiers = resolveMemoryTiers();
  const configuredLocations = [tiers.project, tiers.user, tiers.org].filter(
    (location): location is NonNullable<(typeof tiers)[keyof typeof tiers]> =>
      Boolean(location),
  );

  const resolvedDir = path.resolve(dir);
  const matchingLocation = configuredLocations.find(
    (location) => path.resolve(location.dir) === resolvedDir,
  );

  if (matchingLocation) {
    return matchingLocation.file;
  }

  if (path.extname(dir).toLowerCase() === ".json") {
    return dir;
  }

  const snapshotFileName = configuredLocations
    .map((location) => path.basename(location.file))
    .find((fileName) => fileName.length > 0);

  if (!snapshotFileName) {
    die(
      "Cannot derive snapshot filename from configured persistence tiers. Provide an explicit snapshot path or configure a persistence tier.",
      1,
    );
  }

  return path.join(dir, snapshotFileName);
}

// ── Snapshot I/O ─────────────────────────────────────────────────────────────

function readSnapshot(snapshotPath: string): MemorySnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(snapshotPath, "utf-8");
  } catch {
    die(`Cannot read source snapshot: ${snapshotPath}`, 2);
  }

  let parsed: MemorySnapshot;
  try {
    parsed = JSON.parse(raw) as MemorySnapshot;
  } catch {
    die(`Source snapshot is not valid JSON: ${snapshotPath}`, 2);
  }

  if (!parsed || typeof parsed !== "object" || !parsed.memories || typeof parsed.memories !== "object") {
    die(
      `Source snapshot at ${snapshotPath} does not contain a 'memories' object.`,
      2,
    );
  }

  return parsed;
}

function readSnapshotOrEmpty(snapshotPath: string): MemorySnapshot {
  if (!fs.existsSync(snapshotPath)) {
    return { nextMemoryId: 1, memories: {} };
  }
  return readSnapshot(snapshotPath);
}

// ── Tag matching ─────────────────────────────────────────────────────────────

function matchesTags(memory: PersistedMemory, tags: string[], anyTag: boolean): boolean {
  if (anyTag) {
    return tags.some((tag) => memory.tags.includes(tag));
  }
  return tags.every((tag) => memory.tags.includes(tag));
}

// ── Content-hash dedupe ──────────────────────────────────────────────────────

function contentHash(content: string, district: string): string {
  return crypto.createHash("sha256").update(`${district}\x00${content}`).digest("hex");
}

function buildHashSet(snapshot: MemorySnapshot): Set<string> {
  const hashes = new Set<string>();
  for (const memory of Object.values(snapshot.memories ?? {})) {
    hashes.add(contentHash(memory.content, memory.district));
  }
  return hashes;
}

// ── ID assignment ────────────────────────────────────────────────────────────

function nextNumericId(snapshot: MemorySnapshot): number {
  const fromField = typeof snapshot.nextMemoryId === "number" ? snapshot.nextMemoryId : 1;
  const fromKeys = Object.keys(snapshot.memories ?? {}).reduce((max, key) => {
    const numeric = parseInt(key.replace(/^memory_/, ""), 10);
    return isNaN(numeric) ? max : Math.max(max, numeric + 1);
  }, fromField);
  return Math.max(fromField, fromKeys);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function run(): void {
  const args = parseArgs(process.argv);

  const sourceDir = resolveDir(args.from);
  const targetDir = resolveDir(args.to);

  const sourcePath = snapshotPathForDir(sourceDir);
  const targetPath = snapshotPathForDir(targetDir);

  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    die("--from and --to must refer to different snapshots.", 1);
  }

  // Check for a running WAL on the target tier — writes may be unsafe
  const targetWal = walPathForSnapshot(targetPath);
  if (!args.dryRun && fs.existsSync(targetWal)) {
    process.stderr.write(
      `sync-memories: WARNING — target WAL exists at ${targetWal}.\n` +
      `  The target MCP server may be running. Stop it before syncing to avoid data loss.\n`,
    );
  }

  const sourceSnapshot = readSnapshot(sourcePath);
  const targetSnapshot = readSnapshotOrEmpty(targetPath);

  const sourceMemories = Object.values(sourceSnapshot.memories ?? {});
  const matched = sourceMemories.filter((m) => matchesTags(m, args.tags, args.anyTag));

  if (matched.length === 0) {
    process.stdout.write(
      `sync-memories: No memories in ${sourcePath} matched tags [${args.tags.join(", ")}].\n`,
    );
    process.exit(4);
  }

  // Dedupe against target
  const targetHashes = buildHashSet(targetSnapshot);
  const toImport = matched.filter(
    (m) => !targetHashes.has(contentHash(m.content, m.district)),
  );
  const skipped = matched.length - toImport.length;

  if (args.dryRun) {
    process.stdout.write(
      `sync-memories (dry-run):\n` +
      `  source:   ${sourcePath}\n` +
      `  target:   ${targetPath}\n` +
      `  filter:   [${args.tags.join(", ")}] (${args.anyTag ? "OR" : "ALL"})\n` +
      `  matched:  ${matched.length}\n` +
      `  would_import: ${toImport.length}\n` +
      `  would_skip:   ${skipped} (already present by content hash)\n`,
    );
    return;
  }

  if (toImport.length === 0) {
    process.stdout.write(
      `sync-memories: All ${matched.length} matched memories are already present in the target (content-hash dedupe). Nothing to do.\n`,
    );
    return;
  }

  // Ensure target directory exists
  const targetDirPath = path.dirname(targetPath);
  try {
    fs.mkdirSync(targetDirPath, { recursive: true });
    fs.accessSync(targetDirPath, fs.constants.W_OK);
  } catch {
    die(`Target directory is not writable: ${targetDirPath}`, 3);
  }

  // Merge into target snapshot, preserving existing top-level fields (e.g. customDistricts)
  const merged: MemorySnapshot = {
    ...targetSnapshot,
    nextMemoryId: nextNumericId(targetSnapshot),
    memories: { ...(targetSnapshot.memories ?? {}) },
  };

  // Fields that reference other memory IDs — cross-tier references would be dangling
  const ID_REFERENCE_FIELDS = ["connections", "abstracted_from", "source_memory_id"] as const;

  for (const memory of toImport) {
    const newId = `memory_${merged.nextMemoryId}`;
    merged.nextMemoryId = (merged.nextMemoryId as number) + 1;

    // Strip ID reference fields and assign new ID
    const cleanMemory: Record<string, unknown> = { ...memory, id: newId };
    for (const field of ID_REFERENCE_FIELDS) {
      delete cleanMemory[field];
    }
    merged.memories![newId] = cleanMemory as PersistedMemory;
  }

  const serialized = JSON.stringify(merged, null, 2);
  const tempPath = path.join(
    targetDirPath,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    fs.writeFileSync(tempPath, serialized, "utf-8");
    fs.renameSync(tempPath, targetPath);
  } catch {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup failures and report the original write problem.
    }

    die(`Target directory is not writable: ${targetDirPath}`, 3);
  }
  process.stdout.write(
    `sync-memories:\n` +
    `  source:   ${sourcePath}\n` +
    `  target:   ${targetPath}\n` +
    `  filter:   [${args.tags.join(", ")}] (${args.anyTag ? "OR" : "ALL"})\n` +
    `  matched:  ${matched.length}\n` +
    `  imported: ${toImport.length}\n` +
    `  skipped:  ${skipped} (already present by content hash)\n`,
  );
}

run();
