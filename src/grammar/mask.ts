// Masking for LanguageTool: decide for every character of a file whether it is prose
// ("text") or markup, and cut the file into paragraph chunks in LanguageTool's `data`
// annotation format. Concatenating a chunk's segments gives back the exact original text,
// so LanguageTool's match offsets map back without manual bookkeeping.

import type { Tree } from "@lezer/common";
import type { MacroCall, ProPraDoc } from "../editor/parser";

export interface Segment {
  text?: string;
  markup?: string;
  interpretAs?: string;
}

export interface Chunk {
  from: number;
  to: number;
  segments: Segment[];
  /** Identity for caching: the JSON of the segments. */
  key: string;
}

/** owner[i] === TEXT: character i is prose; otherwise the index of its markup interval. */
export const TEXT = -1;

export interface Mask {
  text: string;
  owner: Int32Array;
  interpretAs: string[];
}

const PARA = "\n\n";
/** Neutral stand-in for inline code, URLs and paths, so sentences keep a word there. */
const PLACEHOLDER = "X";

class MaskBuilder {
  owner: Int32Array;
  interpretAs: string[] = [];
  constructor(readonly text: string) {
    this.owner = new Int32Array(text.length).fill(TEXT);
  }
  /** Like markup(), but only where nothing has claimed the characters yet. */
  markupIfText(from: number, to: number, interpretAs = "") {
    for (let i = from; i < to; i++) if (this.owner[i] !== TEXT) return;
    this.markup(from, to, interpretAs);
  }
  markup(from: number, to: number, interpretAs = "") {
    from = Math.max(0, from);
    to = Math.min(this.text.length, to);
    if (to <= from) return;
    const id = this.interpretAs.length;
    this.interpretAs.push(interpretAs);
    this.owner.fill(id, from, to);
  }
  forceText(from: number, to: number) {
    this.owner.fill(TEXT, Math.max(0, from), Math.min(this.text.length, to));
  }
}

// Paths: `/x/y`, `~/x`, `./x`, `../x`, or `a/b.ext`, or anything with two slashes.
// Plain `und/oder` stays text.
const PATH_RE = /(?<![\w/.~-])(?:(?:~\/|\.{1,2}\/|\/)[\w.-]+(?:\/[\w.-]+)*|[\w.-]+(?:\/[\w.-]+)+)\/?/g;
const BARE_URL_RE = /\b(?:https?|ftp):\/\/[^\s<>()\]]+/g;
const TRAILING_WS_RE = /[ \t]+$/gm;

