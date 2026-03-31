import test from "node:test";
import assert from "node:assert/strict";

import { AsyncMutex } from "../build/core/async-mutex.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("runExclusive serializes overlapping operations", async () => {
  const mutex = new AsyncMutex();
  const order = [];

  const first = mutex.runExclusive(async () => {
    order.push("first:start");
    await sleep(25);
    order.push("first:end");
    return 1;
  });

  const second = mutex.runExclusive(async () => {
    order.push("second:start");
    await sleep(5);
    order.push("second:end");
    return 2;
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult, 1);
  assert.equal(secondResult, 2);
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("runExclusive releases lock after failure", async () => {
  const mutex = new AsyncMutex();

  await assert.rejects(
    mutex.runExclusive(async () => {
      await sleep(5);
      throw new Error("boom");
    }),
    /boom/,
  );

  const value = await mutex.runExclusive(() => 42);
  assert.equal(value, 42);
});
