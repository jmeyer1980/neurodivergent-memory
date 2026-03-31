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
import * as fs from "fs";
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
import type { EpistemicStatus, EpistemicStatusFilter, MemoryArchetype, MemoryNPC } from "./core/types.js";

/**
 * Memory district representing a knowledge domain
 */
interface MemoryDistrict {
  name: string;
  description: string;
  archetype: MemoryArchetype;
  activities: string[];
  memories: string[]; // Memory NPC IDs
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
}

type WalOperation = "store" | "update" | "delete" | "connect" | "import";

const PROJECT_ID_MAX_LENGTH = 64;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

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
    (value) => value >= 0 && value <= 1,
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
  private readonly loopTelemetry = new LoopTelemetryTracker({
    operationWindowSize: this.loopTelemetryWindowSize,
    pingPongThreshold: this.pingPongThreshold,
    repeatThreshold: this.repeatThreshold,
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

    if (replayResult.replayed > 0) {
      try {
        this.saveToDiskSync();
        fs.writeFileSync(this.walFile, "", "utf-8");
      } catch (err) {
        logger.error({ code: NM_ERRORS.PERSISTENCE_WRITE_FAILED, walFile: this.walFile, err }, "Failed to compact snapshot after WAL replay");
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
        const updates = (entry.payload.updates ?? {}) as Partial<Pick<MemoryNPC, "content" | "tags" | "emotional_valence" | "intensity" | "district" | "epistemic_status" | "project_id">>;
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
    return {
      nextMemoryId: this.nextMemoryId,
      memories: persistedMemories,
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

    // Find the best-scoring candidate using the raw BM25 score as a stable similarity metric.
    const best = rawScores.reduce(
      (currentBest, candidate) => (candidate.score > currentBest.score ? candidate : currentBest),
      rawScores[0],
    );

    // If even the best candidate has a non-positive score, treat this as "no repeat detected".
    if (best.score <= 0) {
      return undefined;
    }

    return {
      memory: best.memory,
      similarityScore: best.score,
    };
  }

  private applyPingPongTelemetry(memory: MemoryNPC, actor?: OperationActorContext): { detected: boolean; count: number } {
    const pingPong = this.loopTelemetry.recordWrite({
      memory_id: memory.id,
      district: actor?.district ?? memory.district,
      agent_id: actor?.agent_id ?? memory.agent_id,
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
        },
        "Ping-pong telemetry detected",
      );
      return { detected: true, count: pingPong.pingPongCount };
    }

    return { detected: false, count: pingPong.pingPongCount };
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

    if (repeatCandidate && repeatCandidate.similarityScore >= this.loopTelemetry.getRepeatThreshold()) {
      const matchedMemory = repeatCandidate.memory;
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
    }

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
      epistemic_status,
      last_similarity_score: similarityScore,
    };

    this.appendWalEntry("store", { memory: this.serializeMemory(memory) });
    this.ensureCapacityForInsert();
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
    };
  }

  retrieveMemory(id: string, actor?: OperationActorContext): MemoryNPC | null {
    const memory = this.memories[id];
    if (memory) {
      memory.last_accessed = new Date();
      memory.access_count++;
      this.loopTelemetry.recordRead({
        memory_id: memory.id,
        district: actor?.district ?? memory.district,
        agent_id: actor?.agent_id ?? memory.agent_id,
      });
      this.scheduleSave();
    }
    return memory || null;
  }

  updateMemory(
    id: string,
    updates: Partial<Pick<MemoryNPC, "content" | "tags" | "emotional_valence" | "intensity" | "district" | "epistemic_status" | "project_id">>,
    actor?: OperationActorContext,
  ): MemoryNPC {
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
    if (updates.project_id !== undefined) {
      validateProjectId(updates.project_id);
    }

    this.appendWalEntry("update", { memory_id: id, updates });
    this.applyMemoryUpdates(id, updates);
    this.applyPingPongTelemetry(this.memories[id], actor);
    this.scheduleSave();
    logger.info({ operation: "update", memoryId: id, changedFields: Object.keys(updates).sort() }, "Updated memory");

    return this.memories[id];
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
    updates: Partial<Pick<MemoryNPC, "content" | "tags" | "emotional_valence" | "intensity" | "district" | "epistemic_status" | "project_id">>,
  ): void {
    const memory = this.memories[id];
    if (!memory) return;

    if (updates.district !== undefined && updates.district !== memory.district) {
      this.districts[memory.district].memories = this.districts[memory.district].memories.filter(mid => mid !== id);
      this.districts[updates.district].memories.push(id);
      memory.district = updates.district;
    }

    if (updates.content !== undefined) memory.content = updates.content;
    if (updates.tags !== undefined) memory.tags = updates.tags;
    if (updates.emotional_valence !== undefined) memory.emotional_valence = updates.emotional_valence;
    if (updates.intensity !== undefined) memory.intensity = updates.intensity;
    if (updates.epistemic_status !== undefined) memory.epistemic_status = updates.epistemic_status;
    if (updates.project_id !== undefined) memory.project_id = updates.project_id;

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
    intensity_max?: number
  ): ScoredMemory[] {
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

    const queryTerms = this.bm25.queryTerms(query);

    const scored: ScoredMemory[] = candidates.map(m => ({
      memory: m,
      score: this.bm25.score(m.id, queryTerms),
    }));

    // Normalise scores to 0-1 range; return empty if no terms matched
    const maxScore = scored.reduce((mx, s) => Math.max(mx, s.score), 0);
    if (maxScore === 0) {
      return [];
    }
    for (const s of scored) {
      s.score = s.score / maxScore;
    }

    // Apply min_score filter after normalisation (score >= 0 naturally passes a 0 threshold)
    const threshold = min_score ?? 0;
    const filtered = scored.filter(s => s.score >= threshold);

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

  relatedTo(memoryId: string, query?: string): ScoredMemory[] {
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

    const queryTerms = query ? this.bm25.queryTerms(query) : this.bm25.queryTerms(root.content);

    const scored: ScoredMemory[] = [];
    for (const [id, hops] of hopMap.entries()) {
      const mem = this.memories[id];
      if (!mem) continue;
      const semanticScore = this.bm25.score(id, queryTerms);
      // Proximity bonus is 1/hops so direct neighbours (hops=1) score 1.0 and
      // two-hop neighbours score 0.5.  This is added to the raw BM25 score
      // before the whole result set is normalised to 0-1, which naturally
      // balances graph proximity against semantic relevance.
      const proximityBonus = 1 / hops;
      scored.push({ memory: mem, score: semanticScore + proximityBonus });
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

  listMemories(page = 1, page_size = 20, district?: string, archetype?: string, project_id?: string): { memories: MemoryNPC[]; total: number; page: number; page_size: number; total_pages: number } {
    let all = Object.values(this.memories);
    if (district) all = all.filter(m => m.district === district);
    if (archetype) all = all.filter(m => m.archetype === archetype);
    if (project_id) all = all.filter(m => m.project_id === project_id);

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
    const KNOWN_EPISTEMIC_STATUSES: EpistemicStatusFilter[] = ["draft", "validated", "outdated", "unset"];
    for (const key of Object.keys(this.districts)) perDistrict[key] = 0;
    for (const m of allMems) perDistrict[m.district] = (perDistrict[m.district] ?? 0) + 1;
    for (const m of allMems) {
      const agentKey = m.agent_id ?? "unassigned";
      const projectKey = m.project_id ?? "(unset)";
      perAgent[agentKey] = (perAgent[agentKey] ?? 0) + 1;
      perProject[projectKey] = (perProject[projectKey] ?? 0) + 1;
      const rawStatus = m.epistemic_status ?? "unset";
      const statusKey: EpistemicStatusFilter =
        (KNOWN_EPISTEMIC_STATUSES as string[]).includes(rawStatus) ? (rawStatus as EpistemicStatusFilter) : "unset";
      epistemicStatusBreakdown[statusKey] = (epistemicStatusBreakdown[statusKey] ?? 0) + 1;
    }

    // Count unique directed edges (sum of all connections arrays).
    // Bidirectional edges appear in both endpoints, so the raw sum over-counts
    // them; we divide by 2 for an approximate undirected edge count.
    const totalConnections = Math.round(allMems.reduce((sum, m) => sum + m.connections.length, 0) / 2);

    const mostAccessed = [...allMems]
      .sort((a, b) => b.access_count - a.access_count)
      .slice(0, 5)
      .map(m => ({ id: m.id, name: m.name, access_count: m.access_count }));

    const orphans = allMems.filter(m => m.connections.length === 0).map(m => ({ id: m.id, name: m.name }));
    const loop_telemetry = this.loopTelemetry.summarize(allMems);

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
   * Import memories from a structured JSON array (bootstrap/seed).
   * Each entry must have: content, district.
   * Optional per-entry fields:
   * - tags
   * - emotional_valence
   * - intensity
   * - agent_id (overrides default_agent_id when provided)
   * - project_id
   * - epistemic_status (must be a valid EpistemicStatus)
   * Returns the list of newly created memory IDs.
   */
  importMemories(entries: Array<{ content: string; district: string; tags?: string[]; emotional_valence?: number; intensity?: number; agent_id?: string; project_id?: string; epistemic_status?: EpistemicStatus }>, default_agent_id?: string): string[] {
    const materialized = this.materializeImportMemories(entries, default_agent_id);
    this.appendWalEntry("import", { memories: materialized.map(mem => this.serializeMemory(mem)) });
    for (const memory of materialized) {
      this.ensureCapacityForInsert();
      this.insertMemory(memory);
    }
    this.scheduleSave();
    logger.info({ operation: "import", importedCount: materialized.length, agentId: default_agent_id ?? "unassigned" }, "Imported memories");
    return materialized.map(mem => mem.id);
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

function hasTaskInProgressTags(tags: string[] = []): boolean {
  const normalizedTags = new Set(tags.map(normalizeTag));

  const hasTaskTag =
    normalizedTags.has("kind:task") ||
    normalizedTags.has("type:task") ||
    normalizedTags.has("task");

  const hasInProgressTag =
    normalizedTags.has("status:in_progress") ||
    normalizedTags.has("state:in_progress") ||
    normalizedTags.has("in_progress");

  return hasTaskTag && hasInProgressTag;
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
    name: "neurodivergent-memory",
    version: "0.1.0",
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
    const memory = memorySystem.retrieveMemory(memoryId);

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
              type: "string",
              description: "New project identifier (optional)"
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
        description: "Search memories using BM25 semantic ranking. Returns results sorted by relevance score (0-1).",
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
              description: "Minimum intensity filter (0-1)"
            },
            intensity_max: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Maximum intensity filter (0-1)"
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
        description: "Find memories related to a given memory ID, ranked by graph proximity + BM25 semantic score",
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
        name: "import_memories",
        description: "Bulk-import memories from a JSON array. Each entry requires content and district; tags, emotional_valence, intensity, and epistemic_status are optional.",
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
            agent_id: {
              type: "string",
              description: "Optional default agent identifier applied to entries without agent_id"
            }
          },
          required: ["entries"]
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
        const repeatLines = [
          `repeat_detected: ${storeResult.repeat_detected ? "true" : "false"}`,
          storeResult.matched_memory_id ? `matched_memory_id: ${storeResult.matched_memory_id}` : undefined,
          storeResult.similarity_score !== undefined ? `similarity_score: ${storeResult.similarity_score.toFixed(3)}` : undefined,
          storeResult.ping_pong_detected ? `ping_pong_detected: true (transition_count=${storeResult.ping_pong_count ?? 0})` : undefined,
        ].filter(Boolean).join("\n");
        return {
          content: [{
            type: "text",
            text: `🧠 Stored memory "${memory.name}" in ${memorySystem.getAllDistricts().find(d => d.name.toLowerCase().replace(/\s+/g, '_') === district)?.name || district}\nID: ${memory.id}\nArchetype: ${memory.archetype}\nAgent: ${memory.agent_id ?? "unassigned"}\nProject: ${memory.project_id ?? "unset"}\nEpistemic status: ${memory.epistemic_status ?? "unset"}\n${repeatLines}${warningLine}`
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
      const memory = memorySystem.retrieveMemory(memory_id, { district, agent_id });

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
          text: `🧠 Retrieved memory "${memory.name}"\nDistrict: ${memory.district}\nAgent: ${memory.agent_id ?? 'unassigned'}\nProject: ${memory.project_id ?? 'unset'}\nEpistemic status: ${memory.epistemic_status ?? 'unset'}\nContent: ${memory.content}\nTags: ${memory.tags.join(', ')}\nEmotional valence: ${memory.emotional_valence ?? 'unset'}\nIntensity: ${memory.intensity ?? 'unset'}\nAccess count: ${memory.access_count}`
        }]
      };
    }

    case "update_memory": {
      const { memory_id, content, district, tags, emotional_valence, intensity, epistemic_status, project_id, actor_district, agent_id } = request.params.arguments as any;
      try {
        const updates: Partial<Pick<MemoryNPC, "content" | "tags" | "emotional_valence" | "intensity" | "district" | "epistemic_status" | "project_id">> = {};
        if (content !== undefined) updates.content = content;
        if (district !== undefined) updates.district = district;
        if (tags !== undefined) updates.tags = tags;
        if (emotional_valence !== undefined) updates.emotional_valence = emotional_valence;
        if (intensity !== undefined) updates.intensity = intensity;
        if (epistemic_status !== undefined) updates.epistemic_status = epistemic_status;
        if (project_id !== undefined) updates.project_id = project_id;

        const memory = await runMutatingTool(
          "update_memory",
          () => memorySystem.updateMemory(memory_id, updates, { district: actor_district, agent_id }),
        );
        return {
          content: [{
            type: "text",
            text: `✏️ Updated memory "${memory.name}" (${memory_id})\nDistrict: ${memory.district}\nProject: ${memory.project_id ?? 'unset'}\nEpistemic status: ${memory.epistemic_status ?? 'unset'}\nTags: ${memory.tags.join(', ')}`
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
        emotional_valence_min, emotional_valence_max,
        intensity_min, intensity_max
      } = request.params.arguments as any;
      try {
        if (project_id !== undefined) {
          validateProjectId(project_id);
        }

        const results = memorySystem.searchMemories(
          query, district, project_id, tags, epistemic_statuses,
          min_score,
          emotional_valence_min, emotional_valence_max,
          intensity_min, intensity_max
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
      const { memory_id, query } = request.params.arguments as any;
      try {
        const results = memorySystem.relatedTo(memory_id, query);
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
      const { page = 1, page_size = 20, district, archetype, project_id } = request.params.arguments as any;
      try {
        if (project_id !== undefined) {
          validateProjectId(project_id);
        }
        const result = memorySystem.listMemories(page, page_size, district, archetype, project_id);
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

    case "import_memories": {
      const { entries, agent_id } = request.params.arguments as any;
      try {
        const ids = await runMutatingTool("import_memories", () => memorySystem.importMemories(entries, agent_id));
        return {
          content: [{
            type: "text",
            text: `📥 Imported ${ids.length} memories: ${ids.join(', ')}`
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
    prompts: [
      {
        name: "explore_memory_city",
        description: "Explore the neurodivergent memory city and its districts",
      },
      {
        name: "synthesize_memories",
        description: "Create new insights by connecting existing memories",
      }
    ]
  };
});

/**
 * Handler for memory exploration prompts.
 */
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  switch (request.params.name) {
    case "explore_memory_city": {
      const districts = memorySystem.getAllDistricts();
      const districtSummaries = districts.map(d => ({
        type: "resource" as const,
        resource: {
          uri: `memory://district/${d.name.toLowerCase().replace(/\s+/g, '_')}`,
          mimeType: "application/json",
          text: JSON.stringify(d, null, 2)
        }
      }));

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Welcome to your neurodivergent memory city! Here are the districts where your thoughts reside:"
            }
          },
          ...districtSummaries.map(district => ({
            role: "user" as const,
            content: district
          })),
          {
            role: "user",
            content: {
              type: "text",
              text: "Explore these districts and understand how your mind organizes different types of thoughts. What patterns do you notice?"
            }
          }
        ]
      };
    }

    case "synthesize_memories": {
      const memories = memorySystem.getAllMemories().slice(0, 10); // Limit to recent memories
      const memoryResources = memories.map(memory => ({
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

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Let's synthesize new insights from your stored memories. Here are some recent thoughts:"
            }
          },
          ...memoryResources.map(memory => ({
            role: "user" as const,
            content: memory
          })),
          {
            role: "user",
            content: {
              type: "text",
              text: "Looking at these memories, what new connections or insights emerge? How do they relate to each other?"
            }
          }
        ]
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
