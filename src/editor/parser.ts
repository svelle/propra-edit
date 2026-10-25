// The ProPra document model: one parse per open file, consumed by highlighting, lints,
// grammar masking, inline solutions and the preview. Nobody re-parses with their own regexes.
//
// Rules follow sedrila 3.2.0 (framework/macros.py, framework/partbuilder.py):
// - Top matter is everything before the first `---` line; there is no opening `---`.
// - Macro calls match `\[([A-Z][A-Z0-9_]+)(::(.*?))?(::(.*?))?\]` not followed by `(`,
//   on a single line. They are found everywhere in the body (also inside code),
//   except between `<!-- sedrila: macros off -->` and `<!-- sedrila: macros off end -->`.
// - [EC]/[EQ]/[ER] are numbered per kind in file order, starting at 1.

import { buildMacroTable, type BlockFamily, type BlockMacroConfig, type EnumKind, type MacroDef, DEFAULT_BLOCK_MACROS } from "./macros";

export interface Range {
  from: number;
  to: number;
}

export interface TopMatterEntry {
  key: string;
  /** Raw value text (after `key:`), trimmed, comments included. */
  value: string;
  line: number;
  keyFrom: number;
  keyTo: number;
  valueFrom: number;
  valueTo: number;
}

export interface TopMatter {
  /** YAML text range (from 0 up to the separator line). */
  from: number;
  to: number;
  /** The `---` separator line. */
  sepFrom: number;
  sepTo: number;
  entries: TopMatterEntry[];
}

export interface MacroCall {
  name: string;
  args: string[];
  /** Whole call `[...]`. */
  from: number;
  to: number;
  nameFrom: number;
  nameTo: number;
  argRanges: Range[];
  /** 0-based line number. */
  line: number;
  def?: MacroDef;
  /** True if nothing but whitespace shares the line with this call. */
  aloneOnLine: boolean;
}

export interface Block {
  name: string;
  family: BlockFamily;
  open: MacroCall;
  close?: MacroCall;
  /** 0-based nesting depth (0 = top level). */
  depth: number;
  /** First and last line of the body (between open and close lines); bodyEndLine < bodyStartLine if empty. */
  bodyStartLine: number;
  bodyEndLine: number;
}

export type BlockErrorCode = "unclosed" | "unmatched-end" | "misnested";

export interface BlockError {
  code: BlockErrorCode;
  call: MacroCall;
  message: string;
}

export interface Enumeration {
  kind: EnumKind;
  number: number;
  call: MacroCall;
}

export interface Fence extends Range {
  lang: string;
  startLine: number;
  endLine: number;
}

export interface Replacement extends Range {
  id: string;
}

export interface ProPraDoc {
  text: string;
  lineStarts: number[];
  topMatter?: TopMatter;
  bodyFrom: number;
  macros: MacroCall[];
  blocks: Block[];
  blockErrors: BlockError[];
  enumerations: Enumeration[];
  termrefs: MacroCall[];
  partrefs: MacroCall[];
  /** INCLUDE, PROT, SNIPPET, TREEREF calls. */
  includes: MacroCall[];
  /** Body of each macros-off region (between the markers), plus the marker ranges. */
  macrosOff: { from: number; to: number; markerFrom: number; markerTo: number }[];
  replacements: Replacement[];
  fences: Fence[];
}

export interface ParserConfig {
  blockMacros: BlockMacroConfig[];
}

export interface ParseOptions {
  /** Part files (tasks, index.md, glossary.md) have top matter; include files do not. */
  topMatter: boolean;
}

