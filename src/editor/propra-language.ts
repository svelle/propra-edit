// ProPra syntax support for CodeMirror: Markdown (with nested code languages) plus
// - top matter (YAML before the first `---` line, no opening `---`),
// - macro highlighting with block families, enumeration badges and block body tints,
// - folding for block macros and top matter.
// All of it is driven by the shared ProPraDoc model (parser.ts) held in a StateField.

import { Facet, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { foldNodeProp, foldService, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { parseMixed } from "@lezer/common";
import { tags as t } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { DEFAULT_PARSER_CONFIG, parseProPra, type Block, type MacroCall, type ParserConfig, type ProPraDoc } from "./parser";
import { ui } from "../i18n";

export interface ProPraFileInfo {
  /** Part files (tasks, index.md, glossary.md) have top matter. */
  topMatter: boolean;
  cfg: ParserConfig;
}

export const propraFileInfo = Facet.define<ProPraFileInfo, ProPraFileInfo>({
  combine: (values) => values[0] ?? { topMatter: false, cfg: DEFAULT_PARSER_CONFIG },
});

function parseState(state: EditorState): ProPraDoc {
  const info = state.facet(propraFileInfo);
  return parseProPra(state.doc.toString(), info.cfg, { topMatter: info.topMatter });
}

/** The current ProPraDoc of an editor state. */
export const propraDoc = StateField.define<ProPraDoc>({
  create: parseState,
  update(value, tr) {
    return tr.docChanged ? parseState(tr.state) : value;
  },
});

// ----- Markdown extension: top matter as a nested YAML region

const TOPMATTER_FIRST_LINE = /^([A-Za-z_][\w-]*[ \t]*:|---$|#|\s*$)/;

const topMatterMarkdown: MarkdownConfig = {
  defineNodes: [{ name: "TopMatter", block: true }],
  parseBlock: [
    {
      name: "TopMatter",
      before: "LinkReference",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !TOPMATTER_FIRST_LINE.test(line.text)) return false; // only at document start
        const start = cx.lineStart;
        let end = start + line.text.length;
        for (;;) {
          end = cx.lineStart + line.text.length;
          if (line.text === "---") {
            cx.nextLine();
            break;
          }
          if (!cx.nextLine()) break;
        }
        cx.addElement(cx.elt("TopMatter", start, end));
        return true;
      },
    },
  ],
  wrap: parseMixed((node) => (node.type.name === "TopMatter" ? { parser: yamlLanguage.parser } : null)),
};

// Markdown folds every block (each paragraph got a fold arrow). Keep folding for code blocks
// and tables; headings fold through Markdown's heading service, top matter and block macros
// through propraFolding below.
const FOLDABLE_BLOCKS = new Set(["FencedCode", "Table"]);
const quietFolding: MarkdownConfig = {
  props: [foldNodeProp.add((type) => (type.is("Block") && !type.is("Document") && !FOLDABLE_BLOCKS.has(type.name) ? () => null : undefined))],
};

// ----- Highlight style (colors come from CSS variables in styles.css)

const highlightStyle = HighlightStyle.define([
  { tag: t.heading1, class: "tok-heading tok-h1" },
  { tag: t.heading2, class: "tok-heading tok-h2" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], class: "tok-heading tok-h3" },
  { tag: t.emphasis, class: "tok-emphasis" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.strikethrough, class: "tok-strike" },
  { tag: t.link, class: "tok-link" },
  { tag: t.url, class: "tok-url" },
  { tag: t.monospace, class: "tok-mono" },
  { tag: t.quote, class: "tok-quote" },
  { tag: t.contentSeparator, class: "tok-list" }, // not t.list: it covers whole list items
  { tag: [t.processingInstruction, t.meta, t.documentMeta], class: "tok-meta" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], class: "tok-keyword" },
  { tag: [t.string, t.special(t.string), t.character], class: "tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "tok-number" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "tok-comment" },
  { tag: [t.propertyName, t.attributeName, t.labelName], class: "tok-property" },
  { tag: [t.typeName, t.className, t.namespace], class: "tok-type" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: "tok-function" },
  { tag: [t.angleBracket, t.tagName], class: "tok-tag" },
  { tag: t.invalid, class: "tok-invalid" },
]);

// ----- Decorations

