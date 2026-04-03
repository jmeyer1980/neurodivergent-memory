#!/usr/bin/env node

/**
 * Neurodivergent Memory MCP Server
 *
 * A city-based memory system inspired by neurodivergent thinking patterns.
 * Uses FractalStat city simulation as metaphor where:
 * - Districts = Memory categories/knowledge domains
 * - NPCs = Individual memories/thoughts/concepts
 * - Relationships = Connections between thoughts
 * - Activities = Current mental processes
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./core/logger.js";
import { resolvePersistenceLocation } from "./core/persistence.js";
import { AsyncMutex } from "./core/async-mutex.js";
import { LoopTelemetryTracker } from "./core/loop-telemetry.js";
import {
  NM_ERRORS,
  asMcpErrorShape,
  createNMError,
  formatMcpError,
  mcpErrorResult,
  type McpErrorShape,
} from "./core/error-codes.js";
import type { DistilledArtifact, EpistemicStatus, EpistemicStatusFilter, MemoryArchetype, MemoryNPC } from "./core/types.js";

function resolveServerPackageInfo(): { name: string; version: string } {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const raw = fs.readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: parsed.name ?? "neurodivergent-memory",
      version: parsed.version ?? "unknown",
    };
  } catch {
    return {
      name: "neurodivergent-memory",
      version: "unknown",
    };
  }
}

const SERVER_PACKAGE_INFO = resolveServerPackageInfo();
const SERVER_START_TIME_ISO = new Date().toISOString();

/**
 * Canonical district definitions.
 * Keep canonical district identifiers in one place so validation and
 * initialization can derive from the same source of truth.
 */
const CANONICAL_DISTRICT_DEFINITIONS = {
  logical_analysis: null,
  emotional_processing: null,
  practical_execution: null,
  vigilant_monitoring: null,
  creative_synthesis: null,
} as const;

const CANONICAL_DISTRICTS = Object.freeze(
  Object.keys(CANONICAL_DISTRICT_DEFINITIONS) as Array<keyof typeof CANONICAL_DISTRICT_DEFINITIONS>,
);
interface MemoryDistrict {
  name: string;
  description: string;
  archetype: MemoryArchetype;
  activities: string[];
  memories: string[]; // Memory NPC IDs
  luca_parent?: string; // For custom districts: ancestor chain to a canonical district
}

/**
 * Scored search result
 */
interface ScoredMemory {
  memory: MemoryNPC;
  score: number;
}

interface StoreMemoryResult {
  memory: MemoryNPC;
  repeat_detected: boolean;
  matched_memory_id?: string;
  similarity_score?: number;
  ping_pong_detected?: boolean;
  ping_pong_count?: number;
  no_net_new_info_warning?: string;
  cooldown_duration_ms?: number;
}

interface RetrieveMemoryResult {
  memory: MemoryNPC;
  distill_suggestion?: string;
  logical_emotional_read_count?: number;
}

interface UpdateMemoryResult {
  memory: MemoryNPC;
  ping_pong_detected?: boolean;
  ping_pong_count?: number;
  cooldown_duration_ms?: number;
}

interface OperationActorContext {
  district?: string;
  agent_id?: string;
}

/**
 * BM25 index for semantic ranking of memories.
 * k1 and b are standard Okapi BM25 parameters.
 */
class BM25Index {
  private k1 = 1.5;
  private b = 0.75;
  // termFreqs[docId][term] = count of term in doc
  private termFreqs: Map<string, Map<string, number>> = new Map();
  // docFreq[term] = number of docs containing term
  private docFreq: Map<string, number> = new Map();
  // docLengths[docId] = total tokens in doc
  private docLengths: Map<string, number> = new Map();
  // Running sum of all doc lengths — kept in sync on add/remove to avoid O(N) rescan
  private totalDocLength = 0;
  private avgDocLength = 0;

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 0);
  }

  addDocument(docId: string, text: string): void {
    this.removeDocument(docId);

    const tokens = this.tokenize(text);
    const tf: Map<string, number> = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    this.termFreqs.set(docId, tf);
    this.docLengths.set(docId, tokens.length);
    this.totalDocLength += tokens.length;

    for (const term of tf.keys()) {
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }

    this.recalcAvgDocLength();
  }

  removeDocument(docId: string): void {
    const oldTf = this.termFreqs.get(docId);
    if (!oldTf) return;

    // Capture and subtract length while the document is confirmed to exist
    const oldLen = this.docLengths.get(docId) ?? 0;
    this.totalDocLength -= oldLen;

    for (const term of oldTf.keys()) {
      const df = this.docFreq.get(term) ?? 1;
      if (df <= 1) {
        this.docFreq.delete(term);
      } else {
        this.docFreq.set(term, df - 1);
      }
    }

    this.termFreqs.delete(docId);
    this.docLengths.delete(docId);
    this.recalcAvgDocLength();
  }

  private recalcAvgDocLength(): void {
    const count = this.docLengths.size;
    this.avgDocLength = count > 0 ? this.totalDocLength / count : 0;
  }

  score(docId: string, queryTerms: string[]): number {
    const tf = this.termFreqs.get(docId);
    if (!tf) return 0;

    const docLen = this.docLengths.get(docId) ?? 0;
    const N = this.termFreqs.size;
    let total = 0;

    for (const term of queryTerms) {
      const termFreqInDoc = tf.get(term) ?? 0;
      if (termFreqInDoc === 0) continue;

      const df = this.docFreq.get(term) ?? 0;
      if (df === 0) continue;

      // Robertson IDF variant: +1 keeps IDF positive even for very common terms
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const normalizedTf =
        (termFreqInDoc * (this.k1 + 1)) /
        (termFreqInDoc + this.k1 * (1 - this.b + this.b * (docLen / (this.avgDocLength || 1))));

      total += idf * normalizedTf;
    }

    return total;
  }

  queryTerms(query: string): string[] {
    return this.tokenize(query);
  }

  getAllDocIds(): string[] {
    return Array.from(this.termFreqs.keys());
  }
}

/**
 * Path where memory graph is persisted between restarts.
 */
const PERSISTENCE_LOCATION = resolvePersistenceLocation();
const PERSISTENCE_DIR = PERSISTENCE_LOCATION.dir;
const PERSISTENCE_FILE = PERSISTENCE_LOCATION.file;

logger.info(
  {
    persistenceDir: PERSISTENCE_DIR,
    persistenceFile: PERSISTENCE_FILE,
    source: PERSISTENCE_LOCATION.source,
  },
  "Resolved persistence location",
);

/**
 * On-disk representation of a MemoryNPC: identical to MemoryNPC except that
 * Date fields are stored as ISO-8601 strings so the shape round-trips through
 * JSON without ambiguity.
 */
interface PersistedMemoryNPC extends Omit<MemoryNPC, "created" | "last_accessed"> {
  created: string;
  last_accessed: string;
}

/**
 * Serialisable snapshot of the memory system state.
 */
interface MemorySnapshot {
  nextMemoryId: number;
  memories: { [id: string]: PersistedMemoryNPC };
  customDistricts?: { [key: string]: Omit<MemoryDistrict, "memories"> };
}

type WalOperation = "store" | "update" | "delete" | "connect" | "import" | "register_district";

const PROJECT_ID_MAX_LENGTH = 64;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const VALID_EPISTEMIC_STATUSES: EpistemicStatus[] = ["draft", "validated", "outdated"];

type MemoryUpdatePayload = Partial<Pick<MemoryNPC, "content" | "tags" | "emotional_valence" | "intensity" | "district" | "epistemic_status" | "project_id" | "repeat_write_count" | "repeat_count" | "last_similarity_score" | "ping_pong_counter">> & {
  project_id?: string | null;
};

interface WalEntry {
  op: WalOperation;
  payload: Record<string, unknown>;
  timestamp: string;
  seq: number;
}

type EvictionPolicy = "lru" | "access_frequency" | "district_priority";

interface ImportMemoryEntry {
  content: string;
  district: string;
  tags?: string[];
  emotional_valence?: number;
  intensity?: number;
  agent_id?: string;
  project_id?: string;
  epistemic_status?: EpistemicStatus;
}

type ImportDedupePolicy = "none" | "content_hash" | "content_plus_tags";

interface ImportMemorySnapshot {
  nextMemoryId?: number;
  memories?: Record<string, PersistedMemoryNPC>;
}

interface ImportCandidate {
  content: string;
  district: string;
  tags?: string[];
  emotional_valence?: number;
  intensity?: number;
  agent_id?: string;
  project_id?: string;
  epistemic_status?: EpistemicStatus;
  source_memory_id?: string;
  source_connections?: string[];
  name?: string;
  archetype?: MemoryArchetype;
  traits?: string[];
  concerns?: string[];
  created?: Date;
  last_accessed?: Date;
  access_count?: number;
}

interface ImportPlanSkip {
  index: number;
  reason_code: string;
  detail: string;
  source_memory_id?: string;
}

interface ImportPlanFailure {
  index: number;
  reason_code: string;
  detail: string;
  source_memory_id?: string;
}

interface PlannedImportMemory {
  index: number;
  source_memory_id?: string;
  source_connections: string[];
  memory: MemoryNPC;
}

interface ImportPlan {
  source: "entries" | "file_path";
  requested: number;
  memories: PlannedImportMemory[];
  skipped: ImportPlanSkip[];
  failures: ImportPlanFailure[];
  nextMemoryId: number;
}

interface ImportExecutionOptions {
  file_path?: string;
  dry_run?: boolean;
  dedupe?: ImportDedupePolicy;
  preserve_ids?: boolean;
  merge_connections?: boolean;
}

interface ImportExecutionResult {
  source: "entries" | "file_path";
  requested: number;
  dry_run: boolean;
  imported_ids: string[];
  skipped: ImportPlanSkip[];
  failures: ImportPlanFailure[];
}

interface StorageDiagnostics {
  snapshot_path: string;
  wal_path: string;
  resolved_source: string;
}

/**
 * Neurodivergent memory system
 */
class NeurodivergentMemory {
  private districts: { [key: string]: MemoryDistrict } = {};
  private memories: { [id: string]: MemoryNPC } = {};
  private nextMemoryId = 1;
  private bm25 = new BM25Index();
  private walSeq = 1;
  private readonly walFile = `${PERSISTENCE_FILE}.wal.jsonl`;
  private readonly maxMemories = this.parseMaxMemories(process.env.NEURODIVERGENT_MEMORY_MAX);
  private readonly evictionPolicy = this.parseEvictionPolicy(process.env.NEURODIVERGENT_MEMORY_EVICTION);
  private readonly repeatThreshold = parseNumberEnv(
    process.env.NEURODIVERGENT_MEMORY_REPEAT_THRESHOLD,
    0.85,
    (value) => value > 0,
  );
  private readonly loopTelemetryWindowSize = parseIntegerEnv(
    process.env.NEURODIVERGENT_MEMORY_LOOP_WINDOW,
    20,
    (value) => value > 1,
  );
  private readonly pingPongThreshold = parseIntegerEnv(
    process.env.NEURODIVERGENT_MEMORY_PING_PONG_THRESHOLD,
    3,
    (value) => value > 0,
  );
  private readonly distillSuggestionThreshold = parseIntegerEnv(
    process.env.NEURODIVERGENT_MEMORY_DISTILL_SUGGEST_THRESHOLD,
    3,
    (value) => value > 0,
  );
  private readonly crossDistrictCooldownMs = parseIntegerEnv(
    process.env.NEURODIVERGENT_MEMORY_CROSS_DISTRICT_COOLDOWN_MS,
    0,
    (value) => value >= 0,
  );
  private readonly allowExternalImportFiles = parseBooleanEnv(
    process.env.NEURODIVERGENT_MEMORY_IMPORT_ALLOW_EXTERNAL_FILE,
    false,
  );
  private readonly loopTelemetry = new LoopTelemetryTracker({
    operationWindowSize: this.loopTelemetryWindowSize,
    pingPongThreshold: this.pingPongThreshold,
    repeatThreshold: this.repeatThreshold,
    distillSuggestionThreshold: this.distillSuggestionThreshold,
    crossDistrictCooldownMs: this.crossDistrictCooldownMs,
  });
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Promise chain that ensures saves never run concurrently
  private saveChain: Promise<void> = Promise.resolve();

  constructor() {
    this.initializeDistricts();
    this.ensureStoragePathWritable();
    this.loadStateWithWalRecovery();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private ensureStoragePathWritable(): void {
    try {
      fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
      fs.accessSync(PERSISTENCE_DIR, fs.constants.W_OK);
    } catch (err) {
      logger.error({ code: NM_ERRORS.STORAGE_PATH_NOT_WRITABLE, persistenceDir: PERSISTENCE_DIR, err }, "Persistence directory is not writable");
      throw createNMError(
        NM_ERRORS.STORAGE_PATH_NOT_WRITABLE,
        `Storage path is not writable: ${PERSISTENCE_DIR}`,
        "Verify the configured persistence directory exists and is writable by the current process.",
      );
    }
  }

  private loadStateWithWalRecovery(): void {
    const snapshotLoaded = this.loadSnapshot();
    const replayResult = this.replayWal();
    const startupEvictions = this.enforceMaxMemoriesOnStartup();

    if (replayResult.replayed > 0 || startupEvictions > 0) {
      try {
        this.saveToDiskSync();
        fs.writeFileSync(this.walFile, "", "utf-8");
      } catch (err) {
        logger.error({ code: NM_ERRORS.PERSISTENCE_WRITE_FAILED, walFile: this.walFile, err }, "Failed to compact snapshot after WAL replay/startup evictions");
      }
    }

    const startupMode = replayResult.replayed > 0
      ? "wal-replay"
      : (snapshotLoaded ? "snapshot-load" : "fresh");
    logger.info(
      {
        startupMode,
        replayedWalEntries: replayResult.replayed,
        appliedWalEntries: replayResult.mutated,
        skippedWalEntries: replayResult.skipped,
        startupEvictions,
        memoryCount: Object.keys(this.memories).length,
        maxMemories: this.maxMemories ?? "unlimited",
        evictionPolicy: this.evictionPolicy,
      },
      "Memory startup path",
    );
  }

  private loadSnapshot(): boolean {
    try {
      if (!fs.existsSync(PERSISTENCE_FILE)) return false;
      const raw = fs.readFileSync(PERSISTENCE_FILE, "utf-8");
      const snapshot: MemorySnapshot = JSON.parse(raw);

      this.nextMemoryId = snapshot.nextMemoryId ?? 1;

      // Restore custom districts before loading memories so districts are available for validation.
      if (snapshot.customDistricts) {
        for (const [key, districtData] of Object.entries(snapshot.customDistricts)) {
          if (this.districts[key]) continue; // Skip if already initialised (e.g. canonical)
          this.districts[key] = { ...districtData, memories: [] };
        }
      }

      const memoriesMap = snapshot.memories ?? {};
      for (const [id, raw_mem] of Object.entries(memoriesMap)) {
        const mem = this.deserializeMemory(raw_mem as PersistedMemoryNPC);
        this.insertMemory(mem);
      }
      return true;
    } catch (err) {
      logger.warn({ code: NM_ERRORS.SNAPSHOT_LOAD_FAILED, err }, "Failed to load snapshot; starting with empty memory state");
      this.clearState();
      return false;
    }
  }

  private replayWal(): { replayed: number; mutated: number; skipped: number } {
    if (!fs.existsSync(this.walFile)) return { replayed: 0, mutated: 0, skipped: 0 };

    let replayed = 0;
    let mutated = 0;
    let skipped = 0;
    try {
      const lines = fs.readFileSync(this.walFile, "utf-8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as WalEntry;
          this.walSeq = Math.max(this.walSeq, (entry.seq ?? 0) + 1);
          replayed++;
          const entryMutated = this.applyWalEntry(entry);
          if (entryMutated) mutated++;
        } catch (err) {
          skipped++;
          logger.warn({ code: NM_ERRORS.WAL_CORRUPT_ENTRY, walFile: this.walFile, entryPreview: trimmed.slice(0, 120), err }, "Skipping corrupt WAL entry");
        }
      }
    } catch (err) {
      logger.warn({ code: NM_ERRORS.WAL_CORRUPT_ENTRY, walFile: this.walFile, err }, "Failed reading WAL; continuing with snapshot state");
    }

    return { replayed, mutated, skipped };
  }

