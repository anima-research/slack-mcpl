/**
 * Whether a name someone gave looks like a slip for a name they meant, for a
 * refusal's "did you mean": the rule agent-framework's closest-names.ts uses
 * for the same question.
 */

/**
 * Whether `name` looks like a slip for `candidate`, ignoring case: the same;
 * a few edits apart, where a transposition counts as one edit; or, at three
 * characters or more, a part of it, which is a shortened attempt at it
 * (`text` for `textContains`). A part counts only that way round: a name that
 * holds the candidate, and is more edits from it than a slip allows, is
 * another name, usually an extra that explains it.
 */
export function isNearMiss(name: string, candidate: string): boolean {
  const a = name.toLowerCase(), b = candidate.toLowerCase();
  if (a.length >= 3 && b.includes(a)) return true;
  const limit = noiseLimit(a, b);
  return editDistance(a, b, limit) <= limit;
}

/**
 * The most edits that still read as a slip: a quarter of what follows the
 * prefix the two names share, and at least one, so a long shared prefix
 * doesn't make two different names look close.
 */
function noiseLimit(a: string, b: string): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return Math.max(1, Math.floor((Math.max(a.length, b.length) - shared) / 4));
}

/**
 * Edits between two strings: insertions, deletions, substitutions and swaps
 * of neighbours (optimal string alignment). Past `limit` the exact count
 * doesn't matter, so it answers `limit + 1` as soon as it is sure.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2]! + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    // No row's smallest entry is below the one before it, so none later can
    // come back under the limit.
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length]!;
}
