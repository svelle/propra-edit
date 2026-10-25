// Live structural lints (no sedrila needed). Pure function of the ProPraDoc and the course
// context. Every lint has a stable id so it can be silenced per file.

import type { MacroCall, ProPraDoc, TopMatterEntry } from "../editor/parser";
import { EREF_TO_ENUM } from "../editor/macros";
import { de } from "../i18n/de";
import { duplicateNames, glossaryTerms, outOfOrder } from "../glossary/model";

export type FileKind = "task" | "taskgroup" | "chapter" | "glossary" | "include" | "other";

export interface IncludeStatus {
  exists: boolean;
  treeMissing: boolean;
  snippetFound: boolean | null;
  path: string | null;
}

export interface LintContext {
  fileKind: FileKind;
  stages: string[];
  sectionTypes: Record<string, string[]>;
  /** All glossary names (main names and synonyms); null if unknown. */
  glossaryNames: Set<string> | null;
  /** The global part namespace; null if unknown. */
  partNames: Set<string> | null;
  /** Results for INCLUDE/PROT/SNIPPET/TREEREF calls, by includeKey(); missing entries are not checked. */
  includes: Map<string, IncludeStatus>;
}

export type Severity = "error" | "warning" | "info";

export interface LintFinding {
  id: LintId;
  from: number;
  to: number;
  severity: Severity;
  message: string;
}

export const LINT_IDS = [
  "unknown-macro",
  "macro-arity",
  "glossary-only-macro",
  "block-unclosed",
  "block-unmatched-end",
  "block-misnested",
  "block-not-alone",
  "block-nesting",
  "section-type",
  "section-subtype",
  "termref-unknown",
  "partref-unknown",
  "include-missing",
  "snippet-missing",
  "eref-range",
  "topmatter-missing",
  "topmatter-difficulty",
  "topmatter-timevalue",
  "topmatter-stage",
  "topmatter-explains",
  "topmatter-explains-chapter",
  "topmatter-assumes",
  "topmatter-requires",
  "glossary-duplicate",
  "glossary-order",
] as const;
export type LintId = (typeof LINT_IDS)[number];

export const INCLUDE_MACROS = new Set(["INCLUDE", "PROT", "SNIPPET", "TREEREF"]);

export function includeKey(call: MacroCall): string {
  return `${call.name}|${call.args[0] ?? ""}|${call.name === "SNIPPET" ? (call.args[1] ?? "") : ""}`;
}

const PART_FILE_KINDS = new Set<FileKind>(["task", "taskgroup", "chapter", "glossary"]);

/** A YAML scalar as written in top matter: comment and quotes removed. */
export function yamlScalar(raw: string): string {
  let v = raw;
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash);
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