  private appendWalEntry(op: WalOperation, payload: Record<string, unknown>): void {
    const entry: WalEntry = {
      op,
      payload,
      timestamp: new Date().toISOString(),
      seq: this.walSeq++,
    };
    try {
      fs.appendFileSync(this.walFile, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (err) {
      logger.error({ code: NM_ERRORS.PERSISTENCE_WRITE_FAILED, walFile: this.walFile, err }, "Failed to append WAL entry");
      throw createNMError(
        NM_ERRORS.PERSISTENCE_WRITE_FAILED,
        `Persistence write failed for WAL file: ${this.walFile}`,
        "Check disk permissions and available space, then retry the mutating operation.",
      );
    }
  }

  private applyWalEntry(entry: WalEntry): boolean {
    switch (entry.op) {
      case "store": {
        const mem = this.deserializeMemory(entry.payload.memory as PersistedMemoryNPC);
        const inserted = this.insertMemory(mem);
        if (inserted) {
          this.nextMemoryId = Math.max(this.nextMemoryId, this.parseMemoryNumericId(mem.id) + 1);
        }
        return inserted;
      }
      case "update": {
        const memoryId = String(entry.payload.memory_id ?? "");
        const updates = (entry.payload.updates ?? {}) as MemoryUpdatePayload;
        if (this.memories[memoryId]) {
          this.applyMemoryUpdates(memoryId, updates);
          return true;
        }
        return false;
      }
      case "delete": {
        const memoryId = String(entry.payload.memory_id ?? "");
        if (this.memories[memoryId]) {
          this.deleteMemoryInternal(memoryId);
          return true;
        }
        return false;
      }
      case "connect": {
        const memoryId1 = String(entry.payload.memory_id_1 ?? "");
        const memoryId2 = String(entry.payload.memory_id_2 ?? "");
        const bidirectional = Boolean(entry.payload.bidirectional ?? true);
        if (this.memories[memoryId1] && this.memories[memoryId2]) {
          this.connectMemoriesInternal(memoryId1, memoryId2, bidirectional);
          return true;
        }
        return false;
      }
      case "import": {
        let serializedMemories: PersistedMemoryNPC[] = [];
        if (Array.isArray(entry.payload.memories)) {
          serializedMemories = entry.payload.memories as PersistedMemoryNPC[];
        }

        // Backward compatibility: legacy import WAL payload stored raw entries + optional default agent_id.
        if (serializedMemories.length === 0 && Array.isArray(entry.payload.entries)) {
          const legacyEntries = entry.payload.entries as ImportMemoryEntry[];
          const legacyDefaultAgentId = typeof entry.payload.agent_id === "string"
            ? entry.payload.agent_id
            : undefined;
          const materializedLegacy = this.materializeImportMemories(legacyEntries, legacyDefaultAgentId);
          serializedMemories = materializedLegacy.map(memory => this.serializeMemory(memory));
        }
        let mutated = false;
        for (const rawMemory of serializedMemories) {
          const memory = this.deserializeMemory(rawMemory);
          const inserted = this.insertMemory(memory);
          if (inserted) {
            this.nextMemoryId = Math.max(this.nextMemoryId, this.parseMemoryNumericId(memory.id) + 1);
            mutated = true;
          }
        }
        return mutated;
      }
      case "register_district": {
        const key = String(entry.payload.key ?? "");
        // Skip if already registered (idempotent replay)
        if (this.districts[key]) return false;
        if ((CANONICAL_DISTRICTS as readonly string[]).includes(key)) return false;
        const lucaParent = String(entry.payload.luca_parent ?? "");
        if (!this.districts[lucaParent]) return false;
        try {
          const ancestor = this.resolveLucaAncestor(lucaParent);
          const inheritedArchetype = this.districts[ancestor].archetype;
          const activities = Array.isArray(entry.payload.activities)
            ? (entry.payload.activities as string[])
            : this.districts[lucaParent].activities.slice();
          this.districts[key] = {
            name: String(entry.payload.name ?? key),
            description: String(entry.payload.description ?? ""),
            archetype: inheritedArchetype,
            activities,
            memories: [],
            luca_parent: lucaParent,
          };
          return true;
        } catch {
          return false;
        }
      }
      default:
        return false;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Chain onto the previous save so concurrent writes are serialized
      this.saveChain = this.saveChain
        .then(() => this.saveToDiskAsync())
        .catch((err) => {
          logger.error({ err }, "Failed to save snapshot");
        });
    }, 100);
  }

  private async saveToDiskAsync(): Promise<void> {
    await fs.promises.mkdir(PERSISTENCE_DIR, { recursive: true });
    const snapshot = this.createSnapshot();
    // Write to a temp file first, then rename for an atomic swap so a partial
    // write can never corrupt the live snapshot.
    const tmp = PERSISTENCE_FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
    await fs.promises.rename(tmp, PERSISTENCE_FILE);
  }

  private saveToDiskSync(): void {
    fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
    const snapshot = this.createSnapshot();
    const tmp = PERSISTENCE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
    fs.renameSync(tmp, PERSISTENCE_FILE);
  }

  private createSnapshot(): MemorySnapshot {
    const persistedMemories: { [id: string]: PersistedMemoryNPC } = {};
    for (const [id, mem] of Object.entries(this.memories)) {
      persistedMemories[id] = this.serializeMemory(mem);
    }

    // Persist only custom districts (ones with luca_parent). Canonical districts
    // are always re-initialised from initializeDistricts().
    const customDistricts: { [key: string]: Omit<MemoryDistrict, "memories"> } = {};
    for (const [key, district] of Object.entries(this.districts)) {
      if (district.luca_parent) {
        const { memories: _memories, ...rest } = district;
        customDistricts[key] = rest;
      }
    }

    return {
      nextMemoryId: this.nextMemoryId,
      memories: persistedMemories,
      customDistricts: Object.keys(customDistricts).length > 0 ? customDistricts : undefined,
    };
  }

  private clearState(): void {
    this.memories = {};
    this.nextMemoryId = 1;
    this.bm25 = new BM25Index();
    for (const district of Object.values(this.districts)) {
      district.memories = [];
    }
  }

  private serializeMemory(memory: MemoryNPC): PersistedMemoryNPC {
    return {
      ...memory,
      created: memory.created.toISOString(),
      last_accessed: memory.last_accessed.toISOString(),
    };
  }

  private deserializeMemory(rawMem: PersistedMemoryNPC): MemoryNPC {
    const now = new Date();
    const createdDate = new Date((rawMem as any).created);
    const lastAccessedDate = new Date((rawMem as any).last_accessed);
    const safeCreated = isNaN(createdDate.getTime()) ? now : createdDate;
    const safeLastAccessed = isNaN(lastAccessedDate.getTime()) ? safeCreated : lastAccessedDate;
    const repeatWriteCount = rawMem.repeat_write_count ?? rawMem.repeat_count;
    return {
      ...rawMem,
      created: safeCreated,
      last_accessed: safeLastAccessed,
      repeat_write_count: repeatWriteCount,
      repeat_count: repeatWriteCount,
    };
  }

  private parseMaxMemories(rawValue?: string): number | undefined {
    if (!rawValue || !rawValue.trim()) return undefined;
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  }

  private parseEvictionPolicy(rawValue?: string): EvictionPolicy {
    if (rawValue === "access_frequency" || rawValue === "district_priority") {
      return rawValue;
    }
    return "lru";
  }

  private ensureCapacityForInsert(recordWal = true): void {
    if (!this.maxMemories) return;
    while (Object.keys(this.memories).length >= this.maxMemories) {
      const evictedId = this.evictOneMemory(recordWal);
      if (!evictedId) return;
      logger.info({ memoryId: evictedId, evictionPolicy: this.evictionPolicy, maxMemories: this.maxMemories }, "Evicted memory due to cap");
    }
  }

  private enforceMaxMemoriesOnStartup(): number {
    if (!this.maxMemories) return 0;
    let evictions = 0;
    while (Object.keys(this.memories).length > this.maxMemories) {
      const evictedId = this.evictOneMemory(false);
      if (!evictedId) break;
      evictions++;
    }
    return evictions;
  }

  private evictOneMemory(recordWal = true): string | undefined {
    const all = Object.values(this.memories);
    if (all.length === 0) return undefined;

    let candidate: MemoryNPC | undefined;
    if (this.evictionPolicy === "access_frequency") {
      candidate = all.reduce((lowest, current) =>
        current.access_count < lowest.access_count ? current : lowest
      );
    } else if (this.evictionPolicy === "district_priority") {
      const countsByDistrict = new Map<string, number>();
      for (const memory of all) {
        countsByDistrict.set(memory.district, (countsByDistrict.get(memory.district) ?? 0) + 1);
      }
      let topDistrict = all[0].district;
      let topCount = -1;
      for (const [district, count] of countsByDistrict.entries()) {
        if (count > topCount) {
          topCount = count;
          topDistrict = district;
        }
      }
      const districtMemories = all.filter(m => m.district === topDistrict);
      candidate = districtMemories.reduce((oldest, current) =>
        current.last_accessed.getTime() < oldest.last_accessed.getTime() ? current : oldest
      );
    } else {
      candidate = all.reduce((oldest, current) =>
        current.last_accessed.getTime() < oldest.last_accessed.getTime() ? current : oldest
      );
    }

    if (!candidate) return undefined;
    if (recordWal) {
      this.appendWalEntry("delete", { memory_id: candidate.id, reason: "eviction" });
    }
    this.deleteMemoryInternal(candidate.id);
    return candidate.id;
  }

  private parseMemoryNumericId(memoryId: string): number {
    const numericPart = Number.parseInt(memoryId.replace(/^memory_/, ""), 10);
    return Number.isFinite(numericPart) ? numericPart : 0;
  }

  private insertMemory(memory: MemoryNPC): boolean {
    if (!this.districts[memory.district]) {
      const valid = Object.keys(this.districts).join(", ");
      logger.warn({ memoryId: memory.id, district: memory.district, validDistricts: valid }, "Skipping memory with unknown district during load");
      return false;
    }
    // If the memory ID already exists in a different district, remove it from the old
    // district array first to avoid duplicate district membership during WAL replay.
    const existing = this.memories[memory.id];
    if (existing && existing.district !== memory.district && this.districts[existing.district]) {
      const oldDistrictMemories = this.districts[existing.district].memories;
      const idx = oldDistrictMemories.indexOf(memory.id);
      if (idx !== -1) {
        oldDistrictMemories.splice(idx, 1);
      }
    }
    this.memories[memory.id] = memory;
    if (!this.districts[memory.district].memories.includes(memory.id)) {
      this.districts[memory.district].memories.push(memory.id);
    }
    this.bm25.addDocument(memory.id, this.documentText(memory));
    return true;
  }

  private documentText(memory: MemoryNPC): string {
    return [memory.content, memory.name, ...memory.tags].join(" ");
  }

  private normalizedBm25Scores(candidates: MemoryNPC[], query: string): Map<string, number> {
    const terms = this.bm25.queryTerms(query);
    if (terms.length === 0 || candidates.length === 0) {
      return new Map(candidates.map(memory => [memory.id, 0]));
    }

    const rawScores = candidates.map(memory => ({
      id: memory.id,
      score: this.bm25.score(memory.id, terms),
    }));

    const maxScore = rawScores.reduce((currentMax, candidate) => Math.max(currentMax, candidate.score), 0);
    if (maxScore === 0) {
      return new Map(rawScores.map(candidate => [candidate.id, 0]));
    }

    return new Map(rawScores.map(candidate => [candidate.id, candidate.score / maxScore]));
  }

  private normalizedRecencyScores(candidates: MemoryNPC[]): Map<string, number> {
    if (candidates.length === 0) {
      return new Map();
    }

    const createdTimes = candidates.map(memory => memory.created.getTime());
    const oldest = Math.min(...createdTimes);
    const newest = Math.max(...createdTimes);
    const range = newest - oldest;

    if (range <= 0) {
      return new Map(candidates.map(memory => [memory.id, 1]));
    }

    return new Map(
      candidates.map(memory => [memory.id, (memory.created.getTime() - oldest) / range]),
    );
  }

  storageDiagnostics(): StorageDiagnostics {
    return {
      snapshot_path: PERSISTENCE_FILE,
      wal_path: this.walFile,
      resolved_source: PERSISTENCE_LOCATION.source,
    };
  }

  private resolveImportCandidates(
    entries: ImportMemoryEntry[] | undefined,
    filePath?: string,
  ): { source: "entries" | "file_path"; candidates: ImportCandidate[] } {
    if (Array.isArray(entries) && entries.length > 0 && filePath) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        "Provide either entries or file_path to import_memories, not both.",
        "Choose one source: inline entries for direct imports, or file_path for snapshot migration/import.",
      );
    }

