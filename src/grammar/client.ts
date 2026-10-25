// LanguageTool client: caches results per paragraph chunk (keyed by its exact content),
// batches uncached chunks into one request, and maps match offsets back to the chunks.

import { joinSegments, type Chunk, type Segment } from "./mask";

/** The parts of a LanguageTool match we use. */
export interface LtMatch {
  offset: number;
  length: number;
  message: string;
  shortMessage?: string;
  replacements: { value: string }[];
  rule: { id: string; description: string; issueType?: string; category: { id: string; name: string } };
}

export type Category = "spelling" | "grammar" | "style";

/** A match relative to its chunk. */
export interface ChunkMatch {
  rel: number;
  len: number;
  /** The original characters covered by the match. */
  word: string;
  message: string;
  replacements: string[];
  ruleId: string;
  ruleDescription: string;
  category: Category;
}

const STYLE_CATEGORIES = new Set(["STYLE", "TYPOGRAPHY", "REDUNDANCY", "COLLOQUIALISMS", "PLAIN_ENGLISH", "WIKIPEDIA", "GENDER_NEUTRALITY", "PUNCTUATION", "EMPFOHLENE_RECHTSCHREIBUNG"]);

export function categoryOf(m: LtMatch): Category {
  if (m.rule.issueType === "misspelling" || m.rule.category.id === "TYPOS") return "spelling";
  if (STYLE_CATEGORIES.has(m.rule.category.id) || m.rule.issueType === "style" || m.rule.issueType === "typographical" || m.rule.issueType === "whitespace") return "style";
  return "grammar";
}

/** Ranges [from, to) of prose within a chunk, relative to the chunk start. */
export function textRanges(segs: Segment[]): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  for (const s of segs) {
    const len = (s.text ?? s.markup ?? "").length;
    if (s.text !== undefined) out.push([pos, pos + len]);
    pos += len;
  }
  return out;
}

function firstProse(text: string, ranges: [number, number][]): number {
  for (const [a, b] of ranges) {
    for (let k = a; k < b; k++) if (text[k].trim() !== "") return k;
  }
  return -1;
}

const SEPARATOR: Segment = { markup: "\n\n", interpretAs: "\n\n" };

export interface Batch {
  data: string;
  /** Start offset of each chunk in the combined text. */
  bases: number[];
  lengths: number[];
}

export function buildBatch(chunks: Chunk[]): Batch {
  const annotation: Segment[] = [];
  const bases: number[] = [];
  const lengths: number[] = [];
  let pos = 0;
  chunks.forEach((c, i) => {
    if (i > 0) {
      annotation.push(SEPARATOR);
      pos += 2;
    }
    bases.push(pos);
    const len = joinSegments(c.segments).length;
    lengths.push(len);
    annotation.push(...c.segments);
    pos += len;
  });
  return { data: JSON.stringify({ annotation }), bases, lengths };
}

/** Distribute matches of a batch response to its chunks; matches only touching markup are dropped. */
export function distribute(chunks: Chunk[], batch: Batch, matches: LtMatch[]): ChunkMatch[][] {
  const out: ChunkMatch[][] = chunks.map(() => []);
  const texts = chunks.map((c) => joinSegments(c.segments));
  const prose = chunks.map((c) => textRanges(c.segments));
  for (const m of matches) {
    const i = batch.bases.findIndex((b, k) => m.offset >= b && m.offset + m.length <= b + batch.lengths[k]);
    if (i === -1) continue; // spans a separator
    const rel = m.offset - batch.bases[i];
    const end = rel + m.length;
    // keep only matches that cover visible prose (not just markup or the spaces around it)
    const text = texts[i];
    const touchesProse =
      prose[i].some(([a, b]) => rel < b && end > a && text.slice(Math.max(a, rel), Math.min(b, end)).trim() !== "") ||
      (m.length === 0 && prose[i].some(([a, b]) => rel >= a && rel <= b));
    if (!touchesProse) continue;
    // A paragraph may continue a sentence that started before a code block or list, so a
    // lowercase word at the start of a chunk is not an error.
    if (m.rule.id === "UPPERCASE_SENTENCE_START" && rel === firstProse(text, prose[i])) continue;
    out[i].push({
      rel,
      len: m.length,
      word: texts[i].slice(rel, end),
      message: m.message,
      replacements: m.replacements.slice(0, 5).map((r) => r.value),
      ruleId: m.rule.id,
      ruleDescription: m.rule.description,
      category: categoryOf(m),
    });
  }
  return out;
}

const MAX_BATCH_CHARS = 20000;
const MAX_CACHE = 5000;

export class GrammarClient {
  private cache = new Map<string, ChunkMatch[]>();
  private inflight = new Set<string>();
  private queue: Chunk[] = [];
  private running = false;
  lastError: string | null = null;

  constructor(
    private check: (data: string) => Promise<string>,
    private onResults: () => void,
  ) {}

  get(chunk: Chunk): ChunkMatch[] | undefined {
    const r = this.cache.get(chunk.key);
    if (r) {
      // keep recently used entries at the end (simple LRU)
      this.cache.delete(chunk.key);
      this.cache.set(chunk.key, r);
    }
    return r;
  }

  /** Queue chunks that are neither cached nor already requested. */
  request(chunks: Chunk[]) {
    for (const c of chunks) {
      if (this.cache.has(c.key) || this.inflight.has(c.key)) continue;
      this.inflight.add(c.key);
      this.queue.push(c);
    }
    void this.pump();
  }

  clear() {
    this.cache.clear();
  }

  get pending() {
    return this.inflight.size;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const batch: Chunk[] = [];
        let size = 0;
        while (this.queue.length && (batch.length === 0 || size + this.queue[0].to - this.queue[0].from < MAX_BATCH_CHARS)) {
          const c = this.queue.shift()!;
          size += c.to - c.from;
          batch.push(c);
        }
        const b = buildBatch(batch);
        try {
          const json = JSON.parse(await this.check(b.data)) as { matches: LtMatch[] };
          const results = distribute(batch, b, json.matches ?? []);
          batch.forEach((c, i) => this.cache.set(c.key, results[i]));
          this.lastError = null;
        } catch (e) {
          this.lastError = String(e);
          // not cached: the chunks are requested again on the next lint run
          this.queue.length = 0;
          for (const c of batch) this.inflight.delete(c.key);
          this.inflight.clear();
          break;
        }
        for (const c of batch) this.inflight.delete(c.key);
        while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
        this.onResults();
      }
    } finally {
      this.running = false;
    }
  }
}
