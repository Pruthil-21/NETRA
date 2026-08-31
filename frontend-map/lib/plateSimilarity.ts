// Direct TS port of ml-anpr/anpr/plate_format.py's _edit_similarity /
// _containment_similarity / _plate_similarity -- same algorithm, same 0.7
// threshold, so "does this sighting match the searched plate" agrees with
// what the ML pipeline itself already considers the same vehicle. Needed
// because backend-watchlist's GET /detections does exact string matching,
// but OCR reads the same physical plate as different strings across
// cameras (O/0, I/1 confusion) -- searching the plate an officer actually
// sees on the vehicle should still find every sighting, not just the ones
// that happen to share that one exact spelling.

function editSimilarity(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0 && lb === 0) return 1;
  const dp: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return 1 - dp[la][lb] / Math.max(la, lb);
}

// Catches a truncated/partial read (a shorter string that's a near-perfect
// substring of the longer one) -- plain edit distance alone penalizes a
// length gap too harshly for that case.
function containmentSimilarity(short: string, long: string): number {
  const ls = short.length;
  const ll = long.length;
  if (ls === 0 || ls > ll) return 0;
  let best = 0;
  for (let start = 0; start <= ll - ls; start++) {
    let matches = 0;
    for (let k = 0; k < ls; k++) {
      if (short[k] === long[start + k]) matches++;
    }
    best = Math.max(best, matches / ls);
  }
  return best;
}

export function plateSimilarity(a: string, b: string): number {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return Math.max(editSimilarity(a, b), containmentSimilarity(shorter, longer));
}

export const PLATE_MATCH_THRESHOLD = 0.7;