    if (filePath) {
      return {
        source: "file_path",
        candidates: this.readImportSnapshotFile(filePath),
      };
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        "import_memories requires either a non-empty entries array or a file_path.",
        "Provide entries for inline bulk import, or provide file_path for snapshot import.",
      );
    }

    return {
      source: "entries",
      candidates: entries.map((entry) => ({ ...entry })),
    };
  }

  private validateImportFilePath(filePath: string): string {
    const resolvedPath = path.resolve(filePath);
    const resolvedPersistenceDir = path.resolve(PERSISTENCE_DIR);
    const hasJsonExtension = path.extname(resolvedPath).toLowerCase() === ".json";
    if (!hasJsonExtension) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Import file must use a .json extension: ${filePath}`,
        "Provide a JSON snapshot file path ending in .json.",
      );
    }

    const isWithinPersistenceDir =
      resolvedPath === resolvedPersistenceDir ||
      resolvedPath.startsWith(`${resolvedPersistenceDir}${path.sep}`);

    if (!this.allowExternalImportFiles && !isWithinPersistenceDir) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Import file path is outside the allowed persistence directory: ${filePath}`,
        `Place the snapshot under ${resolvedPersistenceDir}, or set NEURODIVERGENT_MEMORY_IMPORT_ALLOW_EXTERNAL_FILE=true if external file imports are intentional.`,
      );
    }

    return resolvedPath;
  }

  private readImportSnapshotFile(filePath: string): ImportCandidate[] {
    const validatedPath = this.validateImportFilePath(filePath);
    let raw = "";
    try {
      raw = fs.readFileSync(validatedPath, "utf-8");
    } catch (error) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Unable to read import file: ${filePath}`,
        "Verify file_path points to a readable JSON snapshot on disk, then retry import_memories.",
      );
    }

    let parsed: ImportMemorySnapshot;
    try {
      parsed = JSON.parse(raw) as ImportMemorySnapshot;
    } catch {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Import file is not valid JSON: ${filePath}`,
        "Provide a server snapshot JSON file with a top-level memories object.",
      );
    }

    if (!parsed || typeof parsed !== "object" || !parsed.memories || typeof parsed.memories !== "object") {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Import file is not a server snapshot: ${filePath}`,
        "Provide a JSON snapshot produced by the server, containing nextMemoryId and memories.",
      );
    }

    const ordered = Object.entries(parsed.memories)
      .sort(([leftId], [rightId]) => {
        const leftNumeric = this.parseMemoryNumericId(leftId);
        const rightNumeric = this.parseMemoryNumericId(rightId);
        if (leftNumeric !== rightNumeric) {
          return leftNumeric - rightNumeric;
        }
        return leftId.localeCompare(rightId);
      });

    return ordered.map(([sourceMemoryId, rawMemory]) => {
      const deserialized = this.deserializeMemory(rawMemory);
      if (deserialized.id !== sourceMemoryId) {
        throw createNMError(
          NM_ERRORS.INPUT_VALIDATION_FAILED,
          `Snapshot memory id mismatch for ${sourceMemoryId}: embedded id is ${deserialized.id}.`,
          "Ensure each snapshot memories key matches the embedded memory.id before retrying import_memories.",
        );
      }
      return {
        content: deserialized.content,
        district: deserialized.district,
        tags: [...deserialized.tags],
        emotional_valence: deserialized.emotional_valence,
        intensity: deserialized.intensity,
        agent_id: deserialized.agent_id,
        project_id: deserialized.project_id,
        epistemic_status: deserialized.epistemic_status,
        source_memory_id: sourceMemoryId,
        source_connections: [...deserialized.connections],
        name: deserialized.name,
        archetype: deserialized.archetype,
        traits: [...deserialized.traits],
        concerns: [...deserialized.concerns],
        created: deserialized.created,
        last_accessed: deserialized.last_accessed,
        access_count: deserialized.access_count,
      };
    });
  }

  private fingerprintForImportCandidate(candidate: Pick<ImportCandidate, "content" | "tags">, dedupe: ImportDedupePolicy): string | undefined {
    switch (dedupe) {
      case "none":
        return undefined;
      case "content_hash":
        return crypto.createHash("sha256").update(candidate.content).digest("hex");
      case "content_plus_tags": {
        const stableTags = [...(candidate.tags ?? [])].sort().join("\u0000");
        return crypto.createHash("sha256").update(`${candidate.content}\u0001${stableTags}`).digest("hex");
      }
    }
  }

  private dedupeReasonCode(dedupe: ImportDedupePolicy): string {
    switch (dedupe) {
      case "none":
        return "NONE";
      case "content_hash":
        return "DEDUPE_CONTENT_HASH";
      case "content_plus_tags":
        return "DEDUPE_CONTENT_PLUS_TAGS";
    }
  }

  private validateImportDedupePolicy(dedupe: string | undefined): ImportDedupePolicy {
    if (dedupe === undefined || dedupe === "none" || dedupe === "content_hash" || dedupe === "content_plus_tags") {
      return dedupe ?? "none";
    }

    throw createNMError(
      NM_ERRORS.INPUT_VALIDATION_FAILED,
      `Invalid dedupe policy: ${dedupe}`,
      "Use one of: none, content_hash, or content_plus_tags.",
    );
  }

  private projectIdFieldPathForImport(planSource: "entries" | "file_path", index: number, candidate: ImportCandidate): string {
    if (planSource === "file_path") {
      return candidate.source_memory_id
        ? `snapshot[${candidate.source_memory_id}].project_id`
        : `snapshot[${index}].project_id`;
    }

    return `entries[${index}].project_id`;
  }

  private buildImportPlan(
    entries: ImportMemoryEntry[] | undefined,
    default_agent_id: string | undefined,
    options: ImportExecutionOptions = {},
  ): ImportPlan {
    const dedupe = this.validateImportDedupePolicy(options.dedupe);
    const preserveIds = options.preserve_ids ?? false;
    const mergeConnections = options.merge_connections ?? false;
    const resolved = this.resolveImportCandidates(entries, options.file_path);

    if (preserveIds && resolved.source !== "file_path") {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        "preserve_ids is only supported when importing from file_path snapshots.",
        "Use file_path with a server snapshot, or omit preserve_ids for inline entry imports.",
      );
    }
    if (mergeConnections && resolved.source !== "file_path") {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        "merge_connections is only supported when importing from file_path snapshots.",
        "Use file_path with a server snapshot, or omit merge_connections for inline entry imports.",
      );
    }

    const plan: ImportPlan = {
      source: resolved.source,
      requested: resolved.candidates.length,
      memories: [],
      skipped: [],
      failures: [],
      nextMemoryId: this.nextMemoryId,
    };

    const seenFingerprints = new Set<string>();
    if (dedupe !== "none") {
      for (const memory of Object.values(this.memories)) {
        const existingFingerprint = this.fingerprintForImportCandidate(memory, dedupe);
        if (existingFingerprint) {
          seenFingerprints.add(existingFingerprint);
        }
      }
    }

    const idMap = new Map<string, string>();
    const reservedIds = new Set<string>(Object.keys(this.memories));
    let nextId = this.nextMemoryId;

    for (const [index, candidate] of resolved.candidates.entries()) {
      try {
        if (!this.districts[candidate.district]) {
          plan.failures.push({
            index,
            source_memory_id: candidate.source_memory_id,
            reason_code: "UNKNOWN_DISTRICT",
            detail: `Unknown district: ${candidate.district}`,
          });
          continue;
        }

        if (candidate.project_id !== undefined) {
          validateProjectId(candidate.project_id, this.projectIdFieldPathForImport(plan.source, index, candidate));
        }

        const fingerprint = this.fingerprintForImportCandidate(candidate, dedupe);
        if (fingerprint && seenFingerprints.has(fingerprint)) {
          plan.skipped.push({
            index,
            source_memory_id: candidate.source_memory_id,
            reason_code: this.dedupeReasonCode(dedupe),
            detail: `Skipped by dedupe policy ${dedupe}.`,
          });
          continue;
        }

        let targetId: string;
        if (preserveIds) {
          const sourceMemoryId = candidate.source_memory_id;
          if (!sourceMemoryId) {
            plan.failures.push({
              index,
              source_memory_id: candidate.source_memory_id,
              reason_code: "PRESERVE_IDS_REQUIRES_SNAPSHOT_IDS",
              detail: "Snapshot import entry is missing a source memory id.",
            });
            continue;
          }
          if (reservedIds.has(sourceMemoryId)) {
            plan.failures.push({
              index,
              source_memory_id: sourceMemoryId,
              reason_code: "ID_CONFLICT",
              detail: `Cannot preserve imported id ${sourceMemoryId}: it already exists in the current store.`,
            });
            continue;
          }
          targetId = sourceMemoryId;
        } else {
          targetId = `memory_${nextId++}`;
        }

        const districtArchetype = this.districts[candidate.district].archetype;
        const created = candidate.created ?? new Date();
        const lastAccessed = candidate.last_accessed ?? created;
        const memory: MemoryNPC = {
          id: targetId,
          name: candidate.name ?? this.generateMemoryName(candidate.archetype ?? districtArchetype, candidate.content),
          archetype: candidate.archetype ?? districtArchetype,
          agent_id: candidate.agent_id ?? default_agent_id,
          project_id: candidate.project_id,
          district: candidate.district,
          content: candidate.content,
          traits: candidate.traits ? [...candidate.traits] : this.generateTraits(candidate.archetype ?? districtArchetype),
          concerns: candidate.concerns ? [...candidate.concerns] : this.generateConcerns(candidate.archetype ?? districtArchetype),
          connections: [],
          tags: candidate.tags ?? [],
          created,
          last_accessed: lastAccessed,
          access_count: candidate.access_count ?? 1,
          emotional_valence: candidate.emotional_valence,
          intensity: candidate.intensity ?? 0.5,
          epistemic_status: resolveDefaultEpistemicStatus(
            candidate.district,
            candidate.tags ?? [],
            candidate.epistemic_status,
          ),
        };

        plan.memories.push({
          index,
          source_memory_id: candidate.source_memory_id,
          source_connections: candidate.source_connections ?? [],
          memory,
        });

        reservedIds.add(targetId);
        if (candidate.source_memory_id) {
          idMap.set(candidate.source_memory_id, targetId);
        }
        if (fingerprint) {
          seenFingerprints.add(fingerprint);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        plan.failures.push({
          index,
          source_memory_id: candidate.source_memory_id,
          reason_code: "VALIDATION_FAILED",
          detail: message,
        });
      }
    }

    if (mergeConnections) {
      const importedIds = new Set(plan.memories.map(entry => entry.memory.id));
      for (const entry of plan.memories) {
        const remappedConnections: string[] = [];
        const seenConnections = new Set<string>();
        for (const sourceConnectionId of entry.source_connections) {
          const targetId = idMap.get(sourceConnectionId) ?? sourceConnectionId;
          const targetExists = importedIds.has(targetId) || Boolean(this.memories[targetId]);
          if (!targetExists) {
            plan.failures.push({
              index: entry.index,
              source_memory_id: entry.source_memory_id,
              reason_code: "INVALID_CONNECTION_TARGET",
              detail: `Connection target ${sourceConnectionId} does not exist in the snapshot import batch or the current store.`,
            });
            continue;
          }
          if (targetId === entry.memory.id || seenConnections.has(targetId)) {
            continue;
          }
          seenConnections.add(targetId);
          remappedConnections.push(targetId);
        }
        entry.memory.connections = remappedConnections;
      }
    }

    plan.nextMemoryId = plan.memories.reduce(
      (currentMax, entry) => Math.max(currentMax, this.parseMemoryNumericId(entry.memory.id) + 1),
      nextId,
    );

    return plan;
  }

  private formatImportFailures(failures: ImportPlanFailure[]): string {
    return failures
      .slice(0, 5)
      .map(failure => `entry ${failure.index}${failure.source_memory_id ? ` (${failure.source_memory_id})` : ""}: ${failure.reason_code} - ${failure.detail}`)
      .join("; ");
  }

  private successfulImportIds(plan: ImportPlan): string[] {
    const failedIndexes = new Set(plan.failures.map(failure => failure.index));
    return plan.memories
      .filter(entry => !failedIndexes.has(entry.index))
      .map(entry => entry.memory.id);
  }

  private detectRepeatCandidate(content: string, agentId?: string): { memory: MemoryNPC; similarityScore: number } | undefined {
    // Select the 10 most recently created memories for this agent (or globally) in O(N log k) with k=10,
    // instead of sorting all memories (O(N log N)).
    const candidates = Object.values(this.memories).filter(memory =>
      agentId ? memory.agent_id === agentId : true,
    );

    const recentCandidates: MemoryNPC[] = [];
    for (const memory of candidates) {
      const createdTime = memory.created.getTime();

      if (recentCandidates.length === 0) {
        recentCandidates.push(memory);
        continue;
      }

      // If we don't yet have 10 candidates, insert in sorted (descending created) position.
      if (recentCandidates.length < 10) {
        let inserted = false;
        for (let i = 0; i < recentCandidates.length; i++) {
          if (createdTime > recentCandidates[i].created.getTime()) {
            recentCandidates.splice(i, 0, memory);
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          recentCandidates.push(memory);
        }
        continue;
      }

      // We already have 10; only insert if this memory is newer than the oldest in the list.
      const oldest = recentCandidates[recentCandidates.length - 1];
      if (createdTime <= oldest.created.getTime()) {
        continue;
      }

      let inserted = false;
      for (let i = 0; i < recentCandidates.length; i++) {
        if (createdTime > recentCandidates[i].created.getTime()) {
          recentCandidates.splice(i, 0, memory);
          inserted = true;
          break;
        }
      }
      if (inserted) {
        // Trim back to 10 most recent
        if (recentCandidates.length > 10) {
          recentCandidates.length = 10;
        }
      }
    }
    if (recentCandidates.length === 0) {
      return undefined;
    }

    const queryTerms = this.bm25.queryTerms(content);
    const rawScores = recentCandidates.map(memory => ({
      memory,
      score: this.bm25.score(memory.id, queryTerms),
    }));

    // Normalize BM25 scores to a 0–1 similarity range relative to the best candidate,
    // so that NEURODIVERGENT_MEMORY_REPEAT_THRESHOLD remains stable across corpus sizes.
    const positiveScores = rawScores.filter(candidate => candidate.score > 0);
    if (positiveScores.length === 0) {
      return undefined;
    }

    const maxScore = positiveScores.reduce(
      (currentMax, candidate) => (candidate.score > currentMax ? candidate.score : currentMax),
      positiveScores[0].score,
    );

    const best = positiveScores.reduce(
      (currentBest, candidate) => (candidate.score > currentBest.score ? candidate : currentBest),
      positiveScores[0],
    );

    return {
      memory: best.memory,
      // Return similarity on a 0–1 scale so thresholds remain stable across corpus sizes.
      similarityScore: best.score / maxScore,
    };
  }

  private applyPingPongTelemetry(memory: MemoryNPC, actor?: OperationActorContext): {
    detected: boolean;
    count: number;
    cooldownActivated: boolean;
    cooldownDurationMs: number;
  } {
    const pingPong = this.loopTelemetry.recordWrite({
      memory_id: memory.id,
      district: actor?.district ?? memory.district,
      agent_id: actor?.agent_id ?? memory.agent_id,
      target_district: memory.district,
    });
    if (pingPong.pingPongDetected) {
      memory.ping_pong_counter = (memory.ping_pong_counter ?? 0) + 1;
      this.appendWalEntry("update", {
        memory_id: memory.id,
        updates: { ping_pong_counter: memory.ping_pong_counter },
      });
      logger.info(
        {
          event: "ping_pong_detected",
          memory_id: memory.id,
          count: pingPong.pingPongCount,
          ping_pong_counter: memory.ping_pong_counter,
          cooldown_activated: pingPong.cooldownActivated,
          cooldown_duration_ms: pingPong.cooldownDurationMs,
        },
        "Ping-pong telemetry detected",
      );
      return {
        detected: true,
        count: pingPong.pingPongCount,
        cooldownActivated: pingPong.cooldownActivated,
        cooldownDurationMs: pingPong.cooldownDurationMs,
      };
    }

    return {
      detected: false,
      count: pingPong.pingPongCount,
      cooldownActivated: pingPong.cooldownActivated,
      cooldownDurationMs: pingPong.cooldownDurationMs,
    };
  }

  private buildNoNetNewInfoWarning(matchedMemoryId: string, similarityScore: number): string {
    return `⚠️ No net-new info: incoming content closely repeats ${matchedMemoryId} (similarity=${similarityScore.toFixed(3)}). Consider updating the existing memory instead of creating another duplicate.`;
  }

  private buildDistillSuggestion(memoryId: string, logicalEmotionalReadCount: number): string {
    return `⚠️ Distillation suggested: logical_analysis has accessed emotional_processing memory ${memoryId} ${logicalEmotionalReadCount} times in the current loop window. Consider calling distill_memory to translate the signal before continuing analysis.`;
  }

  buildCrossDistrictCooldownWarning(memoryId: string, cooldownMs: number): string {
    return `⚠️ Cross-district cooldown started for ${memoryId}: repetitive cross-district churn was detected. Additional cross-district writes will be blocked for ${cooldownMs}ms.`;
  }

  private enforceCrossDistrictCooldown(memory: MemoryNPC, actor?: OperationActorContext): void {
    if (!actor?.district || actor.district === memory.district) {
      return;
    }

    const cooldownRemainingMs = this.loopTelemetry.getCooldownRemaining(memory.id);
    if (cooldownRemainingMs <= 0) {
      return;
    }

    throw createNMError(
      NM_ERRORS.CROSS_DISTRICT_COOLDOWN_ACTIVE,
      `Cross-district cooldown active for ${memory.id}; retry in ${cooldownRemainingMs}ms.`,
      "Wait for the cooldown window to expire, reduce repetitive cross-district churn, or set NEURODIVERGENT_MEMORY_CROSS_DISTRICT_COOLDOWN_MS=0 to disable the cooldown.",
    );
  }

  // ── Districts ──────────────────────────────────────────────────────────────

  private initializeDistricts() {
    this.districts = {
      "logical_analysis": {
        name: "Logical Analysis District",
        description: "Structured thinking, problem solving, and analytical processes",
        archetype: "scholar",
        activities: ["analyzing", "categorizing", "hypothesizing", "researching"],
        memories: []
      },
      "emotional_processing": {
        name: "Emotional Processing District",
        description: "Feelings, emotional responses, and affective states",
        archetype: "mystic",
        activities: ["feeling", "processing", "reflecting", "expressing"],
        memories: []
      },
      "practical_execution": {
        name: "Practical Execution District",
        description: "Action-oriented thoughts, tasks, and implementation",
        archetype: "merchant",
        activities: ["planning", "executing", "organizing", "managing"],
        memories: []
      },
      "vigilant_monitoring": {
        name: "Vigilant Monitoring District",
        description: "Awareness, safety concerns, and protective thinking",
        archetype: "guard",
        activities: ["monitoring", "alerting", "protecting", "assessing"],
        memories: []
      },
      "creative_synthesis": {
        name: "Creative Synthesis District",
        description: "Novel connections, creative insights, and innovative thinking",
        archetype: "mystic",
        activities: ["connecting", "creating", "innovating", "synthesizing"],
        memories: []
      }
    };
  }

  /**
   * Resolve the canonical LUCA ancestor for a district by walking the luca_parent chain.
   * Returns the canonical district key if the chain is valid, or throws if it is broken.
   */
  private resolveLucaAncestor(districtKey: string): string {
    const visited = new Set<string>();
    let currentDistrictKey = districtKey;

    while (true) {
      if (visited.has(currentDistrictKey)) {
        throw createNMError(
          NM_ERRORS.INPUT_VALIDATION_FAILED,
          `Cycle detected in LUCA chain while resolving district "${districtKey}": "${currentDistrictKey}" was visited more than once.`,
          "Ensure every custom district's luca_parent chain is acyclic and ultimately traces back to one of the 5 canonical districts.",
        );
      }
      visited.add(currentDistrictKey);

      const district = this.districts[currentDistrictKey];
      if (!district) {
        throw createNMError(
          NM_ERRORS.UNKNOWN_DISTRICT,
          `Unknown district in LUCA chain: ${currentDistrictKey}`,
          "Ensure every district in the ancestry chain is registered before the child district.",
        );
      }

      if ((CANONICAL_DISTRICTS as readonly string[]).includes(currentDistrictKey)) {
        return currentDistrictKey;
      }

      if (!district.luca_parent) {
        throw createNMError(
          NM_ERRORS.INPUT_VALIDATION_FAILED,
          `Custom district "${currentDistrictKey}" has no luca_parent and is not a canonical district.`,
          "Every custom district must declare a luca_parent that traces back to one of the 5 canonical districts.",
        );
      }

      currentDistrictKey = district.luca_parent;
    }
  }

  /**
   * Register a custom district with LUCA ancestry validation.
   * Custom districts inherit their archetype from the canonical ancestor.
   */
  registerDistrict(
    key: string,
    name: string,
    description: string,
    lucaParent: string,
    activities: string[] = [],
  ): MemoryDistrict {
    // Validate district key format (snake_case)
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Invalid district key "${key}": must be snake_case (lowercase letters, digits, underscores).`,
        "Use a snake_case identifier like project_build_pipeline.",
      );
    }

    // Prevent overriding canonical districts
    if ((CANONICAL_DISTRICTS as readonly string[]).includes(key)) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Cannot override canonical district: ${key}`,
        "Canonical districts (logical_analysis, emotional_processing, practical_execution, vigilant_monitoring, creative_synthesis) cannot be redefined.",
      );
    }

    // Prevent duplicate registration
    if (this.districts[key]) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `District already registered: ${key}`,
        "Choose a different key or use the existing district.",
      );
    }

    // Validate the LUCA parent exists
    if (!this.districts[lucaParent]) {
      throw createNMError(
        NM_ERRORS.UNKNOWN_DISTRICT,
        `Unknown LUCA parent: ${lucaParent}`,
        `Use one of the existing districts as parent: ${Object.keys(this.districts).join(", ")}.`,
      );
    }

    // Walk the ancestry chain to verify it reaches a canonical district
    const ancestor = this.resolveLucaAncestor(lucaParent);
    const inheritedArchetype = this.districts[ancestor].archetype;

    const district: MemoryDistrict = {
      name,
      description,
      archetype: inheritedArchetype,
      activities: activities.length > 0 ? activities : this.districts[lucaParent].activities.slice(),
      memories: [],
      luca_parent: lucaParent,
    };

    this.appendWalEntry("register_district", {
      key,
      name: district.name,
      description: district.description,
      luca_parent: lucaParent,
      activities: district.activities,
    });
    this.districts[key] = district;
    this.scheduleSave();

    logger.info(
      { operation: "register_district", key, name, lucaParent, ancestor, archetype: inheritedArchetype },
      "Registered custom district",
    );

    return district;
  }

  /**
   * Return the ancestry chain for a district key as an ordered array,
   * starting from the given key and walking up via luca_parent until
   * reaching a canonical district (which has no luca_parent).
   *
   * The caller is responsible for ensuring startKey is a registered district;
   * if it is not, the returned array will contain only the unknown key.
   */
  getDistrictAncestryChain(startKey: string): string[] {
    const chain: string[] = [];
    let current: string | undefined = startKey;
    while (current) {
      chain.push(current);
      current = this.districts[current]?.luca_parent;
    }
    return chain;
  }

  // ── Core CRUD ──────────────────────────────────────────────────────────────

  storeMemory(
    content: string,
    district: string,
    tags: string[] = [],
    emotional_valence?: number,
    intensity = 0.5,
    agent_id?: string,
    project_id?: string,
    epistemic_status?: EpistemicStatus
  ): StoreMemoryResult {
    if (!this.districts[district]) {
      throw createNMError(
        NM_ERRORS.UNKNOWN_DISTRICT,
        `Unknown district: ${district}`,
        `Use one of the configured districts: ${Object.keys(this.districts).join(", ")}.`,
      );
    }
    if (project_id !== undefined) {
      validateProjectId(project_id);
    }

    const id = `memory_${this.nextMemoryId++}`;
    const archetype = this.districts[district].archetype;
    const name = this.generateMemoryName(archetype, content);
    const now = new Date();
    const repeatCandidate = this.detectRepeatCandidate(content, agent_id);

    let repeatDetected = false;
    let matchedMemoryId: string | undefined;
    let similarityScore: number | undefined;
    let pingPongDetected = false;
    let pingPongCount: number | undefined;
    let noNetNewInfoWarning: string | undefined;
    let cooldownDurationMs: number | undefined;

    if (repeatCandidate && repeatCandidate.similarityScore >= this.loopTelemetry.getRepeatThreshold()) {
      const matchedMemory = repeatCandidate.memory;
      this.enforceCrossDistrictCooldown(matchedMemory, { district, agent_id });
      const nextRepeatCount = (matchedMemory.repeat_write_count ?? matchedMemory.repeat_count ?? 0) + 1;
      matchedMemory.repeat_write_count = nextRepeatCount;
      matchedMemory.repeat_count = nextRepeatCount;
      matchedMemory.last_similarity_score = repeatCandidate.similarityScore;

      this.appendWalEntry("update", {
        memory_id: matchedMemory.id,
        updates: {
          repeat_write_count: matchedMemory.repeat_write_count,
          repeat_count: matchedMemory.repeat_count,
          last_similarity_score: matchedMemory.last_similarity_score,
        },
      });

      const pingPongResult = this.applyPingPongTelemetry(matchedMemory, {
        district,
        agent_id,
      });
      pingPongDetected = pingPongResult.detected;
      pingPongCount = pingPongResult.count;
      cooldownDurationMs = pingPongResult.cooldownActivated ? pingPongResult.cooldownDurationMs : undefined;

      this.loopTelemetry.recordHighSimilarityWrite({
        memory_id: id,
        matched_memory_id: matchedMemory.id,
        similarity_score: repeatCandidate.similarityScore,
        timestamp: now.toISOString(),
        district,
        agent_id,
      });

      repeatDetected = true;
      matchedMemoryId = matchedMemory.id;
      similarityScore = repeatCandidate.similarityScore;
      noNetNewInfoWarning = this.buildNoNetNewInfoWarning(matchedMemory.id, repeatCandidate.similarityScore);
    }

    const resolvedEpistemicStatus = resolveDefaultEpistemicStatus(district, tags, epistemic_status);

    const memory: MemoryNPC = {
      id,
      name,
      archetype,
      agent_id,
      project_id,
      district,
      content,
      traits: this.generateTraits(archetype),
      concerns: this.generateConcerns(archetype),
      connections: [],
      tags,
      created: now,
      last_accessed: now,
      access_count: 1,
      emotional_valence,
      intensity,
      epistemic_status: resolvedEpistemicStatus,
      last_similarity_score: similarityScore,
    };

    this.ensureCapacityForInsert();
    this.appendWalEntry("store", { memory: this.serializeMemory(memory) });
    this.insertMemory(memory);
    this.loopTelemetry.recordWrite(memory);
    this.scheduleSave();
    logger.info(
      {
        operation: "store",
        memoryId: memory.id,
        district,
        agentId: agent_id ?? "unassigned",
        repeat_detected: repeatDetected,
        matched_memory_id: matchedMemoryId,
        similarity_score: similarityScore,
      },
      "Stored memory",
    );

    return {
      memory,
      repeat_detected: repeatDetected,
      matched_memory_id: matchedMemoryId,
      similarity_score: similarityScore,
      ping_pong_detected: pingPongDetected,
      ping_pong_count: pingPongCount,
      no_net_new_info_warning: noNetNewInfoWarning,
      cooldown_duration_ms: cooldownDurationMs,
    };
  }

  retrieveMemory(id: string, actor?: OperationActorContext): RetrieveMemoryResult | null {
    const memory = this.memories[id];
    if (!memory) {
      return null;
    }

    const readSignal = this.loopTelemetry.recordRead({
      memory_id: id,
      district: actor?.district ?? memory.district,
      agent_id: actor?.agent_id ?? memory.agent_id,
      target_district: memory.district,
    });

    return {
      memory,
      distill_suggestion: readSignal.distillSuggested
        ? this.buildDistillSuggestion(id, readSignal.logicalEmotionalReadCount)
        : undefined,
      logical_emotional_read_count: readSignal.logicalEmotionalReadCount,
    };
  }

  updateMemory(
    id: string,
    updates: MemoryUpdatePayload,
    actor?: OperationActorContext,
  ): UpdateMemoryResult {
    const memory = this.memories[id];
    if (!memory) {
      throw createNMError(
        NM_ERRORS.MEMORY_NOT_FOUND,
        `Memory not found: ${id}`,
        "List or search memories first, then retry with a valid memory ID.",
      );
    }

    if (updates.district !== undefined && !this.districts[updates.district]) {
      throw createNMError(
        NM_ERRORS.UNKNOWN_DISTRICT,
        `Unknown district: ${updates.district}`,
        `Use one of the configured districts: ${Object.keys(this.districts).join(", ")}.`,
      );
    }
    if (updates.project_id !== undefined && updates.project_id !== null) {
      validateProjectId(updates.project_id);
    }

    this.enforceCrossDistrictCooldown(memory, actor);

    this.appendWalEntry("update", { memory_id: id, updates });
    this.applyMemoryUpdates(id, updates);
    const pingPongResult = this.applyPingPongTelemetry(this.memories[id], actor);
    this.scheduleSave();
    logger.info({ operation: "update", memoryId: id, changedFields: Object.keys(updates).sort() }, "Updated memory");

    return {
      memory: this.memories[id],
      ping_pong_detected: pingPongResult.detected,
      ping_pong_count: pingPongResult.count,
      cooldown_duration_ms: pingPongResult.cooldownActivated ? pingPongResult.cooldownDurationMs : undefined,
    };
  }

  deleteMemory(id: string): void {
    const memory = this.memories[id];
    if (!memory) {
      throw createNMError(
        NM_ERRORS.MEMORY_NOT_FOUND,
        `Memory not found: ${id}`,
        "List or search memories first, then retry with a valid memory ID.",
      );
    }

    this.appendWalEntry("delete", { memory_id: id });
    this.deleteMemoryInternal(id);
    this.scheduleSave();
    logger.info({ operation: "delete", memoryId: id }, "Deleted memory");
  }

  connectMemories(memoryId1: string, memoryId2: string, bidirectional = true, _agent_id?: string) {
    if (!this.memories[memoryId1]) {
      throw createNMError(
        NM_ERRORS.MEMORY_NOT_FOUND,
        `Memory not found: ${memoryId1}`,
        "List or search memories first, then retry with a valid source memory ID.",
      );
    }
    if (!this.memories[memoryId2]) {
      throw createNMError(
        NM_ERRORS.MEMORY_NOT_FOUND,
        `Memory not found: ${memoryId2}`,
        "List or search memories first, then retry with a valid target memory ID.",
      );
    }

    this.appendWalEntry("connect", {
      memory_id_1: memoryId1,
      memory_id_2: memoryId2,
      bidirectional,
    });
    this.connectMemoriesInternal(memoryId1, memoryId2, bidirectional);

    this.scheduleSave();
    logger.info({ operation: "connect", memoryId1, memoryId2, bidirectional, agentId: _agent_id ?? "unassigned" }, "Connected memories");
  }

  private applyMemoryUpdates(
    id: string,
    updates: MemoryUpdatePayload,
  ): void {
    const memory = this.memories[id];
    if (!memory) return;

    if (updates.district !== undefined && updates.district !== memory.district) {
      const nextDistrict = this.districts[updates.district];
      if (!nextDistrict) {
        logger.warn(
          {
            code: NM_ERRORS.UNKNOWN_DISTRICT,
            memoryId: id,
            attemptedDistrict: updates.district,
          },
          "Skipping district update with unknown district",
        );
      } else {
        this.districts[memory.district].memories = this.districts[memory.district].memories.filter(mid => mid !== id);
        nextDistrict.memories.push(id);
        memory.district = updates.district;
      }
    }

    if (updates.content !== undefined) memory.content = updates.content;
    if (updates.tags !== undefined) memory.tags = updates.tags;
    if (updates.emotional_valence !== undefined) memory.emotional_valence = updates.emotional_valence;
    if (updates.intensity !== undefined) memory.intensity = updates.intensity;
    if (updates.epistemic_status !== undefined) memory.epistemic_status = updates.epistemic_status;
    if (updates.repeat_write_count !== undefined) {
      memory.repeat_write_count = updates.repeat_write_count;
      memory.repeat_count = updates.repeat_write_count;
    }
    if (updates.repeat_count !== undefined) {
      memory.repeat_count = updates.repeat_count;
      memory.repeat_write_count = updates.repeat_count;
    }
    if (updates.last_similarity_score !== undefined) memory.last_similarity_score = updates.last_similarity_score;
    if (updates.ping_pong_counter !== undefined) memory.ping_pong_counter = updates.ping_pong_counter;
    if (Object.prototype.hasOwnProperty.call(updates, "project_id")) {
      if (updates.project_id === null) {
        delete memory.project_id;
      } else if (updates.project_id !== undefined) {
        memory.project_id = updates.project_id;
      }
    }

    this.bm25.addDocument(id, this.documentText(memory));
  }

  private deleteMemoryInternal(id: string): void {
    const memory = this.memories[id];
    if (!memory) return;

    this.districts[memory.district].memories = this.districts[memory.district].memories.filter(mid => mid !== id);
    for (const other of Object.values(this.memories)) {
      other.connections = other.connections.filter(cid => cid !== id);
    }

    this.bm25.removeDocument(id);
    delete this.memories[id];
  }

  private connectMemoriesInternal(memoryId1: string, memoryId2: string, bidirectional: boolean): void {
    if (!this.memories[memoryId1] || !this.memories[memoryId2]) return;

    if (!this.memories[memoryId1].connections.includes(memoryId2)) {
      this.memories[memoryId1].connections.push(memoryId2);
    }

    if (bidirectional && !this.memories[memoryId2].connections.includes(memoryId1)) {
      this.memories[memoryId2].connections.push(memoryId1);
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  searchMemories(
    query: string,
    district?: string,
    project_id?: string,
    tags?: string[],
    epistemic_statuses?: EpistemicStatusFilter[],
    min_score?: number,
    emotional_valence_min?: number,
    emotional_valence_max?: number,
    intensity_min?: number,
    intensity_max?: number,
    context?: string,
    recency_weight = 0,
  ): ScoredMemory[] {
    if (recency_weight < 0 || recency_weight > 1) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Invalid recency_weight: ${recency_weight}. Expected a value between 0 and 1.`,
        "Provide recency_weight as a number in the inclusive range 0..1.",
      );
    }

    let candidates = Object.values(this.memories);

    if (district) {
      candidates = candidates.filter(m => m.district === district);
    }

    if (project_id) {
      candidates = candidates.filter(m => m.project_id === project_id);
    }

    if (tags && tags.length > 0) {
      candidates = candidates.filter(m =>
        tags.some(tag => m.tags.includes(tag))
      );
    }

    if (epistemic_statuses && epistemic_statuses.length > 0) {
      candidates = candidates.filter(m => {
        const status = m.epistemic_status ?? "unset";
        return epistemic_statuses.includes(status);
      });
    }

    if (emotional_valence_min !== undefined) {
      // Memories without emotional_valence set are excluded when a range filter is applied
      candidates = candidates.filter(m => m.emotional_valence !== undefined && m.emotional_valence >= emotional_valence_min!);
    }
    if (emotional_valence_max !== undefined) {
      candidates = candidates.filter(m => m.emotional_valence !== undefined && m.emotional_valence <= emotional_valence_max!);
    }
    if (intensity_min !== undefined) {
      candidates = candidates.filter(m => (m.intensity ?? 0.5) >= intensity_min!);
    }
    if (intensity_max !== undefined) {
      candidates = candidates.filter(m => (m.intensity ?? 0.5) <= intensity_max!);
    }

    const hasContext = typeof context === "string" && context.trim().length > 0;
    const queryScores = this.normalizedBm25Scores(candidates, query);
    const contextScores = hasContext
      ? this.normalizedBm25Scores(candidates, context)
      : new Map(candidates.map(memory => [memory.id, 0]));
    const recencyScores = recency_weight > 0
      ? this.normalizedRecencyScores(candidates)
      : new Map(candidates.map(memory => [memory.id, 0]));

    const scored = candidates.map(memory => {
      const queryScore = queryScores.get(memory.id) ?? 0;
      const contextScore = contextScores.get(memory.id) ?? 0;
      const semanticScore = hasContext && queryScore > 0
        ? (queryScore * 0.75) + (contextScore * 0.25)
        : queryScore;
      const recencyScore = recencyScores.get(memory.id) ?? 0;

      return {
        memory,
        score: semanticScore + (recencyScore * recency_weight),
        semanticScore,
      };
    });

    if (scored.reduce((mx, candidate) => Math.max(mx, candidate.semanticScore), 0) === 0) {
      return [];
    }

    const maxScore = scored.reduce((mx, candidate) => Math.max(mx, candidate.score), 0);
    if (maxScore === 0) {
      return [];
    }

    const normalized: ScoredMemory[] = scored.map(candidate => ({
      memory: candidate.memory,
      score: candidate.score / maxScore,
    }));

    // Apply min_score filter after normalisation (score >= 0 naturally passes a 0 threshold)
    const threshold = min_score ?? 0;
    const filtered = normalized.filter(s => s.score >= threshold);

    // Sort descending by score
    filtered.sort((a, b) => b.score - a.score);

    return filtered;
  }

  // ── Graph traversal ────────────────────────────────────────────────────────

  traverseFrom(memoryId: string, depth: number, filterDistrict?: string): MemoryNPC[] {
    const root = this.memories[memoryId];
    if (!root) {
      throw createNMError(
        NM_ERRORS.MEMORY_NOT_FOUND,
        `Memory not found: ${memoryId}`,
        "List or search memories first, then retry with a valid memory ID.",
      );
    }

    const visited = new Set<string>();
    const queue: Array<{ id: string; level: number }> = [{ id: memoryId, level: 0 }];
    const results: MemoryNPC[] = [];

    let i = 0;
    while (i < queue.length) {
      const { id, level } = queue[i++]!;
      if (visited.has(id)) continue;
      visited.add(id);

      const mem = this.memories[id];
      if (!mem) continue;

      if (id !== memoryId) {
        if (!filterDistrict || mem.district === filterDistrict) {
          results.push(mem);
        }
      }

      if (level < depth) {
        for (const connId of mem.connections) {
          if (!visited.has(connId)) {
            queue.push({ id: connId, level: level + 1 });
          }
        }
      }
    }

    return results;
  }

  relatedTo(
    memoryId: string,
    query?: string,
    context?: string,
    epistemic_statuses?: EpistemicStatusFilter[],
  ): ScoredMemory[] {
    const root = this.memories[memoryId];
    if (!root) {
      throw createNMError(
        NM_ERRORS.MEMORY_NOT_FOUND,
        `Memory not found: ${memoryId}`,
        "List or search memories first, then retry with a valid memory ID.",
      );
    }

    // Collect memories within 2 hops with their hop distance
    const hopMap = new Map<string, number>();
    const bfsQueue: Array<{ id: string; depth: number }> = [{ id: memoryId, depth: 0 }];
    const visited = new Set<string>([memoryId]);

    while (bfsQueue.length > 0) {
      const { id, depth } = bfsQueue.shift()!;
      if (depth > 2) continue;
      const mem = this.memories[id];
      if (!mem) continue;
      for (const connId of mem.connections) {
        if (!visited.has(connId)) {
          visited.add(connId);
          hopMap.set(connId, depth + 1);
          bfsQueue.push({ id: connId, depth: depth + 1 });
        }
      }
    }

    if (hopMap.size === 0) return [];

    const candidates = Array.from(hopMap.entries())
      .map(([id, hops]) => ({ memory: this.memories[id], hops }))
      .filter((entry): entry is { memory: MemoryNPC; hops: number } => Boolean(entry.memory));

    const filteredCandidates = epistemic_statuses && epistemic_statuses.length > 0
      ? candidates.filter(({ memory }) => {
          const status = memory.epistemic_status ?? "unset";
          return epistemic_statuses.includes(status);
        })
      : candidates;

    if (filteredCandidates.length === 0) return [];

    const semanticQuery = query && query.trim().length > 0 ? query : root.content;
    const hasContext = typeof context === "string" && context.trim().length > 0;
    const queryScores = this.normalizedBm25Scores(filteredCandidates.map(entry => entry.memory), semanticQuery);
    const contextScores = hasContext
      ? this.normalizedBm25Scores(filteredCandidates.map(entry => entry.memory), context)
      : new Map(filteredCandidates.map(entry => [entry.memory.id, 0]));

    const scored: ScoredMemory[] = [];
    for (const { memory, hops } of filteredCandidates) {
      const queryScore = queryScores.get(memory.id) ?? 0;
      const contextScore = contextScores.get(memory.id) ?? 0;
      const semanticScore = hasContext
        ? (queryScore * 0.75) + (contextScore * 0.25)
        : queryScore;
      // Proximity bonus is 1/hops so direct neighbours (hops=1) score 1.0 and
      // two-hop neighbours score 0.5. This is added to the *normalized* semantic
      // score (0–1) derived from BM25, and then the combined scores are
      // normalised again to 0–1 to balance graph proximity against relevance.
      const proximityBonus = 1 / hops;
      scored.push({ memory, score: semanticScore + proximityBonus });
    }

    // Normalise
    const maxScore = scored.reduce((mx, s) => Math.max(mx, s.score), 0);
    if (maxScore > 0) {
      for (const s of scored) s.score = s.score / maxScore;
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  // ── Listing & Stats ────────────────────────────────────────────────────────

  listMemories(
    page = 1,
    page_size = 20,
    district?: string,
    archetype?: string,
    project_id?: string,
    epistemic_statuses?: EpistemicStatusFilter[],
  ): { memories: MemoryNPC[]; total: number; page: number; page_size: number; total_pages: number } {
    let all = Object.values(this.memories);
    if (district) all = all.filter(m => m.district === district);
    if (archetype) all = all.filter(m => m.archetype === archetype);
    if (project_id) all = all.filter(m => m.project_id === project_id);
    if (epistemic_statuses && epistemic_statuses.length > 0) {
      all = all.filter(m => {
        const status = m.epistemic_status ?? "unset";
        return epistemic_statuses.includes(status);
      });
    }

    all.sort((a, b) => b.created.getTime() - a.created.getTime());

    const total = all.length;
    const total_pages = Math.max(1, Math.ceil(total / page_size));
    const start = (page - 1) * page_size;
    const memories = all.slice(start, start + page_size);

    return { memories, total, page, page_size, total_pages };
  }

  memoryStats(project_id?: string): object {
    const allMems = project_id
      ? Object.values(this.memories).filter(m => m.project_id === project_id)
      : Object.values(this.memories);
    const totalMemories = allMems.length;
    const perAgent: { [key: string]: number } = {};
    const perProject: { [key: string]: number } = {};

    const perDistrict: { [key: string]: number } = {};
    const epistemicStatusBreakdown: { [key: string]: number } = {
      draft: 0,
      validated: 0,
      outdated: 0,
      unset: 0,
    };
    for (const key of Object.keys(this.districts)) perDistrict[key] = 0;
    for (const m of allMems) perDistrict[m.district] = (perDistrict[m.district] ?? 0) + 1;
    for (const m of allMems) {
      const agentKey = m.agent_id ?? "unassigned";
      const projectKey = m.project_id ?? "(unset)";
      perAgent[agentKey] = (perAgent[agentKey] ?? 0) + 1;
      perProject[projectKey] = (perProject[projectKey] ?? 0) + 1;
      const rawStatus = m.epistemic_status ?? "unset";
      const statusKey: EpistemicStatusFilter =
        (VALID_EPISTEMIC_STATUSES as string[]).includes(rawStatus) ? (rawStatus as EpistemicStatusFilter) : "unset";
      epistemicStatusBreakdown[statusKey] = (epistemicStatusBreakdown[statusKey] ?? 0) + 1;
    }

    // Count undirected edges where both endpoints are inside the current scope.
    // This avoids inflating scoped totals with cross-project links.
    const scopedIds = new Set(allMems.map(m => m.id));
    const totalConnections = Math.round(
      allMems.reduce(
        (sum, m) => sum + m.connections.filter(connectionId => scopedIds.has(connectionId)).length,
        0,
      ) / 2,
    );

    const mostAccessed = [...allMems]
      .sort((a, b) => b.access_count - a.access_count)
      .slice(0, 5)
      .map(m => ({ id: m.id, name: m.name, access_count: m.access_count }));

    const orphans = allMems
      .filter(m => m.connections.filter(connectionId => scopedIds.has(connectionId)).length === 0)
      .map(m => ({ id: m.id, name: m.name }));
    const loopTelemetrySummary: any = this.loopTelemetry.summarize(allMems);
    const loop_telemetry =
      loopTelemetrySummary && Array.isArray(loopTelemetrySummary.recent_high_similarity_writes)
        ? {
            ...loopTelemetrySummary,
            recent_high_similarity_writes: loopTelemetrySummary.recent_high_similarity_writes.filter(
              (write: any) => {
                const candidateIds = [
                  write?.memory_id,
                  write?.source_memory_id,
                  write?.target_memory_id,
                  write?.memoryId,
                  write?.sourceId,
                  write?.targetId,
                ].filter((id: unknown): id is string => typeof id === "string");
                return candidateIds.some(id => scopedIds.has(id));
              },
            ),
          }
        : loopTelemetrySummary;

    return {
      totalMemories,
      perDistrict,
      perAgent,
      perProject,
      epistemicStatusBreakdown,
      totalConnections,
      mostAccessed,
      orphans,
      loop_telemetry,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  getDistrictMemories(district: string): MemoryNPC[] {
    if (!this.districts[district]) {
      return [];
    }
    return this.districts[district].memories.map(id => this.memories[id]).filter(Boolean);
  }

  getConnectedMemories(memoryId: string): MemoryNPC[] {
    const memory = this.memories[memoryId];
    if (!memory) return [];

    return memory.connections
      .map(id => this.memories[id])
      .filter(Boolean);
  }

  private generateMemoryName(archetype: MemoryArchetype, content: string): string {
    const prefixes = {
      scholar: ["Analytical", "Logical", "Research", "Study"],
      merchant: ["Practical", "Action", "Task", "Execution"],
      mystic: ["Emotional", "Intuitive", "Creative", "Reflective"],
      guard: ["Vigilant", "Protective", "Alert", "Monitoring"]
    };

    const prefix = prefixes[archetype][Math.floor(Math.random() * prefixes[archetype].length)];
    const words = content.split(' ').slice(0, 2).join(' ');
    return `${prefix} ${words || 'Memory'}`;
  }

  private generateTraits(archetype: MemoryArchetype): string[] {
    const traitSets = {
      scholar: ["analytical", "methodical", "curious", "precise"],
      merchant: ["practical", "efficient", "organized", "goal-oriented"],
      mystic: ["intuitive", "emotional", "creative", "reflective"],
      guard: ["vigilant", "protective", "alert", "responsible"]
    };
    return traitSets[archetype].slice(0, 2);
  }

  private generateConcerns(archetype: MemoryArchetype): string[] {
    const concernSets = {
      scholar: ["accuracy", "understanding", "knowledge", "logic"],
      merchant: ["efficiency", "results", "resources", "timelines"],
      mystic: ["emotions", "connections", "meaning", "expression"],
      guard: ["safety", "risks", "boundaries", "protection"]
    };
    return concernSets[archetype].slice(0, 2);
  }

  getAllDistricts(): MemoryDistrict[] {
    return Object.values(this.districts);
  }

  getAllMemories(): MemoryNPC[] {
    return Object.values(this.memories);
  }

  /**
   * Distill an emotional memory into a structured logical artifact.
   * Translates raw emotional processing content into signals, triggers, constraints,
   * next_actions, and risk_flags that logical/planning agents can consume efficiently.
   */
  distillMemory(sourceMemoryId: string, agent_id?: string): {
    distilled: MemoryNPC;
    artifact: DistilledArtifact;
  } {
    const sourceMemory = this.memories[sourceMemoryId];
    if (!sourceMemory) {
      throw createNMError(
        NM_ERRORS.MEMORY_NOT_FOUND,
        `Memory not found: ${sourceMemoryId}`,
        "List or search memories first, then retry with a valid memory ID.",
      );
    }
    if (sourceMemory.district !== "emotional_processing") {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Memory ${sourceMemoryId} is not in emotional_processing district (it is in ${sourceMemory.district})`,
        "distill_memory only operates on emotional_processing memories.",
      );
    }

    const content = sourceMemory.content.toLowerCase();
    const originalIntensity = sourceMemory.intensity ?? 0.5;
    const distilledIntensity = Math.max(0, originalIntensity * 0.4); // Reduced intensity for logical consumption

    // Extract signals: look for patterns indicating emotional states or needs
    const signalPatterns = [
      { pattern: /shame|guilt|embarrass/i, signal: "shame_cycle_detected" },
      { pattern: /avoidanc|procrastinat|put\s*off/i, signal: "avoidance_behavior" },
      { pattern: /overwhelm|too\s*much|can't\s*(start|begin|do)/i, signal: "overwhelm_state" },
      { pattern: /perfection|perfect|just\s*right/i, signal: "perfectionism_tendency" },
      { pattern: /focus|distract|wander|drift/i, signal: "attention_fragmentation" },
      { pattern: /energy|tired|exhaust|fatigue/i, signal: "energy_depletion" },
      { pattern: /motivat|drive|want|need/i, signal: "motivation_signal" },
      { pattern: /frustrat|anger|annoy|irritat/i, signal: "frustration_state" },
      { pattern: /anxiet|worried|fear|panic/i, signal: "anxiety_signal" },
      { pattern: /creativ|insight|idea|connection/i, signal: "creative_insight" },
    ];

    const signals: string[] = signalPatterns
      .filter(({ pattern }) => pattern.test(content))
      .map(({ signal }) => signal);

    if (signals.length === 0) {
      signals.push("unclassified_emotional_state");
    }

    // Extract triggers: conditions that may have caused the emotional state
    const triggerPatterns = [
      { pattern: /deadline|due|time\s*press|urgent/i, trigger: "time_pressure" },
      { pattern: /complex|hard|difficult|confusing/i, trigger: "task_complexity" },
      { pattern: /interrup|noise|distraction|environment/i, trigger: "environmental_disruption" },
      { pattern: /expect|pressure|demand|require/i, trigger: "external_expectation" },
      { pattern: /unclear|unknown|unsure|ambiguous/i, trigger: "ambiguity" },
      { pattern: /transit|switch|context.?switch|multi.?task/i, trigger: "context_switching" },
      { pattern: /social|people|meeting|group/i, trigger: "social_demand" },
      { pattern: /novel|new|unfamiliar|unknown/i, trigger: "novelty" },
    ];

    const triggers: string[] = triggerPatterns
      .filter(({ pattern }) => pattern.test(content))
      .map(({ trigger }) => trigger);

    if (triggers.length === 0) {
      triggers.push("unspecified_trigger");
    }

    // Extract constraints: limitations or boundaries relevant to the situation
    const constraints: string[] = [];
    if (/time|schedule|deadline/i.test(content)) constraints.push("time_bounded");
    if (/energy|fatigue|tired/i.test(content)) constraints.push("energy_limited");
    if (/attention|focus|distract/i.test(content)) constraints.push("attention_fragmented");
    if (/resource|budget|money/i.test(content)) constraints.push("resource_limited");
    if (/support|help|alone/i.test(content)) constraints.push("support_dependent");
    if (/deadline|must|need.*by/i.test(content)) constraints.push("time_sensitive");
    if (constraints.length === 0) constraints.push("no_explicit_constraints");

    // Extract next actions: actionable recommendations
    const actionPatterns = [
      { pattern: /break.*down|slice|chunk|split/i, action: "decompose_task" },
      { pattern: /time.?box|timer|pomodoro|minute/i, action: "apply_timeboxing" },
      { pattern: /rest|break|pause|stop/i, action: "schedule_rest" },
      { pattern: /write|note|document|record/i, action: "externalize_thought" },
      { pattern: /ask|help|collaborate|support/i, action: "seek_support" },
      { pattern: /simplify|reduce|strip/i, action: "reduce_scope" },
      { pattern: /start|begin|first.*step|just.*do/i, action: "initiate_minimum_effort" },
      { pattern: /review|reflect|check|assess/i, action: "reflect_on_pattern" },
      { pattern: /connect|link|relate/i, action: "connect_related_knowledge" },
    ];

    const next_actions: string[] = actionPatterns
      .filter(({ pattern }) => pattern.test(content))
      .map(({ action }) => action);

    if (next_actions.length === 0) {
      next_actions.push("monitor_for_clarity");
    }

    // Extract risk flags: warning indicators
    const riskPatterns = [
      { pattern: /shame|cycle|rut|stuck|loop/i, risk: "negative_feedback_loop" },
      { pattern: /avoid|escape|quit|give.?up/i, risk: "task_abandonment" },
      { pattern: /perfection|all.?or.?nothing|binary/i, risk: "perfectionism_trap" },
      { pattern: /compare|others|worse|inferior/i, risk: "comparison_distortion" },
      { pattern: /catastroph|worst|always|never/i, risk: "catastrophizing" },
      { pattern: /burnout|empty|hollow|numb/i, risk: "burnout_indicator" },
      { pattern: /impulse|rash|without.?thinking/i, risk: "impulsive_decision" },
    ];

    const risk_flags: string[] = riskPatterns
      .filter(({ pattern }) => pattern.test(content))
      .map(({ risk }) => risk);

    if (/ruminate|repeat|same.?thought|spiral/i.test(content)) {
      risk_flags.push("rumination_loop");
    }

    // Build artifact
    const artifact: DistilledArtifact = {
      signals,
      triggers,
      constraints,
      next_actions,
      risk_flags,
      abstracted_from: sourceMemoryId,
    };

    // Create distilled memory in logical_analysis district
    const id = `memory_${this.nextMemoryId++}`;
    const now = new Date();
    const distilledContent = `Distilled artifact from ${sourceMemoryId}: signals=[${signals.join(", ")}], triggers=[${triggers.join(", ")}], constraints=[${constraints.join(", ")}], actions=[${next_actions.join(", ")}], risks=[${risk_flags.join(", ")}]`;

    // Compute updated connections before WAL write to preserve "append before mutate" invariant
    const updatedConnections = [...sourceMemory.connections, id];

    const distilledMemory: MemoryNPC = {
      id,
      name: `distilled_${sourceMemoryId}_${now.toISOString()}`,
      archetype: "scholar",
      agent_id,
      project_id: sourceMemory.project_id,
      district: "logical_analysis",
      content: distilledContent,
      traits: ["analytical", "structured"],
      concerns: ["clarity", "actionability"],
      connections: [sourceMemoryId],
      tags: ["topic:distillation", "scope:derived", "kind:distilled", "layer:abstraction"],
      created: now,
      last_accessed: now,
      access_count: 1,
      emotional_valence: 0, // Neutral emotional valence for logical consumption
      intensity: distilledIntensity,
      abstracted_from: sourceMemoryId,
      epistemic_status: sourceMemory.epistemic_status,
    };

    // Append WAL entries before mutating in-memory state (durability invariant)
    this.ensureCapacityForInsert();
    this.appendWalEntry("store", { memory: this.serializeMemory(distilledMemory) });
    this.appendWalEntry("update", { memory_id: sourceMemoryId, updates: { connections: updatedConnections } });
    this.insertMemory(distilledMemory);
    // Apply mutations after WAL writes
    sourceMemory.connections = updatedConnections;
    this.scheduleSave();

    logger.info(
      {
        operation: "distill",
        sourceMemoryId,
        distilledMemoryId: id,
        signalCount: signals.length,
        riskFlagCount: risk_flags.length,
      },
      "Distilled emotional memory",
    );

    return {
      distilled: distilledMemory,
      artifact,
    };
  }

  /**
   * Import multiple memories in a single WAL-backed operation.
   * Materializes entries first so the import record is appended before in-memory mutation.
   */
  importMemories(
    entries: Array<{ content: string; district: string; tags?: string[]; emotional_valence?: number; intensity?: number; agent_id?: string; project_id?: string; epistemic_status?: EpistemicStatus }> | undefined,
    default_agent_id?: string,
    options: ImportExecutionOptions = {},
  ): ImportExecutionResult {
    const plan = this.buildImportPlan(entries, default_agent_id, options);
    if (options.dry_run) {
      return {
        source: plan.source,
        requested: plan.requested,
        dry_run: true,
        imported_ids: this.successfulImportIds(plan),
        skipped: plan.skipped,
        failures: plan.failures,
      };
    }

    if (plan.failures.length > 0) {
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Import validation failed: ${this.formatImportFailures(plan.failures)}`,
        "Run import_memories with dry_run=true to inspect the deterministic failure list, then fix the reported rows before retrying.",
      );
    }

    const materialized = plan.memories.map(entry => entry.memory);
    this.appendWalEntry("import", { memories: materialized.map(mem => this.serializeMemory(mem)) });
    for (const memory of materialized) {
      this.ensureCapacityForInsert();
      this.insertMemory(memory);
    }
    this.nextMemoryId = Math.max(this.nextMemoryId, plan.nextMemoryId);
    this.scheduleSave();
    logger.info(
      {
        operation: "import",
        importedCount: materialized.length,
        skippedCount: plan.skipped.length,
        source: plan.source,
        agentId: default_agent_id ?? "unassigned",
      },
      "Imported memories",
    );
    return {
      source: plan.source,
      requested: plan.requested,
      dry_run: false,
      imported_ids: materialized.map(mem => mem.id),
      skipped: plan.skipped,
      failures: plan.failures,
    };
  }

  private materializeImportMemories(
    entries: ImportMemoryEntry[],
    default_agent_id?: string,
  ): MemoryNPC[] {
    let nextId = this.nextMemoryId;
    const memories: MemoryNPC[] = [];
    for (const entry of entries) {
      if (!this.districts[entry.district]) {
        throw createNMError(
          NM_ERRORS.UNKNOWN_DISTRICT,
          `Unknown district: ${entry.district}`,
          `Use one of the configured districts: ${Object.keys(this.districts).join(", ")}.`,
        );
      }

      const id = `memory_${nextId++}`;
      const archetype = this.districts[entry.district].archetype;
      const name = this.generateMemoryName(archetype, entry.content);
      const now = new Date();
      if (entry.project_id !== undefined) {
        validateProjectId(entry.project_id, "entries[].project_id");
      }
      const memory: MemoryNPC = {
        id,
        name,
        archetype,
        agent_id: entry.agent_id ?? default_agent_id,
        project_id: entry.project_id,
        district: entry.district,
        content: entry.content,
        traits: this.generateTraits(archetype),
        concerns: this.generateConcerns(archetype),
        connections: [],
        tags: entry.tags ?? [],
        created: now,
        last_accessed: now,
        access_count: 1,
        emotional_valence: entry.emotional_valence,
        intensity: entry.intensity ?? 0.5,
        epistemic_status: entry.epistemic_status,
      };
      memories.push(memory);
    }
    this.nextMemoryId = nextId;
    return memories;
  }
}

// Global memory system instance
const memorySystem = new NeurodivergentMemory();

const SYNTHESIS_PROMPT_INCLUDE_ALL_THRESHOLD = 60;
const SYNTHESIS_PROMPT_MAX_MEMORIES = 75;
const SYNTHESIS_PROMPT_RECENT_FRACTION = 0.6;
const SYNTHESIS_PROMPT_OLDER_FRACTION = 0.2;
const SYNTHESIS_PACKET_BASE_MAX_SLICES = 8;
const SYNTHESIS_PACKET_TARGET_SLICE_SIZE = 12;
const SYNTHESIS_PACKET_MAX_MEMORIES_PER_SLICE = 20;
const SYNTHESIS_PACKET_SUMMARY_LENGTH = 240;

const DEFAULT_WRITE_QUEUE_DEPTH = 50;
const DEFAULT_WIP_LIMIT = 1;
const writeMutex = new AsyncMutex();
const configuredWriteQueueDepth = parseIntegerEnv(
  process.env.NEURODIVERGENT_MEMORY_QUEUE_DEPTH,
  DEFAULT_WRITE_QUEUE_DEPTH,
  (value) => value > 0,
);
const configuredWipLimit = parseIntegerEnv(
  process.env.NEURODIVERGENT_MEMORY_WIP_LIMIT,
  DEFAULT_WIP_LIMIT,
  (value) => value >= 0,
);

let pendingWriteQueueDepth = 0;
let queueBackpressureActive = false;

function selectSynthesisPromptMemories(allMemories: MemoryNPC[]): {
  memories: MemoryNPC[];
  totalAvailable: number;
  selectionMode: "all" | "mixed";
} {
  const sortedByCreated = [...allMemories].sort((a, b) => b.created.getTime() - a.created.getTime());
  const totalAvailable = sortedByCreated.length;

  if (totalAvailable <= SYNTHESIS_PROMPT_INCLUDE_ALL_THRESHOLD) {
    return {
      memories: sortedByCreated,
      totalAvailable,
      selectionMode: "all",
    };
  }

  const selected = new Map<string, MemoryNPC>();
  const recentQuota = Math.max(1, Math.ceil(SYNTHESIS_PROMPT_MAX_MEMORIES * SYNTHESIS_PROMPT_RECENT_FRACTION));
  const olderQuota = Math.max(1, Math.ceil(SYNTHESIS_PROMPT_MAX_MEMORIES * SYNTHESIS_PROMPT_OLDER_FRACTION));

  for (const memory of sortedByCreated.slice(0, recentQuota)) {
    selected.set(memory.id, memory);
  }

  for (const memory of [...sortedByCreated].reverse()) {
    if (selected.size >= recentQuota + olderQuota) break;
    if (!selected.has(memory.id)) {
      selected.set(memory.id, memory);
    }
  }

  const remainingBySignal = [...sortedByCreated]
    .filter(memory => !selected.has(memory.id))
    .sort((a, b) => {
      const accessDelta = b.access_count - a.access_count;
      if (accessDelta !== 0) return accessDelta;

      const connectionDelta = b.connections.length - a.connections.length;
      if (connectionDelta !== 0) return connectionDelta;

      return b.created.getTime() - a.created.getTime();
    });

  for (const memory of remainingBySignal) {
    if (selected.size >= SYNTHESIS_PROMPT_MAX_MEMORIES) break;
    selected.set(memory.id, memory);
  }

  return {
    memories: [...selected.values()].sort((a, b) => b.created.getTime() - a.created.getTime()),
    totalAvailable,
    selectionMode: "mixed",
  };
}

function summarizeMemoryForPacket(memory: MemoryNPC): string {
  const normalized = memory.content.replace(/\s+/g, " ").trim();
  if (normalized.length <= SYNTHESIS_PACKET_SUMMARY_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, SYNTHESIS_PACKET_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

function collectTopTopics(memories: MemoryNPC[], limit = 8): string[] {
  const counts = new Map<string, number>();

  for (const memory of memories) {
    for (const tag of memory.tags) {
      if (!tag.startsWith("topic:")) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
}

function buildSynthesisPacketResources(allMemories: MemoryNPC[]): {
  manifest: {
    packet_type: string;
    total_memories: number;
    slice_count: number;
    resource_count: number;
    coverage_mode: string;
    id_range: { newest?: string; oldest?: string };
    created_range: { newest?: string; oldest?: string };
    districts: Array<{ district: string; count: number }>;
    top_topics: string[];
    slice_ids: string[];
    max_memories_per_slice: number;
  };
  resources: Array<{ type: "resource"; resource: { uri: string; mimeType: string; text: string } }>;
} {
  const sortedByCreated = [...allMemories].sort((a, b) => b.created.getTime() - a.created.getTime());
  if (sortedByCreated.length === 0) {
    return {
      manifest: {
        packet_type: "coverage_manifest",
        total_memories: 0,
        slice_count: 0,
        resource_count: 0,
        coverage_mode: "full_graph_packetized",
        id_range: {},
        created_range: {},
        districts: [],
        top_topics: [],
        slice_ids: [],
        max_memories_per_slice: SYNTHESIS_PACKET_MAX_MEMORIES_PER_SLICE,
      },
      resources: [],
    };
  }

  const preferredSliceCount = Math.min(
    SYNTHESIS_PACKET_BASE_MAX_SLICES,
    Math.max(1, Math.ceil(sortedByCreated.length / SYNTHESIS_PACKET_TARGET_SLICE_SIZE)),
  );
  const requiredSliceCount = Math.max(
    1,
    Math.ceil(sortedByCreated.length / SYNTHESIS_PACKET_MAX_MEMORIES_PER_SLICE),
  );
  const sliceCount = Math.max(preferredSliceCount, requiredSliceCount);
  const sliceSize = Math.ceil(sortedByCreated.length / sliceCount);
  const slices = Array.from({ length: sliceCount }, (_, index) =>
    sortedByCreated.slice(index * sliceSize, (index + 1) * sliceSize),
  ).filter(slice => slice.length > 0);

  const manifest = {
    packet_type: "coverage_manifest",
    total_memories: sortedByCreated.length,
    slice_count: slices.length,
    resource_count: slices.length + 1,
    coverage_mode: "full_graph_packetized",
    id_range: {
      newest: sortedByCreated[0]?.id,
      oldest: sortedByCreated[sortedByCreated.length - 1]?.id,
    },
    created_range: {
      newest: sortedByCreated[0]?.created.toISOString(),
      oldest: sortedByCreated[sortedByCreated.length - 1]?.created.toISOString(),
    },
    districts: Object.entries(
      sortedByCreated.reduce<Record<string, number>>((acc, memory) => {
        acc[memory.district] = (acc[memory.district] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([district, count]) => ({ district, count })),
    top_topics: collectTopTopics(sortedByCreated),
    slice_ids: slices.map((_, index) => `slice_${index + 1}`),
    max_memories_per_slice: SYNTHESIS_PACKET_MAX_MEMORIES_PER_SLICE,
  };

  const manifestResource = {
    type: "resource" as const,
    resource: {
      uri: "memory://packet/manifest",
      mimeType: "application/json",
      text: JSON.stringify(manifest, null, 2),
    },
  };

  const sliceResources = slices.map((slice, index) => ({
    type: "resource" as const,
    resource: {
      uri: `memory://packet/slice_${index + 1}`,
      mimeType: "application/json",
      text: JSON.stringify({
        packet_type: "memory_slice",
        slice_id: `slice_${index + 1}`,
        title: `Memory slice ${index + 1}`,
        memory_count: slice.length,
        id_range: {
          newest: slice[0]?.id,
          oldest: slice[slice.length - 1]?.id,
        },
        created_range: {
          newest: slice[0]?.created.toISOString(),
          oldest: slice[slice.length - 1]?.created.toISOString(),
        },
        districts: Object.entries(
          slice.reduce<Record<string, number>>((acc, memory) => {
            acc[memory.district] = (acc[memory.district] ?? 0) + 1;
            return acc;
          }, {}),
        )
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([district, count]) => ({ district, count })),
        top_topics: collectTopTopics(slice, 6),
        memories: slice.map(memory => ({
          id: memory.id,
          name: memory.name,
          district: memory.district,
          archetype: memory.archetype,
          tags: memory.tags,
          project_id: memory.project_id ?? null,
          access_count: memory.access_count,
          connection_count: memory.connections.length,
          created: memory.created.toISOString(),
          summary: summarizeMemoryForPacket(memory),
        })),
      }, null, 2),
    },
  }));

  return {
    manifest,
    resources: [manifestResource, ...sliceResources],
  };
}

function buildExploreMemoryCityMessages() {
  const districtSummaries = memorySystem.getAllDistricts().map(d => ({
    type: "resource" as const,
    resource: {
      uri: `memory://district/${d.name.toLowerCase().replace(/\s+/g, '_')}`,
      mimeType: "application/json",
      text: JSON.stringify(d, null, 2)
    }
  }));

  return [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Welcome to your neurodivergent memory city! Here are the districts where your thoughts reside:"
      }
    },
    ...districtSummaries.map(district => ({
      role: "user" as const,
      content: district
    })),
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Explore these districts and understand how your mind organizes different types of thoughts. What patterns do you notice?"
      }
    }
  ];
}

function buildSynthesizeMemoriesMessages() {
  const synthesisSelection = selectSynthesisPromptMemories(memorySystem.getAllMemories());
  const memoryResources = synthesisSelection.memories.map(memory => ({
    type: "resource" as const,
    resource: {
      uri: `memory://memory/${memory.id}`,
      mimeType: "application/json",
      text: JSON.stringify({
        name: memory.name,
        content: memory.content,
        archetype: memory.archetype,
        district: memory.district,
        tags: memory.tags
      }, null, 2)
    }
  }));

  return [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: synthesisSelection.selectionMode === "all"
          ? `Let's synthesize new insights from your stored memories. Here are all ${synthesisSelection.totalAvailable} currently stored memories, ordered by recency:`
          : `Let's synthesize new insights from your stored memories. Here is a broad cross-section of ${memoryResources.length} memories selected from ${synthesisSelection.totalAvailable} total memories, combining recent entries with older high-signal memories:`
      }
    },
    ...memoryResources.map(memory => ({
      role: "user" as const,
      content: memory
    })),
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Looking at these memories, what new connections or insights emerge? How do they relate to each other?"
      }
    }
  ];
}