const MACRO_RE = /\[([A-Z][A-Z0-9_]+)(?:::(.*?))?(?:::(.*?))?\](?=[^(]|$)/dg;
const MACROS_OFF_RE = /<!--\s*sedrila:\s*macros\s*off\s*-->([\s\S]*?)<!--\s*sedrila:\s*macros\s*off\s*end\s*-->/g;
const REPLACEMENT_RE = /<replacement\s+id="([^"]*)"\s*>[\s\S]*?<\/replacement>/g;
const TOPMATTER_ENTRY_RE = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]?(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

const tableCache = new Map<string, Map<string, MacroDef>>();
function tableFor(cfg: ParserConfig): Map<string, MacroDef> {
  const key = cfg.blockMacros.map((b) => `${b.name}/${b.arity}`).join(",");
  let t = tableCache.get(key);
  if (!t) {
    t = buildMacroTable(cfg.blockMacros);
    tableCache.set(key, t);
  }
  return t;
}

export const DEFAULT_PARSER_CONFIG: ParserConfig = { blockMacros: DEFAULT_BLOCK_MACROS };

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

export function lineOf(lineStarts: number[], pos: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function lineEnd(text: string, lineStarts: number[], line: number): number {
  return line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
}

function parseTopMatter(text: string, lineStarts: number[]): TopMatter | undefined {
  for (let line = 0; line < lineStarts.length; line++) {
    const from = lineStarts[line];
    const to = lineEnd(text, lineStarts, line);
    if (text.slice(from, to) === "---") {
      const entries: TopMatterEntry[] = [];
      for (let l = 0; l < line; l++) {
        const lf = lineStarts[l];
        const lt = lineEnd(text, lineStarts, l);
        const m = TOPMATTER_ENTRY_RE.exec(text.slice(lf, lt));
        if (!m) continue;
        const raw = m[2];
        const valueOffset = lt - lf - raw.length;
        const lead = raw.length - raw.trimStart().length;
        const value = raw.trim();
        entries.push({
          key: m[1],
          value,
          line: l,
          keyFrom: lf,
          keyTo: lf + m[1].length,
          valueFrom: lf + valueOffset + lead,
          valueTo: lf + valueOffset + lead + value.length,
        });
      }
      return { from: 0, to: from, sepFrom: from, sepTo: to, entries };
    }
  }
  return undefined;
}

export function parseProPra(text: string, cfg: ParserConfig = DEFAULT_PARSER_CONFIG, opts: ParseOptions = { topMatter: true }): ProPraDoc {
  const table = tableFor(cfg);
  const lineStarts = computeLineStarts(text);
  const topMatter = opts.topMatter ? parseTopMatter(text, lineStarts) : undefined;
  const bodyFrom = topMatter ? Math.min(text.length, topMatter.sepTo + 1) : 0;

  // ----- macros-off regions
  const macrosOff: ProPraDoc["macrosOff"] = [];
  MACROS_OFF_RE.lastIndex = bodyFrom;
  for (let m; (m = MACROS_OFF_RE.exec(text)); ) {
    const inner = m.index + m[0].indexOf("-->") + 3; // group 1 starts right after the first marker
    macrosOff.push({ from: inner, to: inner + m[1].length, markerFrom: m.index, markerTo: m.index + m[0].length });
  }
  const inOff = (pos: number) => macrosOff.some((r) => pos >= r.from && pos < r.to);

  // ----- replacements
  const replacements: Replacement[] = [];
  REPLACEMENT_RE.lastIndex = bodyFrom;
  for (let m; (m = REPLACEMENT_RE.exec(text)); ) {
    replacements.push({ from: m.index, to: m.index + m[0].length, id: m[1] });
  }

  // ----- fences (recorded for masking and the preview; macros are still expanded inside)
  const fences: Fence[] = [];
  {
    let open: { marker: string; lang: string; from: number; line: number } | null = null;
    for (let line = lineOf(lineStarts, bodyFrom); line < lineStarts.length; line++) {
      const lf = lineStarts[line];
      const lt = lineEnd(text, lineStarts, line);
      const m = FENCE_RE.exec(text.slice(lf, lt));
      if (!m) continue;
      if (!open) {
        open = { marker: m[1], lang: m[2] ?? "", from: lf, line };
      } else if (m[1][0] === open.marker[0] && m[1].length >= open.marker.length && !m[2]) {
        fences.push({ from: open.from, to: lt, lang: open.lang, startLine: open.line, endLine: line });
        open = null;
      }
    }
    if (open) fences.push({ from: open.from, to: text.length, lang: open.lang, startLine: open.line, endLine: lineStarts.length - 1 });
  }

  // ----- macro calls
  const macros: MacroCall[] = [];
  MACRO_RE.lastIndex = bodyFrom;
  for (let m: RegExpExecArray | null; (m = MACRO_RE.exec(text)); ) {
    if (inOff(m.index)) continue;
    const idx = m.indices!;
    const args: string[] = [];
    const argRanges: Range[] = [];
    for (const g of [2, 3]) {
      if (m[g] !== undefined) {
        args.push(m[g]);
        argRanges.push({ from: idx[g]![0], to: idx[g]![1] });
      }
    }
    const from = m.index;
    const to = from + m[0].length;
    const line = lineOf(lineStarts, from);
    const lf = lineStarts[line];
    const lt = lineEnd(text, lineStarts, line);
    macros.push({
      name: m[1],
      args,
      from,
      to,
      nameFrom: idx[1]![0],
      nameTo: idx[1]![1],
      argRanges,
      line,
      def: table.get(m[1]),
      aloneOnLine: text.slice(lf, from).trim() === "" && text.slice(to, lt).trim() === "",
    });
  }

  // ----- block pairing
  const blocks: Block[] = [];
  const blockErrors: BlockError[] = [];
  const stack: MacroCall[] = [];
  const pushBlock = (open: MacroCall, close: MacroCall | undefined, depth: number) => {
    blocks.push({
      name: open.name,
      family: open.def!.family!,
      open,
      close,
      depth,
      bodyStartLine: open.line + 1,
      bodyEndLine: close ? close.line - 1 : lineStarts.length - 1,
    });
  };
  for (const call of macros) {
    const kind = call.def?.kind;
    if (kind === "blockstart") {
      stack.push(call);
    } else if (kind === "blockend") {
      const want = call.def!.startName!;
      const pos = stack.map((c) => c.name).lastIndexOf(want);
      if (pos === -1) {
        blockErrors.push({ code: "unmatched-end", call, message: `[${call.name}] ohne passendes [${want}]` });
        continue;
      }
      while (stack.length - 1 > pos) {
        const inner = stack.pop()!;
        blockErrors.push({ code: "misnested", call: inner, message: `[${inner.name}] wird nicht vor [${call.name}] geschlossen` });
        pushBlock(inner, undefined, stack.length);
      }
      const open = stack.pop()!;
      pushBlock(open, call, stack.length);
    }
  }
  while (stack.length) {
    const open = stack.pop()!;
    blockErrors.push({ code: "unclosed", call: open, message: `[${open.name}] wird nicht geschlossen` });
    pushBlock(open, undefined, stack.length);
  }
  blocks.sort((a, b) => a.open.from - b.open.from);

  // ----- enumerations and references
  const counters: Record<EnumKind, number> = { EC: 0, EQ: 0, ER: 0 };
  const enumerations: Enumeration[] = [];
  const termrefs: MacroCall[] = [];
  const partrefs: MacroCall[] = [];
  const includes: MacroCall[] = [];
  for (const call of macros) {
    switch (call.name) {
      case "EC":
      case "EQ":
      case "ER":
        if (call.args.length === 0) enumerations.push({ kind: call.name, number: ++counters[call.name], call });
        break;
      case "TERMREF":
      case "TERMREF2":
        termrefs.push(call);
        break;
      case "PARTREF":
      case "PARTREF2":
        partrefs.push(call);
        break;
      case "INCLUDE":
      case "PROT":
      case "SNIPPET":
      case "TREEREF":
        includes.push(call);
        break;
    }
  }

  return { text, lineStarts, topMatter, bodyFrom, macros, blocks, blockErrors, enumerations, termrefs, partrefs, includes, macrosOff, replacements, fences };
}

/** The innermost block containing `line` in its body, if any. */
export function blockAtLine(doc: ProPraDoc, line: number): Block | undefined {
  let best: Block | undefined;
  for (const b of doc.blocks) {
    if (b.open.line > line) break;
    if (line >= b.bodyStartLine && line <= b.bodyEndLine && (!best || b.depth >= best.depth)) best = b;
  }
  return best;
}
