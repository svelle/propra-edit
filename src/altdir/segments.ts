// Altdir solution files: segmentation into per-enumeration solutions, pairing with the task's
// [EC]/[EQ]/[ER], insertion of new solutions, and EREF renumbering.
//
// Format (confirmed with a real propra-inf solution file): one list item per enumeration,
//   - [EREFQ::1] Antwort …
//   Fortsetzung (not indented)
// Also supported: numbered list items and headings (`#### [EREFQ::3]`).
// A segment starts at a line whose first token is [EREFQ::n]/[EREFC::n]/[EREFR::n] (optionally
// after a list marker or heading #s) and runs until the next such line, or until a heading of
// equal or higher level (any heading ends a list-item segment). Text before the first marker
// is the preamble; text after a closing heading is an "other" segment.

import { parseProPra, type ParserConfig } from "../editor/parser";
import type { EnumKind } from "../editor/macros";

export interface Segment {
  kind: "preamble" | "solution" | "other";
  /** For solutions: "EQ 3" etc. */
  key?: string;
  enumKind?: EnumKind;
  n?: number;
  from: number;
  to: number;
  /** "list", "heading" or "plain" (marker alone at line start), for solutions. */
  style?: "list" | "heading" | "plain";
  /** Heading level of a heading-style marker. */
  level?: number;
}

export interface Segmentation {
  segments: Segment[];
  hasMarkers: boolean;
}

const MARKER_RE = /^[ \t]{0,3}(?:([-*+]|\d+[.)])[ \t]+|(#{1,6})[ \t]+)?\[EREF([CQR])::(\d+)\]/;
const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

export const keyOf = (kind: string, n: number) => `${kind} ${n}`;

export function segmentAltdir(text: string): Segmentation {
  const segments: Segment[] = [];
  let cur: Segment = { kind: "preamble", from: 0, to: text.length };
  let fence: string | null = null;
  const close = (at: number) => {
    cur.to = at;
    if (cur.to > cur.from || cur.kind === "solution") segments.push(cur);
  };
  let pos = 0;
  for (const line of text.split("\n")) {
    const lineStart = pos;
    pos += line.length + 1;
    const f = FENCE_RE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = MARKER_RE.exec(line);
    if (m) {
      close(lineStart);
      const kind = ("E" + m[3]) as EnumKind;
      const n = Number(m[4]);
      cur = { kind: "solution", key: keyOf(kind, n), enumKind: kind, n, from: lineStart, to: text.length, style: m[2] ? "heading" : m[1] ? "list" : "plain", level: m[2]?.length };
      continue;
    }
    const hd = HEADING_RE.exec(line);
    if (hd && cur.kind === "solution" && (cur.style !== "heading" || hd[1].length <= (cur.level ?? 6))) {
      close(lineStart);
      cur = { kind: "other", from: lineStart, to: text.length };
    }
  }
  close(text.length);
  return { segments, hasMarkers: segments.some((s) => s.kind === "solution") };
}

/** End of the segment's content, without trailing blank lines (a line start, or text end). */
export function contentEnd(text: string, seg: Segment): number {
  let end = seg.to;
  while (end > seg.from) {
    const prevNl = text.lastIndexOf("\n", end - 2);
    const lineStart = prevNl + 1;
    if (lineStart < seg.from) break;
    if (text.slice(lineStart, end).trim() !== "") break;
    end = lineStart;
  }
  return end;
}

export interface Pairing {
  byKey: Map<string, Segment[]>;
  /** Solutions whose enumeration does not exist in the task. */
  orphans: Segment[];
}

export function pairSegments(seg: Segmentation, enumKeys: Set<string>): Pairing {
  const byKey = new Map<string, Segment[]>();
  const orphans: Segment[] = [];
  for (const s of seg.segments) {
    if (s.kind !== "solution") continue;
    if (enumKeys.has(s.key!)) byKey.set(s.key!, [...(byKey.get(s.key!) ?? []), s]);
    else orphans.push(s);
  }
  return { byKey, orphans };
}

export interface Insertion {
  from: number;
  insert: string;
  /** Cursor after insertion (end of the new marker line). */
  cursor: number;
}

/** Where and how to add an empty solution for enumeration `kind n`, in number order. */
export function solutionInsertion(text: string, seg: Segmentation, kind: EnumKind, n: number): Insertion {
  const sols = seg.segments.filter((s) => s.kind === "solution");
  const same = sols.filter((s) => s.enumKind === kind);
  const prev = [...same].reverse().find((s) => s.n! < n);
  const next = same.find((s) => s.n! > n);
  const model = prev ?? next ?? sols[sols.length - 1];
  const marker = `[EREF${kind.slice(1)}::${n}]`;
  let from: number;
  if (prev) from = contentEnd(text, prev);
  else if (next) from = next.from;
  else if (sols.length) from = contentEnd(text, sols[sols.length - 1]);
  else from = text.length;
  let prefix = from > 0 && text[from - 1] !== "\n" ? "\n" : "";
  // first solution after a preamble: separate it by a blank line
  if (!sols.length && text.trim() !== "" && !text.endsWith("\n\n")) prefix += "\n";
  if (model?.style === "heading") {
    const head = `${"#".repeat(model.level ?? 4)} ${marker}\n`;
    return { from, insert: `${prefix}${head}\n`, cursor: from + prefix.length + head.length };
  }
  const line = model?.style === "plain" ? `${marker} ` : `- ${marker} `;
  return { from, insert: `${prefix}${line}\n`, cursor: from + prefix.length + line.length };
}

export type Renumbering = Partial<Record<EnumKind, Map<number, number>>>;

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Changes that rewrite every [EREFx::old] to [EREFx::new] (simultaneously; macros-off respected). */
export function renumberChanges(text: string, mapping: Renumbering, cfg: ParserConfig = { blockMacros: [] }, topMatter = false): TextChange[] {
  const doc = parseProPra(text, cfg, { topMatter });
  const out: TextChange[] = [];
  for (const call of doc.macros) {
    if (!/^EREF[CQR]$/.test(call.name) || call.args.length !== 1) continue;
    const kind = ("E" + call.name.slice(4)) as EnumKind;
    const old = Number(call.args[0]);
    const nu = mapping[kind]?.get(old);
    if (nu === undefined || nu === old) continue;
    const r = call.argRanges[0];
    out.push({ from: r.from, to: r.to, insert: String(nu) });
  }
  return out;
}

export function applyChanges(text: string, changes: TextChange[]): string {
  let out = "";
  let pos = 0;
  for (const c of [...changes].sort((a, b) => a.from - b.from)) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}