function buildSynthesizeMemoryPacketsMessages() {
  const packetPayload = buildSynthesisPacketResources(memorySystem.getAllMemories());
  const packetResources = packetPayload.resources;

  if (packetResources.length === 0) {
    return [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "No memories are currently stored, so there are no synthesis packets to review yet."
        }
      }
    ];
  }

  return [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Let's synthesize new insights from your stored memories using packetized coverage. The attached resources include 1 coverage manifest plus ${packetPayload.manifest.slice_count} structured memory slices spanning all ${packetPayload.manifest.total_memories} stored memories.`
      }
    },
    ...packetResources.map(resource => ({
      role: "user" as const,
      content: resource,
    })),
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Use the coverage manifest to understand graph scope, then synthesize patterns across the slice packets. Prefer broad graph-level insights, but cite concrete memory ids when a specific claim depends on a particular packet entry."
      }
    }
  ];
}

function promptMessagesToToolContent(messages: Array<{ content: unknown }>) {
  return messages.map(message => message.content);
}

function listPromptDescriptors() {
  return [
    {
      name: "explore_memory_city",
      title: "Explore Memory City",
      description: "Explore the neurodivergent memory city and its districts",
      arguments: []
    },
    {
      name: "synthesize_memories",
      title: "Synthesize Memories",
      description: "Create new insights by connecting existing memories",
      arguments: []
    },
    {
      name: "synthesize_memory_packets",
      title: "Synthesize Memory Packets",
      description: "Create new insights from packetized memory slices for attachment-constrained clients",
      arguments: []
    }
  ];
}

