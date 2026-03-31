import test from "node:test";
import assert from "node:assert/strict";

import { LoopTelemetryTracker } from "../build/core/loop-telemetry.js";

function createMemory(overrides = {}) {
  return {
    id: "memory_1",
    name: "Test Memory",
    archetype: "scholar",
    district: "logical_analysis",
    content: "test content",
    traits: [],
    concerns: [],
    connections: [],
    tags: [],
    created: new Date("2026-03-31T00:00:00.000Z"),
    last_accessed: new Date("2026-03-31T00:00:00.000Z"),
    access_count: 1,
    ...overrides,
  };
}

test("ping-pong detection increments after threshold transitions", async () => {
  const tracker = new LoopTelemetryTracker({
    operationWindowSize: 20,
    pingPongThreshold: 3,
    repeatThreshold: 0.85,
  });

  const memory = createMemory({ id: "memory_42", district: "logical_analysis", agent_id: "alpha" });

  // Transition 1 (logical/alpha read -> practical/beta write)
  tracker.recordRead(memory);
  const writeMemory1 = { ...memory, district: "practical_execution", agent_id: "beta" };
  let result = tracker.recordWrite(writeMemory1);
  assert.equal(result.pingPongDetected, false);

  // Transition 2
  tracker.recordRead(memory);
  const writeMemory2 = { ...memory, district: "creative_synthesis", agent_id: "gamma" };
  result = tracker.recordWrite(writeMemory2);
  assert.equal(result.pingPongDetected, false);

  // Transition 3 reaches threshold
  tracker.recordRead(memory);
  const writeMemory3 = { ...memory, district: "vigilant_monitoring", agent_id: "delta" };
  result = tracker.recordWrite(writeMemory3);
  assert.equal(result.pingPongDetected, true);
  assert.equal(result.pingPongCount, 3);
});

test("summarize returns top candidates and last five high-similarity writes", async () => {
  const tracker = new LoopTelemetryTracker({
    operationWindowSize: 20,
    pingPongThreshold: 3,
    repeatThreshold: 0.85,
  });

  for (let i = 0; i < 7; i += 1) {
    tracker.recordHighSimilarityWrite({
      memory_id: `memory_new_${i}`,
      matched_memory_id: `memory_old_${i}`,
      similarity_score: 0.9,
      timestamp: new Date(2026, 2, 31, 0, i, 0).toISOString(),
      district: "logical_analysis",
      agent_id: "alpha",
    });
  }

  const memories = [
    createMemory({ id: "memory_a", name: "A", repeat_write_count: 6, last_similarity_score: 0.95, ping_pong_counter: 1 }),
    createMemory({ id: "memory_b", name: "B", repeat_write_count: 2, last_similarity_score: 0.87, ping_pong_counter: 4 }),
    createMemory({ id: "memory_c", name: "C", repeat_write_count: 4, last_similarity_score: 0.9, ping_pong_counter: 2 }),
  ];

  const summary = tracker.summarize(memories);

  assert.equal(summary.repeat_write_candidates.length, 3);
  assert.equal(summary.repeat_write_candidates[0].id, "memory_a");
  assert.equal(summary.ping_pong_candidates[0].id, "memory_b");
  assert.equal(summary.recent_high_similarity_writes.length, 5);
  assert.equal(summary.recent_high_similarity_writes[0].memory_id, "memory_new_2");
  assert.equal(summary.recent_high_similarity_writes[4].memory_id, "memory_new_6");
});
