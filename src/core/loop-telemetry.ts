import type { MemoryNPC } from "./types.js";

export interface LoopTelemetryConfig {
  operationWindowSize: number;
  pingPongThreshold: number;
  repeatThreshold: number;
}

export interface HighSimilarityWrite {
  memory_id: string;
  matched_memory_id: string;
  similarity_score: number;
  timestamp: string;
  district: string;
  agent_id?: string;
}

interface OperationEvent {
  op: "read" | "write";
  memory_id: string;
  district: string;
  agent_id?: string;
  target_district?: string;
  timestamp: string;
}

export interface LoopOperationIdentity {
  memory_id: string;
  district: string;
  agent_id?: string;
  target_district?: string;
}

export interface LoopTelemetrySummary {
  repeat_write_candidates: Array<{ id: string; name: string; repeat_write_count: number; last_similarity_score?: number }>;
  ping_pong_candidates: Array<{ id: string; name: string; ping_pong_counter: number }>;
  recent_high_similarity_writes: HighSimilarityWrite[];
}

export class LoopTelemetryTracker {
  private readonly operationWindowSize: number;
  private readonly pingPongThreshold: number;
  private readonly repeatThreshold: number;
  private readonly distillSuggestionThreshold: number;
  private readonly crossDistrictCooldownMs: number;
  private readonly operations: OperationEvent[] = [];
  private readonly highSimilarityWrites: HighSimilarityWrite[] = [];
  private readonly cooldowns = new Map<string, number>();

  constructor(config: LoopTelemetryConfig & { distillSuggestionThreshold: number; crossDistrictCooldownMs: number }) {
    this.operationWindowSize = config.operationWindowSize;
    this.pingPongThreshold = config.pingPongThreshold;
    this.repeatThreshold = config.repeatThreshold;
    this.distillSuggestionThreshold = config.distillSuggestionThreshold;
    this.crossDistrictCooldownMs = config.crossDistrictCooldownMs;
  }

  getRepeatThreshold(): number {
    return this.repeatThreshold;
  }

  recordRead(input: MemoryNPC | LoopOperationIdentity): { distillSuggested: boolean; logicalEmotionalReadCount: number } {
    const identity = this.toOperationIdentity(input);
    this.appendOperation({
      op: "read",
      memory_id: identity.memory_id,
      district: identity.district,
      agent_id: identity.agent_id,
      target_district: identity.target_district,
      timestamp: new Date().toISOString(),
    });

    const logicalEmotionalReadCount = this.countLogicalEmotionalReads(identity.memory_id);
    return {
      distillSuggested: logicalEmotionalReadCount >= this.distillSuggestionThreshold,
      logicalEmotionalReadCount,
    };
  }

  recordWrite(input: MemoryNPC | LoopOperationIdentity): {
    pingPongDetected: boolean;
    pingPongCount: number;
    cooldownActivated: boolean;
    cooldownDurationMs: number;
  } {
    const identity = this.toOperationIdentity(input);
    this.appendOperation({
      op: "write",
      memory_id: identity.memory_id,
      district: identity.district,
      agent_id: identity.agent_id,
      target_district: identity.target_district,
      timestamp: new Date().toISOString(),
    });

    const perMemory = this.operations.filter(event => event.memory_id === identity.memory_id);
    const pingPongCount = this.countReadWriteTransitions(identity.memory_id);

    // Only emit detection when the current write creates a new read->write transition
    // and that transition count reaches threshold.
    const previous = perMemory.length >= 2 ? perMemory[perMemory.length - 2] : undefined;
    const current = perMemory.length >= 1 ? perMemory[perMemory.length - 1] : undefined;
    const currentTransition =
      previous !== undefined &&
      current !== undefined &&
      previous.op === "read" &&
      current.op === "write" &&
      this.identityKey(previous) !== this.identityKey(current);
    const pingPongDetected = currentTransition && pingPongCount >= this.pingPongThreshold;

    let cooldownActivated = false;
    let cooldownDurationMs = 0;
    if (pingPongDetected && this.crossDistrictCooldownMs > 0) {
      cooldownActivated = true;
      cooldownDurationMs = this.activateCooldown(identity.memory_id);
    }

    return { pingPongDetected, pingPongCount, cooldownActivated, cooldownDurationMs };
  }