function parseIntegerEnv(
  rawValue: string | undefined,
  fallback: number,
  validator: (value: number) => boolean,
): number {
  if (!rawValue || !rawValue.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || !validator(parsed)) {
    return fallback;
  }

  return parsed;
}

function parseBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue || !rawValue.trim()) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseNumberEnv(
  rawValue: string | undefined,
  fallback: number,
  validator: (value: number) => boolean,
): number {
  if (!rawValue || !rawValue.trim()) {
    return fallback;
  }

  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || !validator(parsed)) {
    return fallback;
  }

  return parsed;
}

function validateProjectId(projectId: string, fieldPath = "project_id"): void {
  if (typeof projectId !== "string") {
    throw createNMError(
      NM_ERRORS.INPUT_VALIDATION_FAILED,
      `Invalid ${fieldPath}: must be a string.`,
      `Provide a string value for ${fieldPath} matching ${PROJECT_ID_PATTERN.toString()}.`,
    );
  }
  // Keep an explicit length check for a clearer operator-facing error than regex mismatch.
  if (projectId.length > PROJECT_ID_MAX_LENGTH) {
    throw createNMError(
      NM_ERRORS.INPUT_VALIDATION_FAILED,
      `Invalid ${fieldPath}: maximum length is ${PROJECT_ID_MAX_LENGTH}.`,
      `Use a shorter ${fieldPath} matching ${PROJECT_ID_PATTERN.toString()}.`,
    );
  }

  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw createNMError(
      NM_ERRORS.INPUT_VALIDATION_FAILED,
      `Invalid ${fieldPath}: must match ${PROJECT_ID_PATTERN.toString()}.`,
      `Use letters/numbers and . _ : - only, starting with an alphanumeric character.`,
    );
  }
}

