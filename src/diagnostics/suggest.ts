/**
 * "Did you mean?" support.
 *
 * A compiler that says "unknown function 'prntln'" is technically correct and
 * practically useless, because you already know you got it wrong; what you
 * need is the name you were reaching for. So every "I have never heard of
 * this" error in the checker runs the name past the list of things it has
 * heard of, and mentions the closest one.
 */

/** Classic edit distance. Small inputs, so the obvious version is fine. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The closest candidate to `name`, or null when nothing is close enough to be
 * worth mentioning. Guessing badly is worse than saying nothing, so the bar
 * scales with the length of the word: one edit for a short name, two for a
 * longer one.
 */
export function suggest(name: string, candidates: Iterable<string>): string | null {
  const needle = name.toLowerCase();
  const budget = needle.length <= 4 ? 1 : needle.length <= 8 ? 2 : 3;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = levenshtein(needle, candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best && bestScore <= budget) return best;
  return null;
}

/** " (did you mean 'println'?)" or "", ready to stick on the end of a message. */
export function didYouMean(name: string, candidates: Iterable<string>): string {
  const hit = suggest(name, candidates);
  return hit ? ` Did you mean '${hit}'?` : "";
}