  getCooldownRemaining(memoryId: string): number {
    this.pruneCooldown(memoryId);
    const expiresAt = this.cooldowns.get(memoryId);
    if (!expiresAt) {
      return 0;
    }

    return Math.max(0, expiresAt - Date.now());
  }

  recordHighSimilarityWrite(entry: HighSimilarityWrite): void {
    this.highSimilarityWrites.push(entry);
    if (this.highSimilarityWrites.length > 5) {
      this.highSimilarityWrites.splice(0, this.highSimilarityWrites.length - 5);
    }
  }

  summarize(memories: MemoryNPC[]): LoopTelemetrySummary {
    const repeat_write_candidates = memories
      .filter(memory => (memory.repeat_write_count ?? 0) > 0)
      .sort((a, b) => (b.repeat_write_count ?? 0) - (a.repeat_write_count ?? 0))
      .slice(0, 5)
      .map(memory => ({
        id: memory.id,
        name: memory.name,
        repeat_write_count: memory.repeat_write_count ?? 0,
        last_similarity_score: memory.last_similarity_score,
      }));

    const ping_pong_candidates = memories
      .filter(memory => (memory.ping_pong_counter ?? 0) > 0)
      .sort((a, b) => (b.ping_pong_counter ?? 0) - (a.ping_pong_counter ?? 0))
      .slice(0, 5)
      .map(memory => ({
        id: memory.id,
        name: memory.name,
        ping_pong_counter: memory.ping_pong_counter ?? 0,
      }));

    return {
      repeat_write_candidates,
      ping_pong_candidates,
      recent_high_similarity_writes: [...this.highSimilarityWrites],
    };
  }

  private appendOperation(event: OperationEvent): void {
    this.pruneExpiredCooldowns();
    this.operations.push(event);
    if (this.operations.length > this.operationWindowSize) {
      this.operations.splice(0, this.operations.length - this.operationWindowSize);
    }
  }

  private countReadWriteTransitions(memoryId: string): number {
    const perMemory = this.operations.filter(event => event.memory_id === memoryId);
    let transitions = 0;

    for (let i = 1; i < perMemory.length; i += 1) {
      const previous = perMemory[i - 1];
      const current = perMemory[i];
      if (
        previous.op === "read" &&
        current.op === "write" &&
        this.identityKey(previous) !== this.identityKey(current)
      ) {
        transitions += 1;
      }
    }

    return transitions;
  }

  private countLogicalEmotionalReads(memoryId: string): number {
    return this.operations.filter(event =>
      event.op === "read" &&
      event.memory_id === memoryId &&
      event.district === "logical_analysis" &&
      event.target_district === "emotional_processing",
    ).length;
  }

  private activateCooldown(memoryId: string): number {
    this.pruneExpiredCooldowns();
    const expiresAt = Date.now() + this.crossDistrictCooldownMs;
    this.cooldowns.set(memoryId, expiresAt);
    return this.crossDistrictCooldownMs;
  }

  private pruneExpiredCooldowns(): void {
    const now = Date.now();
    for (const [memoryId, expiresAt] of this.cooldowns.entries()) {
      if (expiresAt <= now) {
        this.cooldowns.delete(memoryId);
      }
    }
  }

  private pruneCooldown(memoryId: string): void {
    const expiresAt = this.cooldowns.get(memoryId);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.cooldowns.delete(memoryId);
    }
  }

  private identityKey(event: OperationEvent): string {
    return `${event.district}::${event.agent_id ?? "unassigned"}`;
  }

  private toOperationIdentity(input: MemoryNPC | LoopOperationIdentity): LoopOperationIdentity {
    if ("id" in input) {
      return {
        memory_id: input.id,
        district: input.district,
        agent_id: input.agent_id,
        target_district: input.district,
      };
    }

    return input;
  }
}