function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/\s*:\s*/g, ":")
    .replace(/[\s-]+/g, "_");
}

function hasTaskTag(tags: string[] = []): boolean {
  const normalizedTags = new Set(tags.map(normalizeTag));

  return (
    normalizedTags.has("kind:task") ||
    normalizedTags.has("type:task") ||
    normalizedTags.has("task")
  );
}

function resolveDefaultEpistemicStatus(
  district: string,
  tags: string[] = [],
  explicitStatus?: EpistemicStatus,
): EpistemicStatus | undefined {
  // Normalize null or non-string values so they don't bypass defaulting or store invalid data
  const normalizedStatus =
    typeof explicitStatus === "string" && (VALID_EPISTEMIC_STATUSES as string[]).includes(explicitStatus)
      ? (explicitStatus as EpistemicStatus)
      : undefined;

  if (normalizedStatus !== undefined) {
    return normalizedStatus;
  }

  return district === "practical_execution" && hasTaskTag(tags)
    ? "draft"
    : undefined;
}

function hasTaskInProgressTags(tags: string[] = []): boolean {
  const normalizedTags = new Set(tags.map(normalizeTag));

  const hasInProgressTag =
    normalizedTags.has("status:in_progress") ||
    normalizedTags.has("state:in_progress") ||
    normalizedTags.has("in_progress");

  return hasTaskTag(tags) && hasInProgressTag;
}

function findExistingInProgressTasks(agentId: string): MemoryNPC[] {
  return memorySystem
    .getAllMemories()
    .filter(memory =>
      memory.district === "practical_execution" &&
      memory.agent_id === agentId &&
      hasTaskInProgressTags(memory.tags),
    );
}

function buildWipGuardrailWarning(agentId: string, existingTasks: MemoryNPC[]): string {
  const existingPreview = existingTasks
    .slice(0, 3)
    .map(memory => `${memory.id} (${memory.name})`)
    .join(", ");

  return `⚠️ WIP guardrail: agent ${agentId} already has ${existingTasks.length} in-progress practical task(s): ${existingPreview}. Consider completing or re-triaging before adding more in-progress work.`;
}

async function runMutatingTool<T>(toolName: string, operation: () => Promise<T> | T): Promise<T> {
  if (pendingWriteQueueDepth >= configuredWriteQueueDepth) {
    throw createNMError(
      NM_ERRORS.WRITE_QUEUE_CAPACITY,
      "Write queue is at capacity. Retry after a brief delay.",
      "Wait for pending writes to drain, then retry the mutating call.",
    );
  }

  pendingWriteQueueDepth += 1;
  if (!queueBackpressureActive && pendingWriteQueueDepth >= configuredWriteQueueDepth) {
    queueBackpressureActive = true;
    logger.warn(
      {
        toolName,
        code: NM_ERRORS.WRITE_QUEUE_CAPACITY,
        queueDepth: pendingWriteQueueDepth,
        queueCapacity: configuredWriteQueueDepth,
      },
      "Write queue high-water mark reached",
    );
  }

  try {
    return await writeMutex.runExclusive(operation);
  } finally {
    pendingWriteQueueDepth = Math.max(0, pendingWriteQueueDepth - 1);
    if (queueBackpressureActive && pendingWriteQueueDepth < configuredWriteQueueDepth) {
      queueBackpressureActive = false;
      logger.warn(
        {
          toolName,
          code: NM_ERRORS.WRITE_QUEUE_CAPACITY,
          queueDepth: pendingWriteQueueDepth,
          queueCapacity: configuredWriteQueueDepth,
        },
        "Write queue high-water mark cleared",
      );
    }
  }
}

function normalizeToolError(error: unknown, fallback: McpErrorShape): McpErrorShape {
  return asMcpErrorShape(error, fallback);
}

function logToolFailure(toolName: string, error: McpErrorShape, originalError?: unknown): void {
  const logPayload: Record<string, unknown> = {
    toolName,
    code: error.code,
  };

  if (error.message) {
    logPayload.message = error.message;
  }

  if (originalError && originalError !== error) {
    if (originalError instanceof Error) {
      logPayload.originalError = {
        name: originalError.name,
        message: originalError.message,
        stack: originalError.stack,
      };
    } else {
      logPayload.originalError = originalError;
    }
  }

  logger.warn(logPayload, "Tool request failed");
}

function toolErrorResult(toolName: string, summary: string, error: unknown, fallback: McpErrorShape) {
  const normalizedError = normalizeToolError(error, fallback);
  logToolFailure(toolName, normalizedError, error);
  return mcpErrorResult(summary, normalizedError);
}

/**
 * Create an MCP server with capabilities for resources (to list/read memories),
 * tools (to manage memory graph), and prompts (for memory exploration).
 */
