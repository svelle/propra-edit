// Small fuzzy matcher for the file filter and quick open.

/** Score how well `query` matches `text` as a subsequence; null if it does not match. Higher is better. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLocaleLowerCase("de").replace(/\s+/g, "");
  if (!q) return 0;
  const s = text.toLocaleLowerCase("de");
  // contiguous substring matches rank highest
  const sub = s.indexOf(q);
  if (sub !== -1) return 1000 - sub - (s.length - q.length) * 0.1 + (sub === 0 || /[\s/_.-]/.test(s[sub - 1]) ? 200 : 0);
  let score = 0;
  let si = 0;
  let prev = -2;
  for (const ch of q) {
    const found = s.indexOf(ch, si);
    if (found === -1) return null;
    score += found === prev + 1 ? 10 : 1;
    if (prev >= 0) score -= Math.min(found - prev - 1, 10) * 0.5; // gaps between matched letters cost
    if (found === 0 || /[\s/_.-]/.test(s[found - 1])) score += 5;
    prev = found;
    si = found + 1;
  }
  return score - s.length * 0.05;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string, limit = 100): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const sc = fuzzyScore(query, key(item));
    if (sc !== null) scored.push({ item, score: sc });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.item);
}