function looksLikePath(s: string): boolean {
  if (/^(?:~\/|\.{1,2}\/|\/)/.test(s)) return true;
  if ((s.match(/\//g) ?? []).length >= 2) return true;
  const last = s.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]{1,6}$/.test(last);
}

const INLINE_MARK_NODES = new Set(["EmphasisMark", "StrikethroughMark", "LinkMark", "LinkTitle", "LinkLabel", "TaskMarker", "TableDelimiter", "HTMLTag", "Comment", "ProcessingInstruction", "Entity"]);
const PLACEHOLDER_NODES = new Set(["InlineCode", "URL", "Autolink"]);
const BLOCK_MARKUP_NODES = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock", "HorizontalRule", "LinkReference"]);
const LINE_PREFIX_NODES = new Set(["HeaderMark", "ListMark", "QuoteMark"]);
const BREAK_BEFORE_NODES = /^(ListItem|ATXHeading\d|SetextHeading\d|Blockquote|Table|TableRow|TableHeader)$/;

/** Prose arguments of macros: [macroname] -> index of the argument that is checked as text. */
const PROSE_ARG: Record<string, number> = { HINT: 0, FOLDOUT: 0, INSTRUCTOR: 0, PARTREF2: 1 };

function maskMacro(b: MaskBuilder, call: MacroCall) {
  const def = call.def;
  const name = call.name;
  const isBlock = def?.kind === "blockstart" || def?.kind === "blockend";
  const proseIdx = PROSE_ARG[name];
  if (proseIdx !== undefined && call.argRanges[proseIdx] && call.args[proseIdx].trim() !== "") {
    const r = call.argRanges[proseIdx];
    b.markup(call.from, r.from, "");
    b.forceText(r.from, r.to);
    b.markup(r.to, call.to, isBlock ? PARA : "");
    return;
  }
  if (name === "TERMREF2" && call.args.length === 2) {
    const [term, shown] = call.args;
    if (shown.startsWith("-")) {
      b.markup(call.from, call.to, term + shown.slice(1));
    } else {
      const r = call.argRanges[1];
      b.markup(call.from, r.from, "");
      b.forceText(r.from, r.to);
      b.markup(r.to, call.to, "");
    }
    return;
  }
  let interpret = "";
  if (isBlock) interpret = PARA;
  else if (name === "TERMREF" || name === "PARTREF") interpret = call.args[0] ?? "";
  else if (name === "HREF" || name.startsWith("EREF")) interpret = PLACEHOLDER;
  let to = call.to;
  // A macro that starts the line ("[EQ] Was ...", "- [EREFQ::4] Antwort") is a label, not
  // part of the sentence: drop it together with the following space.
  const lineStart = b.text.lastIndexOf("\n", call.from - 1) + 1;
  const before = b.text.slice(lineStart, call.from);
  if (!isBlock && /^\s*(?:[-*+]|\d+[.)]|#+)?\s*$/.test(before) && (interpret === "" || name.startsWith("EREF"))) {
    interpret = "";
    while (b.text[to] === " " || b.text[to] === "\t") to++;
  }
  b.markup(call.from, to, interpret);
}

export function buildMask(text: string, doc: ProPraDoc, tree: Tree | null): Mask {
  const b = new MaskBuilder(text);

  // 0 (lowest priority): a single line break inside a paragraph is a space in Markdown;
  //   LanguageTool would otherwise sometimes see a sentence end after "bzw." etc.
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) b.markup(i, i + 1, " ");
  // 1: paragraph breaks before list items, headings, quotes, table rows,
  //   so that LanguageTool does not join them into one sentence.
  // 2: Markdown syntax from the syntax tree.
  if (tree) {
    const breakAt = (pos: number) => {
      if (pos > 0 && text[pos - 1] === "\n") b.markup(pos - 1, pos, PARA);
    };
    tree.iterate({
      enter: (n) => {
        const name = n.name;
        if (BREAK_BEFORE_NODES.test(name)) {
          breakAt(n.from);
          if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
            if (text[n.to] === "\n") b.markup(n.to, n.to + 1, PARA);
          }
        }
      },
    });
    tree.iterate({
      enter: (n) => {
        const name = n.name;
        if (name === "TopMatter") {
          b.markup(n.from, n.to, "");
          return false;
        }
        if (BLOCK_MARKUP_NODES.has(name)) {
          // include the indentation of indented code blocks
          const lineStart = text.lastIndexOf("\n", n.from - 1) + 1;
          b.markup(name === "CodeBlock" ? lineStart : n.from, n.to, PARA);
          return false;
        }
        if (name === "Image") {
          b.markup(n.from, n.to, "");
          return false;
        }
        if (PLACEHOLDER_NODES.has(name)) {
          // the URL of [text](url) is not part of the sentence; the link text is
          const inLink = name === "URL" && /^(Link|Image)$/.test(n.node.parent?.name ?? "");
          b.markup(n.from, n.to, inLink ? "" : PLACEHOLDER);
          return false;
        }
        if (LINE_PREFIX_NODES.has(name)) {
          let to = n.to;
          while (text[to] === " " || text[to] === "\t") to++;
          b.markup(n.from, to, "");
        } else if (INLINE_MARK_NODES.has(name)) {
          b.markup(n.from, n.to, name === "Entity" ? decodeEntity(text.slice(n.from, n.to)) : name === "TableDelimiter" ? " " : "");
        } else if (name === "Escape") {
          b.markup(n.from, n.from + 1, ""); // the backslash only
        }
        return undefined;
      },
    });
  }

  // 3: trailing whitespace (Markdown hard breaks), bare URLs and file paths
  for (const m of text.matchAll(TRAILING_WS_RE)) b.markup(m.index!, m.index! + m[0].length, "");
  for (const m of text.matchAll(BARE_URL_RE)) b.markupIfText(m.index!, m.index! + m[0].length, PLACEHOLDER);
  for (const m of text.matchAll(PATH_RE)) {
    if (looksLikePath(m[0])) b.markupIfText(m.index!, m.index! + m[0].length, PLACEHOLDER);
  }

  // 4: fences (also without a syntax tree), macros-off regions, replacement pseudo-tags
  for (const f of doc.fences) b.markup(f.from, f.to, PARA);
  for (const r of doc.macrosOff) b.markup(r.markerFrom, r.markerTo, PARA);
  for (const r of doc.replacements) {
    const open = text.indexOf(">", r.from) + 1;
    const close = text.lastIndexOf("</replacement>", r.to);
    b.markup(r.from, open, "");
    b.markup(close, r.to, "");
  }

  // 5: top matter
  if (doc.topMatter) b.markup(0, doc.bodyFrom, "");

  // 6 (highest): macro calls
  for (const call of doc.macros) maskMacro(b, call);

  return { text, owner: b.owner, interpretAs: b.interpretAs };
}