class EnumBadge extends WidgetType {
  constructor(
    readonly kind: string,
    readonly n: number,
  ) {
    super();
  }
  eq(other: EnumBadge) {
    return other.kind === this.kind && other.n === this.n;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-pm-badge cm-pm-badge-${this.kind.toLowerCase()}`;
    el.textContent = String(this.n);
    el.title = ui.editor.enumBadge(this.kind, this.n);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const markCache = new Map<string, Decoration>();
const mark = (cls: string) => {
  let d = markCache.get(cls);
  if (!d) markCache.set(cls, (d = Decoration.mark({ class: cls })));
  return d;
};
const lineCache = new Map<string, Decoration>();
const lineDeco = (cls: string) => {
  let d = lineCache.get(cls);
  if (!d) lineCache.set(cls, (d = Decoration.line({ class: cls })));
  return d;
};

function callClass(call: MacroCall): string {
  const def = call.def;
  if (!def) return "cm-pm-macro cm-pm-unknown";
  if (def.kind === "inline") {
    if (call.name === "EC" || call.name === "EQ" || call.name === "ER") return "cm-pm-macro cm-pm-enum";
    if (call.name.startsWith("EREF")) return "cm-pm-macro cm-pm-eref";
    return "cm-pm-macro cm-pm-inline";
  }
  return `cm-pm-macro cm-pm-block cm-pm-fam-${def.family}`;
}

const REF_MACROS = new Set(["TERMREF", "TERMREF2", "PARTREF", "PARTREF2", "INCLUDE", "PROT", "SNIPPET", "TREEREF", "HREF"]);

function decorateCall(call: MacroCall, out: Range<Decoration>[], badges: Map<MacroCall, number>) {
  out.push(mark(callClass(call)).range(call.from, call.to));
  out.push(mark("cm-pm-delim").range(call.from, call.nameFrom));
  out.push(mark("cm-pm-name").range(call.nameFrom, call.nameTo));
  let pos = call.nameTo;
  call.argRanges.forEach((r, i) => {
    if (r.from > pos) out.push(mark("cm-pm-delim").range(pos, r.from));
    const isRef = REF_MACROS.has(call.name) && i === 0;
    if (r.to > r.from) out.push(mark(isRef ? "cm-pm-arg cm-pm-ref" : "cm-pm-arg").range(r.from, r.to));
    pos = r.to;
  });
  out.push(mark("cm-pm-delim").range(pos, call.to));
  const n = badges.get(call);
  if (n !== undefined) out.push(Decoration.widget({ widget: new EnumBadge(call.name, n), side: 1 }).range(call.to));
}

function lineClasses(doc: ProPraDoc, line: number): string {
  const classes: string[] = [];
  const tm = doc.topMatter;
  if (tm) {
    const sepLine = doc.lineStarts.indexOf(tm.sepFrom);
    if (line < sepLine) classes.push("cm-pm-tm");
    else if (line === sepLine) classes.push("cm-pm-tm cm-pm-tm-sep");
  }
  let inner: Block | undefined;
  let section: string | undefined;
  let inInstructor = false;
  for (const b of doc.blocks) {
    if (b.open.line > line) break;
    const lastLine = b.close ? b.close.line : b.bodyEndLine;
    if (line > lastLine) continue;
    if (b.family === "instructor") inInstructor = true;
    if (b.family === "section" && b.open.args[0]) section = b.open.args[0];
    if (line === b.open.line || (b.close && line === b.close.line)) {
      classes.push(`cm-pm-blockline cm-pm-blockline-${b.family}`);
    } else if (!inner || b.depth >= inner.depth) {
      inner = b;
    }
  }
  if (inner) classes.push(`cm-pm-body cm-pm-body-${inner.family}`);
  if (inInstructor) classes.push("cm-pm-in-instructor");
  if (section) classes.push(`cm-pm-sec cm-pm-sec-${/^[a-z]+$/.test(section) ? section : "other"}`);
  // stay monospace with a proportional prose font
  if (doc.fences.some((f) => line >= f.startLine && line <= f.endLine)) classes.push("cm-pm-code");
  else if (/^\s*\|/.test(doc.text.slice(doc.lineStarts[line], doc.lineStarts[line] + 200))) classes.push("cm-pm-table");
  const ls = doc.lineStarts[line];
  if (doc.macrosOff.some((r) => ls >= r.from && ls < r.to)) classes.push("cm-pm-off");
  return classes.join(" ");
}

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.field(propraDoc);
  const out: Range<Decoration>[] = [];
  const badges = new Map<MacroCall, number>();
  for (const e of doc.enumerations) badges.set(e.call, e.number);
  for (const { from, to } of view.visibleRanges) {
    const firstLine = view.state.doc.lineAt(from).number - 1;
    const lastLine = view.state.doc.lineAt(to).number - 1;
    for (let l = firstLine; l <= lastLine; l++) {
      const cls = lineClasses(doc, l);
      if (cls) out.push(lineDeco(cls).range(doc.lineStarts[l]));
    }
    for (const call of doc.macros) {
      if (call.to < from) continue;
      if (call.from > to) break;
      decorateCall(call, out, badges);
    }
    for (const r of doc.replacements) {
      if (r.to >= from && r.from <= to) out.push(mark("cm-pm-replacement").range(r.from, r.to));
    }
  }
  return Decoration.set(out, true);
}

const propraDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.startState.field(propraDoc) !== u.state.field(propraDoc)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ----- Folding

const propraFolding = foldService.of((state, lineStart, lineEnd) => {
  const doc = state.field(propraDoc, false);
  if (!doc) return null;
  const line = state.doc.lineAt(lineStart).number - 1;
  const tm = doc.topMatter;
  if (tm && line === 0 && tm.sepFrom > lineEnd) {
    return { from: lineEnd, to: tm.sepFrom - 1 };
  }
  for (const b of doc.blocks) {
    if (b.open.line > line) break;
    if (b.open.line === line && b.close && b.close.line > line + 1) {
      const lastBody = state.doc.line(b.close.line); // 1-based: the line before the close line
      return { from: lineEnd, to: lastBody.to };
    }
  }
  return null;
});

/** Everything needed to edit a ProPra file. */
export function propraLanguage(info: ProPraFileInfo): Extension {
  return [
    propraFileInfo.of(info),
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: info.topMatter ? [topMatterMarkdown, quietFolding] : [quietFolding],
    }),
    syntaxHighlighting(highlightStyle),
    propraDoc,
    propraDecorations,
    propraFolding,
  ];
}
