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

/**
 * Neurodivergent memory system
 */
class NeurodivergentMemory {
  private districts: { [key: string]: MemoryDistrict } = {};
  private memories: { [id: string]: MemoryNPC } = {};
  private nextMemoryId = 1;
  private bm25 = new BM25Index();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Promise chain that ensures saves never run concurrently
  private saveChain: Promise<void> = Promise.resolve();

  constructor() {
    this.initializeDistricts();
    this.loadFromDisk();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(PERSISTENCE_FILE)) return;
      const raw = fs.readFileSync(PERSISTENCE_FILE, "utf-8");
      const snapshot: MemorySnapshot = JSON.parse(raw);

      this.nextMemoryId = snapshot.nextMemoryId ?? 1;

      const memoriesMap = snapshot.memories ?? {};
      for (const [id, raw_mem] of Object.entries(memoriesMap)) {
        const now = new Date();
        const createdDate = new Date((raw_mem as any).created);
        const lastAccessedDate = new Date((raw_mem as any).last_accessed);
        const safeCreated =
          isNaN(createdDate.getTime()) ? now : createdDate;
        const safeLastAccessed =
          isNaN(lastAccessedDate.getTime()) ? safeCreated : lastAccessedDate;
        const mem: MemoryNPC = {
          ...raw_mem,
          created: safeCreated,
          last_accessed: safeLastAccessed,
        };
        if (!this.districts[mem.district]) {
          const valid = Object.keys(this.districts).join(", ");
          logger.warn({ memoryId: id, district: mem.district, validDistricts: valid }, "Skipping memory with unknown district during snapshot load");
          continue;
        }
        this.memories[id] = mem;
        if (!this.districts[mem.district].memories.includes(id)) {
          this.districts[mem.district].memories.push(id);
        }
        this.bm25.addDocument(id, this.documentText(mem));
      }
    } catch (err) {
      // Corrupt or missing snapshot — start fresh
      logger.warn({ err }, "Failed to load snapshot; starting with empty memory state");
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
    const persistedMemories: { [id: string]: PersistedMemoryNPC } = {};
    for (const [id, mem] of Object.entries(this.memories)) {
      persistedMemories[id] = {
        ...mem,
        created: mem.created.toISOString(),
        last_accessed: mem.last_accessed.toISOString(),
      };
    }
    const snapshot: MemorySnapshot = {
      nextMemoryId: this.nextMemoryId,
      memories: persistedMemories,
    };
    // Write to a temp file first, then rename for an atomic swap so a partial
    // write can never corrupt the live snapshot.
    const tmp = PERSISTENCE_FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
    await fs.promises.rename(tmp, PERSISTENCE_FILE);
  }

  private documentText(memory: MemoryNPC): string {
    return [memory.content, memory.name, ...memory.tags].join(" ");
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
    epistemic_status?: EpistemicStatus
  ): MemoryNPC {
    if (!this.districts[district]) {
      throw new Error(`Unknown district: ${district}`);
    }

    const archetype = this.districts[district].archetype;
    const id = `memory_${this.nextMemoryId++}`;
    const name = this.generateMemoryName(archetype, content);

    const memory: MemoryNPC = {
      id,
      name,
      archetype,
      agent_id,
      district,
      content,
      traits: this.generateTraits(archetype),
      concerns: this.generateConcerns(archetype),
      connections: [],
      tags,
      created: new Date(),
      last_accessed: new Date(),
      access_count: 1,
      emotional_valence,
      intensity,
      epistemic_status
    };

    this.memories[id] = memory;
    this.districts[district].memories.push(id);
    this.bm25.addDocument(id, this.documentText(memory));
    this.scheduleSave();

    return memory;
  }

  retrieveMemory(id: string): MemoryNPC | null {
    const memory = this.memories[id];
    if (memory) {
      memory.last_accessed = new Date();
      memory.access_count++;
      this.scheduleSave();
    }
    return memory || null;
  }

  updateMemory(id: string, updates: Partial<Pick<MemoryNPC, "content" | "tags" | "emotional_valence" | "intensity" | "district" | "epistemic_status">>): MemoryNPC {
    const memory = this.memories[id];
    if (!memory) throw new Error(`Memory not found: ${id}`);

    if (updates.district !== undefined && !this.districts[updates.district]) {
      throw new Error(`Unknown district: ${updates.district}`);
    }

    // Move district reference if district changed
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

    // Rebuild BM25 entry with updated text
    this.bm25.addDocument(id, this.documentText(memory));
    this.scheduleSave();

    return memory;
  }

  deleteMemory(id: string): void {
    const memory = this.memories[id];
    if (!memory) throw new Error(`Memory not found: ${id}`);

    // Remove from district
    this.districts[memory.district].memories = this.districts[memory.district].memories.filter(mid => mid !== id);

    // Remove all incoming connections
    for (const other of Object.values(this.memories)) {
      other.connections = other.connections.filter(cid => cid !== id);
    }

    this.bm25.removeDocument(id);
    delete this.memories[id];
    this.scheduleSave();
  }

  connectMemories(memoryId1: string, memoryId2: string, bidirectional = true, _agent_id?: string) {
    if (!this.memories[memoryId1]) throw new Error(`Memory not found: ${memoryId1}`);
    if (!this.memories[memoryId2]) throw new Error(`Memory not found: ${memoryId2}`);

    if (!this.memories[memoryId1].connections.includes(memoryId2)) {
      this.memories[memoryId1].connections.push(memoryId2);
    }

    if (bidirectional && !this.memories[memoryId2].connections.includes(memoryId1)) {
      this.memories[memoryId2].connections.push(memoryId1);
    }

    this.scheduleSave();
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  searchMemories(
    query: string,
    district?: string,
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
    if (!root) throw new Error(`Memory not found: ${memoryId}`);

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
    if (!root) throw new Error(`Memory not found: ${memoryId}`);

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

  listMemories(page = 1, page_size = 20, district?: string, archetype?: string): { memories: MemoryNPC[]; total: number; page: number; page_size: number; total_pages: number } {
    let all = Object.values(this.memories);
    if (district) all = all.filter(m => m.district === district);
    if (archetype) all = all.filter(m => m.archetype === archetype);

    all.sort((a, b) => b.created.getTime() - a.created.getTime());

    const total = all.length;
    const total_pages = Math.max(1, Math.ceil(total / page_size));
    const start = (page - 1) * page_size;
    const memories = all.slice(start, start + page_size);

    return { memories, total, page, page_size, total_pages };
  }

  memoryStats(): object {
    const allMems = Object.values(this.memories);
    const totalMemories = allMems.length;
    const perAgent: { [key: string]: number } = {};

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
      perAgent[agentKey] = (perAgent[agentKey] ?? 0) + 1;
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

    return { totalMemories, perDistrict, perAgent, epistemicStatusBreakdown, totalConnections, mostAccessed, orphans };
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
   * Each entry must have: content, district. Optional: tags, emotional_valence, intensity.
   * Returns the list of newly created memory IDs.
   */
  importMemories(entries: Array<{ content: string; district: string; tags?: string[]; emotional_valence?: number; intensity?: number; agent_id?: string; epistemic_status?: EpistemicStatus }>, default_agent_id?: string): string[] {
    const ids: string[] = [];
    for (const entry of entries) {
      const mem = this.storeMemory(
        entry.content,
        entry.district,
        entry.tags ?? [],
        entry.emotional_valence,
        entry.intensity ?? 0.5,
        entry.agent_id ?? default_agent_id,
        entry.epistemic_status
      );
      ids.push(mem.id);
    }
    return ids;
  }
}

// Global memory system instance
const memorySystem = new NeurodivergentMemory();

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
      throw new Error(`District not found: ${districtKey}`);
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
      throw new Error(`Memory not found: ${memoryId}`);
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

  throw new Error(`Invalid URI: ${request.params.uri}`);
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
            }
          }
        }
      },
      {
        name: "memory_stats",
        description: "Return aggregate statistics: total count, per-district counts, connection count, most-accessed nodes, and orphan nodes",
        inputSchema: {
          type: "object",
          properties: {}
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
      const { content, district, tags = [], emotional_valence, intensity = 0.5, agent_id, epistemic_status } = request.params.arguments as any;

      try {
        const memory = memorySystem.storeMemory(content, district, tags, emotional_valence, intensity, agent_id, epistemic_status);
        return {
          content: [{
            type: "text",
            text: `🧠 Stored memory "${memory.name}" in ${memorySystem.getAllDistricts().find(d => d.name.toLowerCase().replace(/\s+/g, '_') === district)?.name || district}\nID: ${memory.id}\nArchetype: ${memory.archetype}\nAgent: ${memory.agent_id ?? "unassigned"}\nEpistemic status: ${memory.epistemic_status ?? "unset"}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to store memory: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    }

    case "retrieve_memory": {
      const { memory_id } = request.params.arguments as any;
      const memory = memorySystem.retrieveMemory(memory_id);

      if (!memory) {
        return {
          content: [{
            type: "text",
            text: `❌ Memory not found: ${memory_id}`
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: `🧠 Retrieved memory "${memory.name}"\nDistrict: ${memory.district}\nAgent: ${memory.agent_id ?? 'unassigned'}\nEpistemic status: ${memory.epistemic_status ?? 'unset'}\nContent: ${memory.content}\nTags: ${memory.tags.join(', ')}\nEmotional valence: ${memory.emotional_valence ?? 'unset'}\nIntensity: ${memory.intensity ?? 'unset'}\nAccess count: ${memory.access_count}`
        }]
      };
    }

    case "update_memory": {
      const { memory_id, content, district, tags, emotional_valence, intensity, epistemic_status } = request.params.arguments as any;
      try {
      const updates: Partial<Pick<MemoryNPC, "content" | "tags" | "emotional_valence" | "intensity" | "district" | "epistemic_status">> = {};
        if (content !== undefined) updates.content = content;
        if (district !== undefined) updates.district = district;
        if (tags !== undefined) updates.tags = tags;
        if (emotional_valence !== undefined) updates.emotional_valence = emotional_valence;
        if (intensity !== undefined) updates.intensity = intensity;
        if (epistemic_status !== undefined) updates.epistemic_status = epistemic_status;

        const memory = memorySystem.updateMemory(memory_id, updates);
        return {
          content: [{
            type: "text",
            text: `✏️ Updated memory "${memory.name}" (${memory_id})\nDistrict: ${memory.district}\nEpistemic status: ${memory.epistemic_status ?? 'unset'}\nTags: ${memory.tags.join(', ')}`
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `❌ Failed to update memory: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }
    }

    case "delete_memory": {
      const { memory_id } = request.params.arguments as any;
      try {
        memorySystem.deleteMemory(memory_id);
        return {
          content: [{ type: "text", text: `🗑️ Deleted memory ${memory_id}` }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `❌ Failed to delete memory: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }
    }

    case "connect_memories": {
      const { memory_id_1, memory_id_2, bidirectional = true, agent_id } = request.params.arguments as any;

      try {
        memorySystem.connectMemories(memory_id_1, memory_id_2, bidirectional, agent_id);
        return {
          content: [{
            type: "text",
            text: `🔗 Connected memories ${memory_id_1} and ${memory_id_2}${bidirectional ? ' (bidirectional)' : ' (unidirectional)'}\nAgent: ${agent_id ?? 'unassigned'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to connect memories: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    }

    case "search_memories": {
      const {
        query, district, tags, epistemic_statuses,
        min_score,
        emotional_valence_min, emotional_valence_max,
        intensity_min, intensity_max
      } = request.params.arguments as any;

      const results = memorySystem.searchMemories(
        query, district, tags, epistemic_statuses,
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
        return { content: [{ type: "text", text: `❌ Traversal failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
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
        return { content: [{ type: "text", text: `❌ related_to failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "list_memories": {
      const { page = 1, page_size = 20, district, archetype } = request.params.arguments as any;
      const result = memorySystem.listMemories(page, page_size, district, archetype);
      if (result.memories.length === 0) {
        return { content: [{ type: "text", text: `📋 No memories found (page ${page})` }] };
      }
      const text = result.memories.map(m =>
        `• ${m.id} — ${m.name} [${m.district}] | tags: ${m.tags.join(', ') || 'none'}`
      ).join('\n');
      return {
        content: [{
          type: "text",
          text: `📋 Memories (page ${result.page}/${result.total_pages}, total ${result.total}):\n${text}`
        }]
      };
    }

    case "memory_stats": {
      const stats = memorySystem.memoryStats() as any;
      const districtLines = Object.entries(stats.perDistrict)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
      const perAgentLines = Object.entries(stats.perAgent)
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

      return {
        content: [{
          type: "text",
          text: `📊 Memory Stats\nTotal memories: ${stats.totalMemories}\nTotal connections: ${stats.totalConnections}\n\nPer district:\n${districtLines}\n\nPer agent:\n${perAgentLines || '  (none)'}\n\nEpistemic status:\n${epistemicLines || '  (none)'}\n\nMost accessed:\n${topAccessed}\n\nOrphans (no connections):\n${orphanList}`
        }]
      };
    }

    case "import_memories": {
      const { entries, agent_id } = request.params.arguments as any;
      try {
        const ids = memorySystem.importMemories(entries, agent_id);
        return {
          content: [{
            type: "text",
            text: `📥 Imported ${ids.length} memories: ${ids.join(', ')}`
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `❌ Import failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
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
      throw new Error(`Unknown prompt: ${request.params.name}`);
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
  console.error("Server error:", error);
  process.exit(1);
});