/** Comma-separated names in a top matter value, with absolute positions. */
export function listItems(e: TopMatterEntry): { name: string; from: number; to: number }[] {
  const out: { name: string; from: number; to: number }[] = [];
  const raw = e.value;
  const hash = raw.search(/\s#/);
  const body = hash === -1 ? raw : raw.slice(0, hash);
  let pos = 0;
  for (const piece of body.split(",")) {
    const lead = piece.length - piece.trimStart().length;
    const name = piece.trim();
    if (name) out.push({ name, from: e.valueFrom + pos + lead, to: e.valueFrom + pos + lead + name.length });
    pos += piece.length + 1;
  }
  return out;
}

export function structuralLints(doc: ProPraDoc, ctx: LintContext): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (id: LintId, from: number, to: number, severity: Severity, message: string) => out.push({ id, from, to, severity, message });
  const m = de.lint;
  const isPart = PART_FILE_KINDS.has(ctx.fileKind);

  // ----- macro names and arity
  for (const call of doc.macros) {
    const def = call.def;
    if (!def) {
      add("unknown-macro", call.from, call.to, "error", m.unknownMacro(call.name));
      continue;
    }
    if (call.args.length !== def.arity) {
      add("macro-arity", call.from, call.to, "error", m.arity(call.name, call.args.length, def.arity));
    }
    if ((call.name === "TERM" || call.name === "TERM0" || call.name === "ENDTERM") && ctx.fileKind !== "glossary" && ctx.fileKind !== "other") {
      add("glossary-only-macro", call.from, call.to, "error", m.glossaryOnly(call.name));
    }
  }

  // ----- block structure
  for (const e of doc.blockErrors) {
    const id = e.code === "unclosed" ? "block-unclosed" : e.code === "unmatched-end" ? "block-unmatched-end" : "block-misnested";
    add(id, e.call.from, e.call.to, "warning", e.message);
  }
  for (const call of doc.macros) {
    const kind = call.def?.kind;
    if (kind !== "blockstart" && kind !== "blockend") continue;
    if (!call.aloneOnLine) add("block-not-alone", call.from, call.to, "warning", m.notAlone(call.name));
  }
  for (const b of doc.blocks) {
    const parents = doc.blocks.filter((p) => p !== b && p.open.from < b.open.from && (p.close ? p.close.from > b.open.from : true) && p.depth < b.depth);
    const parent = parents.sort((x, y) => y.depth - x.depth)[0];
    // Other blocks nest fine (e.g. [HINT] in [HINT] is used on purpose). A parent that is not
    // closed is reported as unclosed already.
    if (parent && !parent.close) continue;
    if (b.name === "INNERSECTION") {
      if (!parent || parent.name !== "SECTION") add("block-nesting", b.open.from, b.open.to, "warning", m.innerSection);
    } else if (b.name === "SECTION" && parent) {
      add("block-nesting", b.open.from, b.open.to, "warning", m.sectionNested);
    }
  }

  // ----- section types
  if (isPart) {
    for (const call of doc.macros) {
      if ((call.name !== "SECTION" && call.name !== "INNERSECTION") || call.args.length !== 2) continue;
      const [type, subtypes] = call.args;
      const allowed = ctx.sectionTypes[type];
      if (!allowed) {
        add("section-type", call.argRanges[0].from, call.argRanges[0].to, "error", m.sectionType(type, Object.keys(ctx.sectionTypes)));
        continue;
      }
      let pos = call.argRanges[1].from;
      for (const sub of subtypes.split(",")) {
        if (!allowed.includes(sub.trim())) add("section-subtype", pos, pos + sub.length, "error", m.sectionSubtype(sub.trim(), type, allowed));
        pos += sub.length + 1;
      }
    }
  }

  // ----- references
  if (isPart && ctx.glossaryNames) {
    for (const call of doc.termrefs) {
      const term = call.args[0];
      if (term !== undefined && call.argRanges[0] && !ctx.glossaryNames.has(term)) {
        add("termref-unknown", call.argRanges[0].from, call.argRanges[0].to, "error", m.termUnknown(term));
      }
    }
  }
  if (isPart && ctx.partNames) {
    for (const call of doc.partrefs) {
      const name = call.args[0];
      if (name !== undefined && call.argRanges[0] && !ctx.partNames.has(name)) {
        add("partref-unknown", call.argRanges[0].from, call.argRanges[0].to, "error", m.partUnknown(name));
      }
    }
  }
  if (isPart) {
    for (const call of doc.includes) {
      const st = ctx.includes.get(includeKey(call));
      if (!st || st.treeMissing || !call.argRanges[0]) continue;
      const r = call.argRanges[0];
      if (!st.exists) add("include-missing", r.from, r.to, call.name === "TREEREF" ? "warning" : "error", m.includeMissing(call.args[0], st.path));
      else if (st.snippetFound === false && call.argRanges[1]) add("snippet-missing", call.argRanges[1].from, call.argRanges[1].to, "error", m.snippetMissing(call.args[1]));
    }
  }

  // ----- enumeration references
  if (ctx.fileKind === "task") {
    const counts: Record<string, number> = { EC: 0, EQ: 0, ER: 0 };
    for (const e of doc.enumerations) counts[e.kind]++;
    for (const call of doc.macros) {
      const kind = EREF_TO_ENUM[call.name];
      if (!kind || call.args.length !== 1) continue;
      const n = Number(call.args[0]);
      if (!Number.isInteger(n) || n < 1 || n > counts[kind]) {
        add("eref-range", call.from, call.to, "warning", m.erefRange(call.name, call.args[0], kind, counts[kind]));
      }
    }
  }

  // ----- glossary file
  if (ctx.fileKind === "glossary") {
    const terms = glossaryTerms(doc);
    for (const [name, ts] of duplicateNames(terms)) {
      for (const t of ts.slice(1)) add("glossary-duplicate", t.call.argRanges[0]?.from ?? t.from, t.call.argRanges[0]?.to ?? t.to, "error", m.glossaryDuplicate(name, ts[0].line + 1));
    }
    for (const t of outOfOrder(terms)) add("glossary-order", t.call.argRanges[0]?.from ?? t.from, t.call.argRanges[0]?.to ?? t.to, "warning", m.glossaryOrder(t.names[0] ?? ""));
  }

  // ----- top matter
  const tm = doc.topMatter;
  if (tm && isPart) {
    const entries = new Map(tm.entries.map((e) => [e.key, e]));
    const required = ctx.fileKind === "task" ? ["title", "timevalue", "difficulty"] : ["title"];
    for (const key of required) {
      if (!entries.has(key)) add("topmatter-missing", tm.sepFrom, tm.sepTo, "error", m.tmMissing(key));
    }
    const diff = entries.get("difficulty");
    if (diff && ctx.fileKind === "task" && !/^[1-4]$/.test(yamlScalar(diff.value))) {
      add("topmatter-difficulty", diff.valueFrom, Math.max(diff.valueTo, diff.valueFrom + 1), "error", m.tmDifficulty(yamlScalar(diff.value)));
    }
    const tv = entries.get("timevalue");
    if (tv && ctx.fileKind === "task" && !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(yamlScalar(tv.value))) {
      add("topmatter-timevalue", tv.valueFrom, Math.max(tv.valueTo, tv.valueFrom + 1), "error", m.tmTimevalue(yamlScalar(tv.value)));
    }
    const stage = entries.get("stage");
    if (stage && ctx.stages.length) {
      const first = yamlScalar(stage.value).split(/\s+/)[0];
      if (first && !ctx.stages.includes(first)) add("topmatter-stage", stage.valueFrom, stage.valueFrom + first.length, "error", m.tmStage(first, ctx.stages));
    }
    const explains = entries.get("explains");
    if (explains) {
      if (ctx.fileKind === "chapter") add("topmatter-explains-chapter", explains.keyFrom, explains.keyTo, "warning", m.tmExplainsChapter);
      else if (ctx.glossaryNames) {
        for (const it of listItems(explains)) if (!ctx.glossaryNames.has(it.name)) add("topmatter-explains", it.from, it.to, "error", m.termUnknown(it.name));
      }
    }
    if (ctx.partNames) {
      for (const key of ["assumes", "requires"] as const) {
        const e = entries.get(key);
        if (!e) continue;
        for (const it of listItems(e)) if (!ctx.partNames.has(it.name)) add(key === "assumes" ? "topmatter-assumes" : "topmatter-requires", it.from, it.to, "error", m.partUnknown(it.name));
      }
    }
  }
  return out;
}

