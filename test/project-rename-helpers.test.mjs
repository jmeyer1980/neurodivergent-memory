import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectId, levenshtein, nearMissOf } from "../scripts/nd-mem-app-helpers.mjs";

test("normalizeProjectId lowercases, trims, and maps hyphens to underscores", () => {
  assert.equal(normalizeProjectId("TWG-ProgressionGraph"), "twg_progressiongraph");
  assert.equal(normalizeProjectId("  twg_progressiongraph  "), "twg_progressiongraph");
  assert.equal(normalizeProjectId("a-b-c"), "a_b_c");
  assert.equal(normalizeProjectId(""), "");
  assert.equal(normalizeProjectId(null), "");
  assert.equal(normalizeProjectId(undefined), "");
});

test("levenshtein computes edit distance", () => {
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", "abd"), 1);
  assert.equal(levenshtein("abc", ""), 3);
  assert.equal(levenshtein("", "ab"), 2);
  // the user's real-world typo: one missing character
  assert.equal(levenshtein("twg_progressiograph", "twg_progressiongraph"), 1);
});

test("nearMissOf finds close-but-not-identical project ids", () => {
  const existing = ["twg_progressiongraph", "yorkz", "warbler-cda"];
  // one missing character -> near miss
  assert.equal(nearMissOf("twg_progressiograph", existing), "twg_progressiongraph");
  // identical after normalization (distance 0) is a collision, NOT a near miss
  assert.equal(nearMissOf("TWG-ProgressionGraph", existing), null);
  // far away from everything -> null
  assert.equal(nearMissOf("completely_different", existing), null);
  // empty candidate matches nothing
  assert.equal(nearMissOf("", existing), null);
});

test("nearMissOf returns the closest candidate when several are within range", () => {
  const existing = ["projct_a", "project_ab"];
  // "project_a": distance 1 to "projct_a" (insert o), distance 1 to "project_ab" (delete b) — ties resolve to the first found
  assert.equal(nearMissOf("project_a", existing), "projct_a");
  // distance 2 still matches when it is the only candidate in range
  assert.equal(nearMissOf("project_axy", ["project_a"]), "project_a");
});