const server = new Server(
  {
    name: SERVER_PACKAGE_INFO.name,
    version: SERVER_PACKAGE_INFO.version,
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

/**
 * Handler for listing available memory districts and memories as resources.
 * Exposes districts and individual memories as explorable resources.
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = [];

  // Add district resources
  for (const district of memorySystem.getAllDistricts()) {
    resources.push({
      uri: `memory://district/${district.name.toLowerCase().replace(/\s+/g, '_')}`,
      mimeType: "application/json",
      name: district.name,
      description: district.description
    });
  }

  // Add individual memory resources
  for (const memory of memorySystem.getAllMemories()) {
    resources.push({
      uri: `memory://memory/${memory.id}`,
      mimeType: "application/json",
      name: memory.name,
      description: `${memory.archetype} memory: ${memory.content.substring(0, 50)}...`
    });
  }

  return { resources };
});

/**
 * Handler for reading district and memory contents.
 * Returns detailed information about districts and memories.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);

  if (url.protocol === 'memory:' && url.pathname.startsWith('/district/')) {
    const districtKey = url.pathname.replace('/district/', '').replace(/_/g, ' ');
    const districts = memorySystem.getAllDistricts();
    const district = districts.find(d => d.name.toLowerCase() === districtKey.toLowerCase());

    if (!district) {
      throw createNMError(
        NM_ERRORS.UNKNOWN_DISTRICT,
        `District not found: ${districtKey}`,
        "List resources to discover valid district URIs before retrying.",
      );
    }

    // Map district display names back to internal keys
    const districtKeyMap: { [key: string]: string } = {
      "logical analysis district": "logical_analysis",
      "emotional processing district": "emotional_processing",
      "practical execution district": "practical_execution",
      "vigilant monitoring district": "vigilant_monitoring",
      "creative synthesis district": "creative_synthesis"
    };

    const internalKey = districtKeyMap[districtKey.toLowerCase()] || districtKey;
    const memories = memorySystem.getDistrictMemories(internalKey);

    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify({
          district,
          memory_count: memories.length,
          memories: memories.map(m => ({
            id: m.id,
            name: m.name,
            archetype: m.archetype,
            tags: m.tags,
            created: m.created,
            access_count: m.access_count
          }))
        }, null, 2)
      }]
    };
  }

  if (url.protocol === 'memory:' && url.pathname.startsWith('/memory/')) {
    const memoryId = url.pathname.replace('/memory/', '');
    const retrieval = memorySystem.retrieveMemory(memoryId);
    const memory = retrieval?.memory;

    if (!memory) {
      throw createNMError(
        NM_ERRORS.MEMORY_NOT_FOUND,
        `Memory not found: ${memoryId}`,
        "List or search memories first, then retry with a valid memory URI.",
      );
    }

    const connectedMemories = memorySystem.getConnectedMemories(memoryId);

    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify({
          ...memory,
          connected_memories: connectedMemories.map(m => ({
            id: m.id,
            name: m.name,
            archetype: m.archetype,
            district: m.district
          }))
        }, null, 2)
      }]
    };
  }

  throw createNMError(
    NM_ERRORS.INPUT_VALIDATION_FAILED,
    `Invalid URI: ${request.params.uri}`,
    "Use a memory://district/... or memory://memory/... URI from list_resources.",
  );
});

/**
 * Handler that lists available memory tools.
 * Exposes tools for storing, retrieving, connecting, searching, traversing, and managing memories.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "store_memory",
        description: "Store a new memory in a specific district of the neurodivergent mind",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The memory content/thought to store"
            },
            district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "Memory district to store in"
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags for categorization"
            },
            emotional_valence: {
              type: "number",
              minimum: -1,
              maximum: 1,
              description: "Emotional charge (-1 to 1)"
            },
            intensity: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Mental energy/importance (0-1)"
            },
            agent_id: {
              type: "string",
              description: "Optional creator agent identifier"
            },
            project_id: {
              type: "string",
              description: "Optional project identifier for attribution and scoped retrieval"
            },
            epistemic_status: {
              type: "string",
              enum: ["draft", "validated", "outdated"],
              description: "Optional epistemic status for planning memories"
            }
          },
          required: ["content", "district"]
        }
      },
      {
        name: "retrieve_memory",
        description: "Retrieve a specific memory by ID",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "ID of the memory to retrieve"
            },
            district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "Optional caller district for loop telemetry attribution"
            },
            agent_id: {
              type: "string",
              description: "Optional caller agent identifier for loop telemetry attribution"
            }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "update_memory",
        description: "Update an existing memory's content, tags, district, emotional_valence, intensity, or epistemic_status",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "ID of the memory to update"
            },
            content: {
              type: "string",
              description: "New content (optional)"
            },
            district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "New district (optional)"
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "New tags (optional, replaces existing)"
            },
            emotional_valence: {
              type: "number",
              minimum: -1,
              maximum: 1,
              description: "New emotional charge (optional)"
            },
            intensity: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "New intensity (optional)"
            },
            actor_district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "Optional caller district for loop telemetry attribution"
            },
            agent_id: {
              type: "string",
              description: "Optional caller agent identifier for loop telemetry attribution"
            },
            project_id: {
              type: ["string", "null"],
              description: "New project identifier (optional); pass null to clear existing project attribution"
            },
            epistemic_status: {
              type: "string",
              enum: ["draft", "validated", "outdated"],
              description: "New epistemic status (optional)"
            }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "delete_memory",
        description: "Permanently delete a memory and remove all its connections",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "ID of the memory to delete"
            }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "connect_memories",
        description: "Create connections between memories (like neural pathways)",
        inputSchema: {
          type: "object",
          properties: {
            memory_id_1: {
              type: "string",
              description: "First memory ID"
            },
            memory_id_2: {
              type: "string",
              description: "Second memory ID"
            },
            bidirectional: {
              type: "boolean",
              description: "Whether connection goes both ways",
              default: true
            },
            agent_id: {
              type: "string",
              description: "Optional agent identifier performing the connection"
            }
          },
          required: ["memory_id_1", "memory_id_2"]
        }
      },
      {
        name: "search_memories",
        description: "Search memories using BM25 semantic ranking with optional goal-context blending, recency bias, and filters. Returns results sorted by relevance score (0-1).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query"
            },
            district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "Optional district filter"
            },
            project_id: {
              type: "string",
              description: "Optional project_id filter"
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tag filters (OR logic)"
            },
            epistemic_statuses: {
              type: "array",
              items: { type: "string", enum: ["draft", "validated", "outdated", "unset"] },
              description: "Optional epistemic status filters"
            },
            min_score: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Minimum relevance score (0-1). Only return results at or above this threshold."
            },
            context: {
              type: "string",
              description: "Optional short goal/context string blended into ranking as a lightweight BM25 boost."
            },
            recency_weight: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Optional recency boost strength from 0 (off) to 1 (strongest). Recent memories receive more weight without replacing semantic relevance."
            },
            emotional_valence_min: {
              type: "number",
              minimum: -1,
              maximum: 1,
              description: "Minimum emotional valence filter (-1 to 1)"
            },
            emotional_valence_max: {
              type: "number",
              minimum: -1,
              maximum: 1,
              description: "Maximum emotional valence filter (-1 to 1)"
            },
            intensity_min: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Minimum intensity filter (0-1). Deprecated alias for min_intensity."
            },
            intensity_max: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Maximum intensity filter (0-1). Deprecated alias for max_intensity."
            },
            min_intensity: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Minimum intensity filter (0-1). Preferred name for new callers."
            },
            max_intensity: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Maximum intensity filter (0-1). Preferred name for new callers."
            }
          },
          required: ["query"]
        }
      },
      {
        name: "traverse_from",
        description: "Walk the memory graph from a starting node up to N hops deep, returning all reachable memories",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "Starting memory ID"
            },
            depth: {
              type: "number",
              minimum: 1,
              maximum: 10,
              description: "Maximum hops to traverse (default 2)"
            },
            district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "Optional district filter for results"
            }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "related_to",
        description: "Find memories related to a given memory ID, ranked by graph proximity + BM25 semantic score with optional goal-context blending.",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "Source memory ID"
            },
            query: {
              type: "string",
              description: "Optional extra query to bias semantic ranking. If omitted, the source memory content is used."
            },
            context: {
              type: "string",
              description: "Optional short goal/context string blended into ranking as a lightweight BM25 boost."
            },
            epistemic_statuses: {
              type: "array",
              items: { type: "string", enum: ["draft", "validated", "outdated", "unset"] },
              description: "Optional epistemic status filters for related memories"
            }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "list_memories",
        description: "List stored memories with optional pagination and filters",
        inputSchema: {
          type: "object",
          properties: {
            page: {
              type: "number",
              minimum: 1,
              description: "Page number (default 1)"
            },
            page_size: {
              type: "number",
              minimum: 1,
              maximum: 100,
              description: "Results per page (default 20)"
            },
            district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "Optional district filter"
            },
            archetype: {
              type: "string",
              enum: ["scholar", "merchant", "mystic", "guard"],
              description: "Optional archetype filter"
            },
            project_id: {
              type: "string",
              description: "Optional project_id filter"
            },
            epistemic_statuses: {
              type: "array",
              items: { type: "string", enum: ["draft", "validated", "outdated", "unset"] },
              description: "Optional epistemic status filters"
            }
          }
        }
      },
      {
        name: "memory_stats",
        description: "Return aggregate statistics: total count, per-district counts, connection count, most-accessed nodes, and orphan nodes",
        inputSchema: {
          type: "object",
          properties: {
            project_id: {
              type: "string",
              description: "Optional project_id scope for filtered stats"
            }
          }
        }
      },
      {
        name: "storage_diagnostics",
        description: "Show the resolved snapshot path, WAL path, and the effective environment/config source used for persistence.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "server_handshake",
        description: "Return runtime server identity and version details so clients can confirm the active build.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "import_memories",
        description: "Bulk-import memories from inline entries or from a snapshot file. Supports dry-run validation, dedupe policies, and explicit snapshot migration flags.",
        inputSchema: {
          type: "object",
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  district: {
                    type: "string",
                    enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"]
                  },
                  tags: { type: "array", items: { type: "string" } },
                  emotional_valence: { type: "number", minimum: -1, maximum: 1 },
                  intensity: { type: "number", minimum: 0, maximum: 1 },
                  agent_id: { type: "string" },
                  project_id: { type: "string" },
                  epistemic_status: { type: "string", enum: ["draft", "validated", "outdated"] }
                },
                required: ["content", "district"]
              },
              description: "Array of memory entries to import"
            },
            file_path: {
              type: "string",
              description: "Optional path to a server snapshot JSON file to import instead of inline entries"
            },
            dry_run: {
              type: "boolean",
              description: "Validate the import and return would_import / would_skip / would_fail counts without writing any data"
            },
            dedupe: {
              type: "string",
              enum: ["none", "content_hash", "content_plus_tags"],
              description: "Optional dedupe policy: none, content_hash, or content_plus_tags"
            },
            preserve_ids: {
              type: "boolean",
              description: "Snapshot-import only. Preserve source memory IDs; conflicting IDs are rejected deterministically"
            },
            merge_connections: {
              type: "boolean",
              description: "Snapshot-import only. Merge the imported connection graph after validating all referenced IDs"
            },
            agent_id: {
              type: "string",
              description: "Optional default agent identifier applied to entries without agent_id"
            }
          },
          anyOf: [
            { required: ["entries"] },
            { required: ["file_path"] }
          ]
        }
      },
      {
        name: "distill_memory",
        description: "Translate an emotional_processing memory into a structured logical artifact (signals, triggers, constraints, next_actions, risk_flags). Creates a distilled memory in logical_analysis district with reduced intensity and neutral valence for efficient consumption by planning agents. Only operates on emotional_processing memories.",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "ID of the emotional_processing memory to distill"
            },
            agent_id: {
              type: "string",
              description: "Optional agent identifier for the distilled memory"
            }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "prepare_memory_city_context",
        description: "Return the same exploration context exposed by the explore_memory_city prompt, packaged as a tool result for clients that support tools but not MCP prompts.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "prepare_synthesis_context",
        description: "Return the same context exposed by the synthesize_memories prompt, packaged as a tool result for prompt-limited clients.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "prepare_packetized_synthesis_context",
        description: "Return the same context exposed by the synthesize_memory_packets prompt, packaged as a tool result for prompt-limited or attachment-constrained clients.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "register_district",
        description: "Register a custom district with LUCA ancestry validation. Custom districts must declare a valid parent that traces back to one of the 5 canonical districts (logical_analysis, emotional_processing, practical_execution, vigilant_monitoring, creative_synthesis). The custom district inherits its archetype from the canonical ancestor.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Snake_case district identifier (e.g. project_build_pipeline)"
            },
            name: {
              type: "string",
              description: "Human-readable district name"
            },
            description: {
              type: "string",
              description: "District description explaining its purpose"
            },
            luca_parent: {
              type: "string",
              description: "Parent district key. Must be an existing district that traces back to a canonical district."
            },
            activities: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of activities for this district. Inherits parent activities if omitted."
            }
          },
          required: ["key", "name", "description", "luca_parent"]
        }
      }
    ]
  };
});

/**
 * Handler for memory tools.
 * Implements storing, retrieving, connecting, searching, traversing, and managing memories.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "store_memory": {
      const { content, district, tags = [], emotional_valence, intensity = 0.5, agent_id, project_id, epistemic_status } = request.params.arguments as any;

      try {
        const shouldCheckWipLimit =
          configuredWipLimit > 0 &&
          district === "practical_execution" &&
          typeof agent_id === "string" &&
          hasTaskInProgressTags(tags);

        let wipWarning: string | undefined;

        const storeResult = await runMutatingTool(
          "store_memory",
          () => {
            if (shouldCheckWipLimit) {
              const existingInProgressTasks = findExistingInProgressTasks(agent_id);
              if (existingInProgressTasks.length >= configuredWipLimit) {
                wipWarning = buildWipGuardrailWarning(agent_id, existingInProgressTasks);
                logger.warn(
                  {
                    toolName: "store_memory",
                    code: NM_ERRORS.WIP_LIMIT_EXCEEDED,
                    agentId: agent_id,
                    limit: configuredWipLimit,
                    currentInProgressCount: existingInProgressTasks.length,
                  },
                  "WIP guardrail warning emitted",
                );
              }
            }

            return memorySystem.storeMemory(
              content,
              district,
              tags,
              emotional_valence,
              intensity,
              agent_id,
              project_id,
              epistemic_status,
            );
          },
        );
        const memory = storeResult.memory;
        const warningLine = wipWarning ? `\n${wipWarning}` : "";
        const repeatWarningLine = storeResult.no_net_new_info_warning ? `\n${storeResult.no_net_new_info_warning}` : "";
        const cooldownLine = storeResult.cooldown_duration_ms
          ? `\n${memorySystem.buildCrossDistrictCooldownWarning(storeResult.matched_memory_id ?? memory.id, storeResult.cooldown_duration_ms)}`
          : "";
        const repeatLines = [
          `repeat_detected: ${storeResult.repeat_detected ? "true" : "false"}`,
          storeResult.matched_memory_id ? `matched_memory_id: ${storeResult.matched_memory_id}` : undefined,
          storeResult.similarity_score !== undefined ? `similarity_score: ${storeResult.similarity_score.toFixed(3)}` : undefined,
          storeResult.ping_pong_detected ? `ping_pong_detected: true (transition_count=${storeResult.ping_pong_count ?? 0})` : undefined,
        ].filter(Boolean).join("\n");
        return {
          content: [{
            type: "text",
            text: `🧠 Stored memory "${memory.name}" in ${memorySystem.getAllDistricts().find(d => d.name.toLowerCase().replace(/\s+/g, '_') === district)?.name || district}\nID: ${memory.id}\nArchetype: ${memory.archetype}\nAgent: ${memory.agent_id ?? "unassigned"}\nProject: ${memory.project_id ?? "unset"}\nEpistemic status: ${memory.epistemic_status ?? "unset"}\n${repeatLines}${warningLine}${repeatWarningLine}${cooldownLine}`
          }]
        };
      } catch (error) {
        return toolErrorResult(
          "store_memory",
          "Failed to store memory",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Store memory request was invalid.",
            "Verify required arguments and retry the store_memory call.",
          ),
        );
      }
    }

    case "retrieve_memory": {
      const { memory_id, district, agent_id } = request.params.arguments as any;
      const retrieval = memorySystem.retrieveMemory(memory_id, { district, agent_id });
      const memory = retrieval?.memory;

      if (!memory) {
        return toolErrorResult(
          "retrieve_memory",
          "Failed to retrieve memory",
          createNMError(
            NM_ERRORS.MEMORY_NOT_FOUND,
            `Memory not found: ${memory_id}`,
            "List or search memories first, then retry with a valid memory ID.",
          ),
          formatMcpError(
            NM_ERRORS.MEMORY_NOT_FOUND,
            `Memory not found: ${memory_id}`,
            "List or search memories first, then retry with a valid memory ID.",
          ),
        );
      }

      return {
        content: [{
          type: "text",
          text: `🧠 Retrieved memory "${memory.name}"\nDistrict: ${memory.district}\nAgent: ${memory.agent_id ?? 'unassigned'}\nProject: ${memory.project_id ?? 'unset'}\nEpistemic status: ${memory.epistemic_status ?? 'unset'}\nContent: ${memory.content}\nTags: ${memory.tags.join(', ')}\nEmotional valence: ${memory.emotional_valence ?? 'unset'}\nIntensity: ${memory.intensity ?? 'unset'}\nAccess count: ${memory.access_count}${retrieval?.distill_suggestion ? `\n${retrieval.distill_suggestion}` : ''}`
        }]
      };
    }

    case "update_memory": {
      const { memory_id, content, district, tags, emotional_valence, intensity, epistemic_status, project_id, actor_district, agent_id } = request.params.arguments as any;
      try {
        const updates: MemoryUpdatePayload = {};
        if (content !== undefined) updates.content = content;
        if (district !== undefined) updates.district = district;
        if (tags !== undefined) updates.tags = tags;
        if (emotional_valence !== undefined) updates.emotional_valence = emotional_valence;
        if (intensity !== undefined) updates.intensity = intensity;
        if (epistemic_status !== undefined) updates.epistemic_status = epistemic_status;
        if (project_id !== undefined) updates.project_id = project_id;

        const updateResult = await runMutatingTool(
          "update_memory",
          () => memorySystem.updateMemory(memory_id, updates, { district: actor_district, agent_id }),
        );
        const memory = updateResult.memory;
        const cooldownLine = updateResult.cooldown_duration_ms
          ? `\n${memorySystem.buildCrossDistrictCooldownWarning(memory_id, updateResult.cooldown_duration_ms)}`
          : "";
        return {
          content: [{
            type: "text",
            text: `✏️ Updated memory "${memory.name}" (${memory_id})\nDistrict: ${memory.district}\nProject: ${memory.project_id ?? 'unset'}\nEpistemic status: ${memory.epistemic_status ?? 'unset'}\nTags: ${memory.tags.join(', ')}${cooldownLine}`
          }]
        };
      } catch (error) {
        return toolErrorResult(
          "update_memory",
          "Failed to update memory",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Update memory request was invalid.",
            "Verify the memory ID and supplied fields, then retry update_memory.",
          ),
        );
      }
    }

    case "delete_memory": {
      const { memory_id } = request.params.arguments as any;
      try {
        await runMutatingTool("delete_memory", () => memorySystem.deleteMemory(memory_id));
        return {
          content: [{ type: "text", text: `🗑️ Deleted memory ${memory_id}` }]
        };
      } catch (error) {
        return toolErrorResult(
          "delete_memory",
          "Failed to delete memory",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Delete memory request was invalid.",
            "Verify the memory ID and retry delete_memory.",
          ),
        );
      }
    }

    case "connect_memories": {
      const { memory_id_1, memory_id_2, bidirectional = true, agent_id } = request.params.arguments as any;

      try {
        await runMutatingTool(
          "connect_memories",
          () => memorySystem.connectMemories(memory_id_1, memory_id_2, bidirectional, agent_id),
        );
        return {
          content: [{
            type: "text",
            text: `🔗 Connected memories ${memory_id_1} and ${memory_id_2}${bidirectional ? ' (bidirectional)' : ' (unidirectional)'}\nAgent: ${agent_id ?? 'unassigned'}`
          }]
        };
      } catch (error) {
        return toolErrorResult(
          "connect_memories",
          "Failed to connect memories",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Connect memories request was invalid.",
            "Verify both memory IDs and retry connect_memories.",
          ),
        );
      }
    }

    case "search_memories": {
      const {
        query, district, project_id, tags, epistemic_statuses,
        min_score,
        context, recency_weight,
        emotional_valence_min, emotional_valence_max,
        intensity_min, intensity_max,
        min_intensity, max_intensity,
      } = request.params.arguments as any;
      try {
        if (project_id !== undefined) {
          validateProjectId(project_id);
        }

        const resolvedIntensityMin = min_intensity ?? intensity_min;
        const resolvedIntensityMax = max_intensity ?? intensity_max;

        const results = memorySystem.searchMemories(
          query, district, project_id, tags, epistemic_statuses,
          min_score,
          emotional_valence_min, emotional_valence_max,
          resolvedIntensityMin, resolvedIntensityMax,
          context, recency_weight,
        );

        if (results.length === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No memories found matching query: "${query}"`
            }]
          };
        }

        const resultText = results.map(({ memory, score }) =>
          `• [${score.toFixed(3)}] ${memory.id} — ${memory.name} (${memory.archetype})\n  ${memory.content.substring(0, 80)}${memory.content.length > 80 ? '…' : ''}`
        ).join('\n');

        return {
          content: [{
            type: "text",
            text: `🔍 Found ${results.length} memories (ranked by BM25 relevance):\n${resultText}`
          }]
        };
      } catch (error) {
        return toolErrorResult(
          "search_memories",
          "Search failed",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Search request was invalid.",
            "Verify query and filter arguments, then retry search_memories.",
          ),
        );
      }
    }

    case "traverse_from": {
      const { memory_id, depth = 2, district } = request.params.arguments as any;
      try {
        const results = memorySystem.traverseFrom(memory_id, depth, district);
        if (results.length === 0) {
          return { content: [{ type: "text", text: `🕸️ No connected memories found within ${depth} hop(s) from ${memory_id}` }] };
        }
        const text = results.map(m =>
          `• ${m.id} — ${m.name} (${m.district})\n  ${m.content.substring(0, 80)}${m.content.length > 80 ? '…' : ''}`
        ).join('\n');
        return { content: [{ type: "text", text: `🕸️ Traversal from ${memory_id} (depth ${depth}) — ${results.length} results:\n${text}` }] };
      } catch (error) {
        return toolErrorResult(
          "traverse_from",
          "Traversal failed",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Traversal request was invalid.",
            "Verify the memory ID and traversal depth, then retry traverse_from.",
          ),
        );
      }
    }

    case "related_to": {
      const { memory_id, query, context, epistemic_statuses } = request.params.arguments as any;
      try {
        const results = memorySystem.relatedTo(memory_id, query, context, epistemic_statuses);
        if (results.length === 0) {
          return { content: [{ type: "text", text: `🔗 No related memories found for ${memory_id}` }] };
        }
        const text = results.map(({ memory, score }) =>
          `• [${score.toFixed(3)}] ${memory.id} — ${memory.name} (${memory.district})\n  ${memory.content.substring(0, 80)}${memory.content.length > 80 ? '…' : ''}`
        ).join('\n');
        return { content: [{ type: "text", text: `🔗 Related memories for ${memory_id} (${results.length} results):\n${text}` }] };
      } catch (error) {
        return toolErrorResult(
          "related_to",
          "related_to failed",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "related_to request was invalid.",
            "Verify the memory ID and retry related_to.",
          ),
        );
      }
    }

    case "list_memories": {
      const { page = 1, page_size = 20, district, archetype, project_id, epistemic_statuses } = request.params.arguments as any;
      try {
        if (project_id !== undefined) {
          validateProjectId(project_id);
        }
        const result = memorySystem.listMemories(page, page_size, district, archetype, project_id, epistemic_statuses);
        if (result.memories.length === 0) {
          return { content: [{ type: "text", text: `📋 No memories found (page ${page})` }] };
        }
        const text = result.memories.map(m =>
          `• ${m.id} — ${m.name} [${m.district}] | project: ${m.project_id ?? 'unset'} | tags: ${m.tags.join(', ') || 'none'}`
        ).join('\n');
        return {
          content: [{
            type: "text",
            text: `📋 Memories (page ${result.page}/${result.total_pages}, total ${result.total}):\n${text}`
          }]
        };
      } catch (error) {
        return toolErrorResult(
          "list_memories",
          "List memories failed",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "List memories request was invalid.",
            "Verify pagination and filter arguments, then retry list_memories.",
          ),
        );
      }
    }

    case "memory_stats": {
      const { project_id } = request.params.arguments as any;
      try {
        if (project_id !== undefined) {
          validateProjectId(project_id);
        }
        const stats = memorySystem.memoryStats(project_id) as any;
        const districtLines = Object.entries(stats.perDistrict)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        const perAgentLines = Object.entries(stats.perAgent)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        const perProjectLines = Object.entries(stats.perProject)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        const epistemicLines = Object.entries(stats.epistemicStatusBreakdown)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        const topAccessed = stats.mostAccessed
          .map((m: any) => `  ${m.id} — ${m.name} (${m.access_count} accesses)`)
          .join('\n');
        const orphanList = stats.orphans.length > 0
          ? stats.orphans.map((m: any) => `  ${m.id} — ${m.name}`).join('\n')
          : '  (none)';
        const repeatCandidates = stats.loop_telemetry?.repeat_write_candidates?.length > 0
          ? stats.loop_telemetry.repeat_write_candidates
              .map((m: any) => `  ${m.id} — ${m.name} (repeat_write_count=${m.repeat_write_count}, last_similarity=${(m.last_similarity_score ?? 0).toFixed(3)})`)
              .join("\n")
          : "  (none)";
        const pingPongCandidates = stats.loop_telemetry?.ping_pong_candidates?.length > 0
          ? stats.loop_telemetry.ping_pong_candidates
              .map((m: any) => `  ${m.id} — ${m.name} (ping_pong_counter=${m.ping_pong_counter})`)
              .join("\n")
          : "  (none)";
        const recentSimilarityWrites = stats.loop_telemetry?.recent_high_similarity_writes?.length > 0
          ? stats.loop_telemetry.recent_high_similarity_writes
              .map((entry: any) => `  ${entry.memory_id} -> ${entry.matched_memory_id} (score=${Number(entry.similarity_score).toFixed(3)}, district=${entry.district}, agent=${entry.agent_id ?? "unassigned"})`)
              .join("\n")
          : "  (none)";

        return {
          content: [{
            type: "text",
            text: `📊 Memory Stats\nScope project_id: ${project_id ?? 'all'}\nTotal memories: ${stats.totalMemories}\nTotal connections: ${stats.totalConnections}\n\nPer district:\n${districtLines}\n\nPer agent:\n${perAgentLines || '  (none)'}\n\nPer project:\n${perProjectLines || '  (none)'}\n\nEpistemic status:\n${epistemicLines || '  (none)'}\n\nMost accessed:\n${topAccessed}\n\nOrphans (no connections):\n${orphanList}\n\nLoop telemetry:\nrepeat_write_candidates:\n${repeatCandidates}\nping_pong_candidates:\n${pingPongCandidates}\nrecent_high_similarity_writes:\n${recentSimilarityWrites}`
          }]
        };
      } catch (error) {
        return toolErrorResult(
          "memory_stats",
          "Memory stats failed",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Memory stats request was invalid.",
            "Verify optional filters and retry memory_stats.",
          ),
        );
      }
    }

    case "storage_diagnostics": {
      try {
        const diagnostics = memorySystem.storageDiagnostics();
        return {
          content: [{
            type: "text",
            text: `📦 Storage Diagnostics\nSnapshot path: ${diagnostics.snapshot_path}\nWAL path: ${diagnostics.wal_path}\nResolved source: ${diagnostics.resolved_source}`,
          }],
        };
      } catch (error) {
        return toolErrorResult(
          "storage_diagnostics",
          "Storage diagnostics failed",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Unable to resolve storage diagnostics.",
            "Retry storage_diagnostics; if the problem persists, inspect server startup configuration.",
          ),
        );
      }
    }

    case "server_handshake": {
      return {
        content: [{
          type: "text",
          text: [
            "🤝 Server Handshake",
            `Name: ${SERVER_PACKAGE_INFO.name}`,
            `Version: ${SERVER_PACKAGE_INFO.version}`,
            `Started: ${SERVER_START_TIME_ISO}`,
            `PID: ${process.pid}`,
            `Node.js: ${process.version}`,
            "Transport: stdio",
          ].join("\n"),
        }],
      };
    }

    case "import_memories": {
      const { entries, file_path, dry_run = false, dedupe = "none", preserve_ids = false, merge_connections = false, agent_id } = request.params.arguments as any;
      try {
        const executeImport = () => memorySystem.importMemories(entries, agent_id, {
          file_path,
          dry_run,
          dedupe,
          preserve_ids,
          merge_connections,
        });
        const result = dry_run
          ? executeImport()
          : await runMutatingTool("import_memories", executeImport);

        const skipLines = result.skipped.length > 0
          ? result.skipped.map(skip => `  entry ${skip.index}${skip.source_memory_id ? ` (${skip.source_memory_id})` : ""}: ${skip.reason_code} - ${skip.detail}`).join("\n")
          : "  (none)";
        const failureLines = result.failures.length > 0
          ? result.failures.map(failure => `  entry ${failure.index}${failure.source_memory_id ? ` (${failure.source_memory_id})` : ""}: ${failure.reason_code} - ${failure.detail}`).join("\n")
          : "  (none)";

        return {
          content: [{
            type: "text",
            text: dry_run
              ? `📥 Import Dry Run\nSource: ${result.source}\nRequested rows: ${result.requested}\nWould import: ${result.imported_ids.length}\nWould skip: ${result.skipped.length}\nWould fail: ${result.failures.length}\n\nSkipped rows:\n${skipLines}\n\nFailed rows:\n${failureLines}`
              : `📥 Imported ${result.imported_ids.length} memories from ${result.source}: ${result.imported_ids.join(', ') || '(none)'}\nRequested rows: ${result.requested}\nSkipped rows: ${result.skipped.length}\nFailed rows: ${result.failures.length}\n\nSkipped rows:\n${skipLines}`
          }]
        };
      } catch (error) {
        return toolErrorResult(
          "import_memories",
          "Import failed",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Import request was invalid.",
            "Verify each entry includes valid required fields, then retry import_memories.",
          ),
        );
      }
    }

    case "distill_memory": {
      const { memory_id, agent_id } = request.params.arguments as any;
      try {
        const result = await runMutatingTool(
          "distill_memory",
          () => memorySystem.distillMemory(memory_id, agent_id),
        );
        const artifact = result.artifact;
        const distilled = result.distilled;
        const artifactText = [
          `signals: ${artifact.signals.length > 0 ? artifact.signals.join(", ") : "(none)"}`,
          `triggers: ${artifact.triggers.length > 0 ? artifact.triggers.join(", ") : "(none)"}`,
          `constraints: ${artifact.constraints.length > 0 ? artifact.constraints.join(", ") : "(none)"}`,
          `next_actions: ${artifact.next_actions.length > 0 ? artifact.next_actions.join(", ") : "(none)"}`,
          `risk_flags: ${artifact.risk_flags.length > 0 ? artifact.risk_flags.join(", ") : "(none)"}`,
        ].join("\n");

        return {
          content: [{
            type: "text",
            text: `🔬 Distilled memory ${memory_id}\nCreated distilled memory: ${distilled.id}\nDistrict: ${distilled.district}\nIntensity: ${(distilled.intensity ?? 0).toFixed(2)} (reduced from source)\nValence: 0 (neutral)\n\nArtifact:\n${artifactText}`
          }]
        };
      } catch (error) {
        return toolErrorResult(
          "distill_memory",
          "Distillation failed",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Distillation request was invalid.",
            "Verify the memory ID is a valid emotional_processing memory, then retry distill_memory.",
          ),
        );
      }
    }

    case "prepare_memory_city_context": {
      const messages = buildExploreMemoryCityMessages();
      return {
        content: promptMessagesToToolContent(messages)
      };
    }

    case "prepare_synthesis_context": {
      const messages = buildSynthesizeMemoriesMessages();
      return {
        content: promptMessagesToToolContent(messages)
      };
    }

    case "prepare_packetized_synthesis_context": {
      const messages = buildSynthesizeMemoryPacketsMessages();
      return {
        content: promptMessagesToToolContent(messages)
      };
    }

    case "register_district": {
      const { key, name, description, luca_parent, activities } = request.params.arguments as any;
      try {
        const district = memorySystem.registerDistrict(
          key,
          name,
          description,
          luca_parent,
          activities ?? [],
        );
        const ancestorChain = memorySystem.getDistrictAncestryChain(luca_parent);

        return {
          content: [{
            type: "text",
            text: `🏛️ Registered custom district "${district.name}" (key: ${key})\nDescription: ${district.description}\nArchetype: ${district.archetype} (inherited from LUCA ancestor)\nLUCA ancestry: ${key} → ${ancestorChain.join(" → ")}\nActivities: ${district.activities.join(", ") || "(inherited)"}`,
          }],
        };
      } catch (error) {
        return toolErrorResult(
          "register_district",
          "Failed to register district",
          error,
          formatMcpError(
            NM_ERRORS.INPUT_VALIDATION_FAILED,
            "Register district request was invalid.",
            "Verify key (snake_case), name, description, and luca_parent, then retry register_district.",
          ),
        );
      }
    }

    default:
      return toolErrorResult(
        String(request.params.name),
        "Unknown tool",
        createNMError(
          NM_ERRORS.UNKNOWN_TOOL,
          `Unknown tool: ${request.params.name}`,
          "Call list_tools to discover supported tool names before retrying.",
        ),
        formatMcpError(
          NM_ERRORS.UNKNOWN_TOOL,
          `Unknown tool: ${request.params.name}`,
          "Call list_tools to discover supported tool names before retrying.",
        ),
      );
  }
});

/**
 * Handler that lists available prompts.
 * Exposes prompts for memory exploration and synthesis.
 */
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: listPromptDescriptors()
  };
});

/**
 * Handler for memory exploration prompts.
 */
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  switch (request.params.name) {
    case "explore_memory_city": {
      return {
        title: "Explore Memory City",
        description: "Explore the neurodivergent memory city and its districts",
        messages: buildExploreMemoryCityMessages()
      };
    }

    case "synthesize_memories": {
      return {
        title: "Synthesize Memories",
        description: "Create new insights by connecting existing memories",
        messages: buildSynthesizeMemoriesMessages()
      };
    }

    case "synthesize_memory_packets": {
      return {
        title: "Synthesize Memory Packets",
        description: "Create new insights from packetized memory slices for attachment-constrained clients",
        messages: buildSynthesizeMemoryPacketsMessages()
      };
    }

    default:
      throw createNMError(
        NM_ERRORS.INPUT_VALIDATION_FAILED,
        `Unknown prompt: ${request.params.name}`,
        "Call list_prompts to discover supported prompt names before retrying.",
      );
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.fatal({ err: error }, "Server failed to start");
  process.exit(1);
});