function decodeEntity(s: string): string {
  const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&nbsp;": " ", "&shy;": "" };
  if (named[s] !== undefined) return named[s];
  const m = /^&#(x?)([0-9a-f]+);$/i.exec(s);
  return m ? String.fromCodePoint(parseInt(m[2], m[1] ? 16 : 10)) : "";
}

/** Segments for [from, to). Each markup interval gets its interpretAs on its first piece only. */
export function segmentsFor(mask: Mask, from: number, to: number): Segment[] {
  const { text, owner, interpretAs } = mask;
  const segs: Segment[] = [];
  const seen = new Set<number>();
  let i = from;
  while (i < to) {
    const o = owner[i];
    let j = i + 1;
    while (j < to && owner[j] === o) j++;
    const s = text.slice(i, j);
    if (o === TEXT) segs.push({ text: s });
    else {
      const seg: Segment = { markup: s };
      if (!seen.has(o)) {
        seen.add(o);
        if (interpretAs[o]) seg.interpretAs = interpretAs[o];
      }
      segs.push(seg);
    }
    i = j;
  }
  return segs;
}

/**
 * Paragraph chunks: runs of non-blank lines. Blank lines inside fences, macros-off regions
 * and the top matter do not split. Chunks without any prose letters are dropped.
 */
export function chunksOf(mask: Mask, doc: ProPraDoc): Chunk[] {
  const { text, owner } = mask;
  const noSplit: [number, number][] = [...doc.fences.map((f) => [f.from, f.to] as [number, number]), ...doc.macrosOff.map((r) => [r.markerFrom, r.markerTo] as [number, number])];
  if (doc.topMatter) noSplit.push([0, doc.bodyFrom]);
  const insideNoSplit = (pos: number) => noSplit.some(([a, b]) => pos > a && pos < b);
  const chunks: Chunk[] = [];
  const ls = doc.lineStarts;
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start < 0) return;
    let hasProse = false;
    for (let k = start; k < end && !hasProse; k++) if (owner[k] === TEXT && /\p{L}/u.test(text[k])) hasProse = true;
    if (hasProse) {
      const segments = segmentsFor(mask, start, end);
      chunks.push({ from: start, to: end, segments, key: JSON.stringify(segments) });
    }
    start = -1;
  };
  for (let l = 0; l < ls.length; l++) {
    const lf = ls[l];
    const lt = l + 1 < ls.length ? ls[l + 1] - 1 : text.length;
    const blank = text.slice(lf, lt).trim() === "";
    if (blank && !insideNoSplit(lf)) {
      flush();
    } else if (!blank || start >= 0) {
      if (start < 0) start = lf;
      end = lt;
    }
  }
  flush();
  return chunks;
}

/** Concatenate the original text of segments (for tests and assertions). */
export function joinSegments(segs: Segment[]): string {
  return segs.map((s) => s.text ?? s.markup ?? "").join("");
}

/** The plain text LanguageTool sees (text plus interpretAs). */
export function plainText(segs: Segment[]): string {
  return segs.map((s) => s.text ?? s.interpretAs ?? "").join("");
}
