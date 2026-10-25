// The glossary model: [TERM::a|b]…[ENDTERM] blocks and [TERM0::a|b] entries of glossary.md,
// sedrila's ordering rule, and where a new term belongs.

import type { MacroCall, ProPraDoc } from "../editor/parser";

export interface GlossaryTerm {
  /** First name is the display name; all names are valid TERMREF targets. */
  names: string[];
  term0: boolean;
  /** Whole entry: from the [TERM…] call to the end of [ENDTERM] (or the TERM0 call). */
  from: number;
  to: number;
  /** Definition text between the TERM line and the ENDTERM line (empty for TERM0). */
  bodyFrom: number;
  bodyTo: number;
  /** 0-based line of the [TERM…] call. */
  line: number;
  call: MacroCall;
}

function splitNames(arg: string | undefined): string[] {
  return (arg ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function glossaryTerms(doc: ProPraDoc): GlossaryTerm[] {
  const out: GlossaryTerm[] = [];
  const lineEnd = (l: number) => (l + 1 < doc.lineStarts.length ? doc.lineStarts[l + 1] - 1 : doc.text.length);
  for (const b of doc.blocks) {
    if (b.name !== "TERM") continue;
    const bodyFrom = Math.min(doc.text.length, lineEnd(b.open.line) + 1);
    const bodyTo = b.close ? Math.max(bodyFrom, doc.lineStarts[b.close.line]) : doc.text.length;
    out.push({ names: splitNames(b.open.args[0]), term0: false, from: b.open.from, to: b.close ? b.close.to : doc.text.length, bodyFrom, bodyTo, line: b.open.line, call: b.open });
  }
  for (const c of doc.macros) {
    if (c.name !== "TERM0") continue;
    out.push({ names: splitNames(c.args[0]), term0: true, from: c.from, to: c.to, bodyFrom: c.to, bodyTo: c.to, line: c.line, call: c });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** sedrila's sort key for glossary terms: backquotes removed, Python's str.casefold(). */
export function sortKey(term: string): string {
  return term.replace(/`/g, "").toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");
}

/** Code-point comparison, as Python compares strings (not locale-aware). */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Main terms that sedrila reports as "not in alphabetical order". */
export function outOfOrder(terms: GlossaryTerm[]): GlossaryTerm[] {
  const bad: GlossaryTerm[] = [];
  let prev = "";
  for (const t of terms) {
    const key = sortKey(t.names[0] ?? "");
    if (compareKeys(key, prev) < 0) bad.push(t);
    prev = key;
  }
  return bad;
}

/** Names defined by more than one entry. */
export function duplicateNames(terms: GlossaryTerm[]): Map<string, GlossaryTerm[]> {
  const by = new Map<string, GlossaryTerm[]>();
  for (const t of terms) for (const n of new Set(t.names)) by.set(n, [...(by.get(n) ?? []), t]);
  return new Map([...by].filter(([, ts]) => ts.length > 1));
}

export interface Insertion {
  from: number;
  insert: string;
  /** Cursor position (inside the empty definition) after inserting. */
  cursor: number;
}

const HEADING_RE = /^##[ \t]+(\S+)[ \t]*$/gm;

/**
 * Where a new [TERM::name] block goes: sorted by sedrila's key among the main terms, inside
 * the matching "## X" letter section if the glossary uses such headings (creating the heading
 * when it is missing).
 */
export function termInsertion(doc: ProPraDoc, name: string): Insertion {
  const text = doc.text;
  const terms = glossaryTerms(doc);
  const key = sortKey(name);
  const block = `[TERM::${name}]\n\n[ENDTERM]`;
  const before = (pos: number, prefix = ""): Insertion => ({ from: pos, insert: `${prefix}${block}\n\n`, cursor: pos + prefix.length + `[TERM::${name}]\n`.length });
  const after = (pos: number): Insertion => ({ from: pos, insert: `\n\n${block}`, cursor: pos + `\n\n[TERM::${name}]\n`.length });
  const atEnd = (prefix = ""): Insertion => {
    const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const from = text.length;
    const insert = `${sep}${prefix}${block}\n`;
    return { from, insert, cursor: from + sep.length + prefix.length + `[TERM::${name}]\n`.length };
  };

  const body = doc.bodyFrom;
  const headings = [...text.matchAll(HEADING_RE)].filter((m) => m.index! >= body).map((m) => ({ from: m.index!, to: m.index! + m[0].length, key: sortKey(m[1]) }));
  const firstLetter = [...key][0] ?? "";

  if (headings.length) {
    const hIdx = headings.findIndex((h) => h.key === firstLetter);
    if (hIdx !== -1) {
      const h = headings[hIdx];
      const sectionEnd = headings[hIdx + 1]?.from ?? text.length;
      const inSection = terms.filter((t) => t.from > h.to && t.from < sectionEnd);
      const next = inSection.find((t) => compareKeys(sortKey(t.names[0] ?? ""), key) > 0);
      if (next) return before(next.from);
      const last = inSection[inSection.length - 1];
      return after(last ? last.to : h.to);
    }
    const nextHeading = headings.find((h) => compareKeys(h.key, firstLetter) > 0);
    const heading = `## ${firstLetter.toUpperCase()}\n\n`;
    if (nextHeading) return before(nextHeading.from, heading);
    return atEnd(`\n${heading}`.replace(/^\n/, text.endsWith("\n\n") ? "" : "\n"));
  }

  const next = terms.find((t) => compareKeys(sortKey(t.names[0] ?? ""), key) > 0);
  if (next) return before(next.from);
  const last = terms[terms.length - 1];
  return last ? after(last.to) : atEnd();
}
