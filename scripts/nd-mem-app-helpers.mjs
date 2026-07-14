// Pure helpers for the ND-Mem web app's project rename/merge flow.
// Served to the browser by the bridge at /nd-mem-app-helpers.mjs and
// imported directly by test/project-rename-helpers.test.mjs.

/** Canonical form used for project-id collision matching: lowercase, trimmed, '-' ≡ '_'. */
export function normalizeProjectId(id) {
  return String(id ?? "").trim().toLowerCase().replace(/-/g, "_");
}

/** Classic two-row Levenshtein edit distance. */
export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * The closest existing project id whose normalized form is within edit
 * distance 2 of the candidate's — excluding exact (distance 0) matches,
 * which are collisions handled separately. Returns null when nothing is close.
 */
export function nearMissOf(candidate, existingIds) {
  const norm = normalizeProjectId(candidate);
  if (!norm) return null;
  let best = null;
  let bestDist = Infinity;
  for (const id of existingIds) {
    const d = levenshtein(norm, normalizeProjectId(id));
    if (d > 0 && d <= 2 && d < bestDist) {
      best = id;
      bestDist = d;
    }
  }
  return best;
}
