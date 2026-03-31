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
  timestamp: string;
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
  private readonly operations: OperationEvent[] = [];
  private readonly highSimilarityWrites: HighSimilarityWrite[] = [];

  constructor(config: LoopTelemetryConfig) {
    this.operationWindowSize = config.operationWindowSize;
    this.pingPongThreshold = config.pingPongThreshold;
    this.repeatThreshold = config.repeatThreshold;
  }

  getRepeatThreshold(): number {
    return this.repeatThreshold;
  }

  recordRead(memory: MemoryNPC): void {
    this.appendOperation({
      op: "read",
      memory_id: memory.id,
      district: memory.district,
      agent_id: memory.agent_id,
      timestamp: new Date().toISOString(),
    });
  }

  recordWrite(memory: MemoryNPC): { pingPongDetected: boolean; pingPongCount: number } {
    this.appendOperation({
      op: "write",
      memory_id: memory.id,
      district: memory.district,
      agent_id: memory.agent_id,
      timestamp: new Date().toISOString(),
    });

    const pingPongCount = this.countReadWriteTransitions(memory.id);
    const pingPongDetected = pingPongCount >= this.pingPongThreshold;
    return { pingPongDetected, pingPongCount };
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

  private identityKey(event: OperationEvent): string {
    return `${event.district}::${event.agent_id ?? "unassigned"}`;
  }
}
