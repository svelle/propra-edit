// Preview rendering: markdown-it plus an approximation of sedrila's macro expansion.
//
// Like sedrila (framework/macros.py), expansion has two stages:
// - early: [INCLUDE] and [SNIPPET] insert raw text before Markdown is rendered (one level);
// - late: all other macros are replaced in the rendered HTML. Block macros on their own line
//   become <p>-wrapped placeholders; the <p>/</p> around them are fixed with sedrila's layout
//   rules so that sections, hints and blocks nest correctly.
// Block-level elements carry data-line (0-based source line) for scroll sync.

import MarkdownIt from "markdown-it";
import { parseProPra, type MacroCall, type ParserConfig } from "../editor/parser";

export interface IncludeContent {
  /** File text, or null if the file was not found. */
  text: string | null;
  /** Resolved path (for messages). */
  path: string | null;
}

export interface RenderContext {
  cfg: ParserConfig;
  /** blockmacro_topmatter templates from sedrila.yaml. */
  templates: Record<string, string>;
  topMatter: boolean;
  /** Contents for INCLUDE/SNIPPET/PROT calls, keyed by includeKeyOf(call). */
  includes: Map<string, IncludeContent>;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function includeKeyOf(call: MacroCall): string {
  return `${call.name}|${call.args[0] ?? ""}|${call.name === "SNIPPET" ? (call.args[1] ?? "") : ""}`;
}

const DROPPED_RE = /<!--\s*@LINK_SPEC:.*?-->[ \t]*\n?|<replacement +?id=['"][\w-]+?['"]\s*>|<\/replacement>/g;
const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";
const placeholder = (i: number) => `${PH_OPEN}${i}${PH_CLOSE}`;

function createMd(lineMap: number[] | null) {
  // like sedrila's "smarty" extension with smart_quotes off: -- and ... become dashes and ellipses
  const md = new MarkdownIt({ html: true, linkify: false, typographer: true });
  md.disable("smartquotes");
  const defaultFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    if (t.info.trim() === "mermaid") {
      const line = t.map && lineMap ? ` data-line="${lineMap[t.map[0]] ?? 0}"` : "";
      return `<pre class="mermaid"${line}>${escapeHtml(t.content)}</pre>\n`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };
  if (lineMap) {
    md.core.ruler.push("source_lines", (state) => {
      for (const t of state.tokens) {
        if (t.map && t.nesting >= 0 && t.block && t.type !== "html_block") t.attrSet("data-line", String(lineMap[t.map[0]] ?? 0));
      }
    });
  }
  return md;
}

/** Extract `SNIPPET::name` … `ENDSNIPPET` from a file (marker lines excluded). */
export function extractSnippet(text: string, name: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`SNIPPET::${name}(?![\\w])`).test(l) && !l.includes("ENDSNIPPET"));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.includes("ENDSNIPPET"));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

interface Late {
  call: MacroCall;
  /** Source line of the call (for included text: the line of the INCLUDE). */
  line: number;
}

/**
 * Early stage: replace INCLUDE/SNIPPET by file text and all other macros by placeholders.
 * Returns the text for Markdown and, for every output line, its source line.
 */
function earlyStage(text: string, from: number, firstLine: number, ctx: RenderContext, late: Late[], depth: number): { out: string; lines: number[] } {
  const doc = parseProPra(text, ctx.cfg, { topMatter: false });
  let out = "";
  const lines: number[] = [];
  let pos = from;
  let srcLine = firstLine;
  const emit = (s: string, src: number | null) => {
    // record a source line for every newline we emit
    for (const ch of s) if (ch === "\n") lines.push(src ?? srcLine);
    out += s;
  };
  const copyPlain = (s: string) => {
    for (const ch of s) {
      if (ch === "\n") {
        lines.push(srcLine);
        srcLine++;
      }
    }
    out += s;
  };
  // Like sedrila's preprocessor: drop @LINK_SPEC comments (with their newline) and keep the
  // content of <replacement> elements (no replacements file is loaded for author builds).
  const copySource = (to: number) => {
    const s = text.slice(pos, to);
    let last = 0;
    for (const m of s.matchAll(DROPPED_RE)) {
      copyPlain(s.slice(last, m.index));
      for (const ch of m[0]) if (ch === "\n") srcLine++;
      last = m.index + m[0].length;
    }
    copyPlain(s.slice(last));
    pos = to;
  };
  for (const call of doc.macros) {
    if (call.from < from) continue;
    copySource(call.from);
    const callLine = srcLine;
    if ((call.name === "INCLUDE" || call.name === "SNIPPET") && depth === 0 && call.def && call.args.length === call.def.arity) {
      const inc = ctx.includes.get(includeKeyOf(call));
      let body: string | null = inc?.text ?? null;
      if (body !== null && call.name === "SNIPPET") body = extractSnippet(body, call.args[1] ?? "");
      if (body === null) {
        late.push({ call, line: callLine });
        emit(placeholder(late.length - 1), callLine);
      } else {
        // macros inside included text are expanded too (one level of includes)
        const inner = earlyStage(body.replace(/\n$/, ""), 0, callLine, ctx, late, depth + 1);
        emit(inner.out, callLine);
      }
    } else {
      late.push({ call, line: depth === 0 ? callLine : firstLine });
      emit(placeholder(late.length - 1), callLine);
    }
    pos = call.to;
  }
  copySource(text.length);
  lines.push(srcLine);
  return { out, lines };
}

// sedrila inserts arguments into templates unescaped (str.format)
function fill(template: string, args: (string | undefined)[]): string {
  return template.replace(/\{arg1\}/g, args[0] ?? "").replace(/\{arg2\}/g, args[1] ?? "");
}

const PROMPT_RE = /^(.*?)([-+\w]+@[-+\w]+)\s+([/~]\S*)\s+(\d\d:\d\d:\d\d)\s+(\d+)(.*)$/;

/** Command protocol rendering, after sedrila's prot_html (without checking specifications). */
export function protHtml(content: string): string {
  const rows: string[] = [];
  let state: "prompt" | "output" = "output";
  let count = 0;
  for (const raw of content.replace(/^@(PROT|TEST)_SPEC[\s\S]*?(?=^\S)/gm, "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^@(PROT_SPEC|TEST_SPEC)\b/.test(line) || /^(command_re|output_re|skip|manual|extra|text)=/.test(line)) continue;
    const m = PROMPT_RE.exec(line);
    if (m) {
      count++;
      state = "prompt";
      rows.push(
        `<tr><td><span class='prot-counter prot-manual-color'>${count}.</span> <span class='vwr-front'>${escapeHtml(m[1])}</span> <span class='vwr-userhost'>${escapeHtml(m[2])}</span> <span class='vwr-dir'>${escapeHtml(m[3])}</span> <span class='vwr-time'>${escapeHtml(m[4])}</span> <span class='vwr-num'> ${escapeHtml(m[5])} </span> <span class='vwr-back'>${escapeHtml(m[6])}</span></td></tr>`,
      );
    } else if (state === "prompt") {
      rows.push(`<tr><td><span class='vwr-cmd'>${escapeHtml(line)}</span></td></tr>`);
      state = "output";
    } else {
      rows.push(`<tr><td><span class='vwr-output'>${escapeHtml(line)}</span></td></tr>`);
    }
  }
  return `\n<table class='vwr-table'>${rows.join("\n")}</table>\n`;
}

const DIFFICULTY_LEVELS = ["verylow", "low", "medium", "high"];

export function difficultySymbol(level: string): string {
  const n = Number(level);
  if (!(n >= 1 && n <= 4)) return "";
  return `<span class='difficulty${n}' title='Difficulty: ${DIFFICULTY_LEVELS[n - 1]}'>&#x26ab;&#xfe0e;</span>`;
}

function termHead(arg: string): string {
  const terms = arg.split("|");
  return `\n<div class='glossary-term-block'>\n<span class='glossary-term-heading'>${terms.join(" | ")}</span>\n\n</div>\n`;
}

type Mode = "inline" | "blockstart" | "blockend" | "block";

function expandLate(call: MacroCall, ctx: RenderContext, counters: Record<string, number>): { html: string; mode: Mode } {
  const a = call.args;
  const t = (k: string) => ctx.templates[k] ?? "";
  const def = call.def;
  if (!def || a.length !== def.arity) {
    return { html: `<span class="pv-unexpanded">${escapeHtml(call.name ? `[${call.name}${a.map((x) => `::${x}`).join("")}]` : "")}</span>`, mode: "inline" };
  }
  switch (call.name) {
    case "SECTION":
    case "INNERSECTION": {
      const [type, subs] = a;
      const subDivs = subs
        .split(",")
        .map((s) => `<div class='section-subtype section-${escapeHtml(type)}-${escapeHtml(s)}'>${t(`section_${type}_${s}`)}</div>`)
        .join("\n");
      return { html: `<section class='section section-${escapeHtml(type)}'>\n<div class='section-subtypes section-${escapeHtml(type)}-subtypes'>\n${subDivs}\n</div>\n${t(`section_${type}`)}`, mode: "blockstart" };
    }
    case "ENDSECTION":
    case "ENDINNERSECTION":
      return { html: "</section>", mode: "blockend" };
    case "HINT":
      return { html: `<details class='blockmacro blockmacro-hint'><summary>\n${fill(t("hint") || "{arg1}", a)}\n</summary>\n`, mode: "blockstart" };
    case "FOLDOUT":
      return { html: `<details class='blockmacro blockmacro-foldout'><summary>\n${a[0]}\n</summary>\n`, mode: "blockstart" };
    case "ENDHINT":
    case "ENDFOLDOUT":
      return { html: "</details>", mode: "blockend" };
    case "TERM":
      return { html: `${termHead(a[0])}\n<div class='glossary-term-body'>\n\n`, mode: "blockstart" };
    case "ENDTERM":
      return { html: "\n\n</div>\n", mode: "blockend" };
    case "TERM0":
      return { html: termHead(a[0]), mode: "block" };
    case "EC":
    case "EQ":
    case "ER":
      counters[call.name] = (counters[call.name] ?? 0) + 1;
      return { html: `<span class='enumeration-${call.name.toLowerCase()}'>${counters[call.name]}</span>`, mode: "inline" };
    case "EREFC":
    case "EREFQ":
    case "EREFR":
      return { html: `<span class='enumeration-${call.name.toLowerCase()}'>${escapeHtml(a[0])}</span>`, mode: "inline" };
    case "HREF":
      return { html: `<a href='${escapeHtml(a[0])}'>${escapeHtml(a[0])}</a>`, mode: "inline" };
    case "PARTREF":
    case "PARTREF2":
      return { html: `<a href='#' class='partref-link' data-part='${escapeHtml(a[0])}'>${escapeHtml(call.name === "PARTREF" ? a[0] : a[1])}</a>`, mode: "inline" };
    case "TERMREF":
    case "TERMREF2": {
      const label = call.name === "TERMREF" ? a[0] : a[1].startsWith("-") ? a[0] + a[1].slice(1) : a[1];
      return { html: `<a href='#' class='glossary-termref-term' data-term='${escapeHtml(a[0])}'>${escapeHtml(label)}<span class='glossary-termref-suffix'></span></a>`, mode: "inline" };
    }
    case "TREEREF":
      return { html: `<span class='treeref-prefix'></span><span class='treeref'>${escapeHtml(a[0])}</span><span class='treeref-suffix'></span>`, mode: "inline" };
    case "DIFF":
      return { html: difficultySymbol(a[0]), mode: "inline" };
    case "TOC":
      return { html: "<!--pv-toc-->", mode: "block" };
    case "PROT": {
      const inc = ctx.includes.get(includeKeyOf(call));
      if (!inc || inc.text === null) return { html: `\n<p class='pv-missing'>((‘${escapeHtml(inc?.path ?? a[0])}’ not found))</p>\n`, mode: "block" };
      return { html: protHtml(inc.text), mode: "block" };
    }
    case "INCLUDE":
    case "SNIPPET": {
      const inc = ctx.includes.get(includeKeyOf(call));
      return { html: `<span class='pv-missing'>((${escapeHtml(call.name)} ‘${escapeHtml(inc?.path ?? a[0])}’ not found))</span>`, mode: "inline" };
    }
  }
  // user-defined block macros (INSTRUCTOR, NOTICE, WARNING, …)
  if (def.kind === "blockstart") return { html: `<div class='blockmacro blockmacro-${call.name.toLowerCase()}'>\n${fill(t(call.name), a)}`, mode: "blockstart" };
  if (def.kind === "blockend") return { html: "</div>", mode: "blockend" };
  return { html: escapeHtml(`[${call.name}]`), mode: "inline" };
}

/** sedrila's <p>-problem fix for block macro placeholders (see framework/macros.py). */
function fixParagraphs(mode: Mode, ppre: string, ppost: string): [string, string] {
  if (mode === "blockstart") {
    if (ppre === "<p>" && !ppost) return ["", "<p>"];
    if (!ppre && ppost === "</p>") return ["", ""];
    if (ppre === "<p>" && ppost === "</p>") return ["", ""];
  } else if (mode === "blockend") {
    if (!ppre && ppost === "</p>") return ["</p>", ""];
    if (ppre === "<p>" && !ppost) return ["", ""];
    if (ppre === "<p>" && ppost === "</p>") return ["", ""];
  } else if (mode === "block" && ppre === "<p>" && ppost === "</p>") {
    return ["", ""];
  }
  return [ppre, ppost];
}

function buildToc(html: string): string {
  const items = [...html.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => `<li class='toc-level${m[1]}'>${m[2].replace(/<[^>]+>/g, "")}</li>`);
  return items.length ? `<div class='toc'><ul>${items.join("")}</ul></div>` : "";
}

export interface TopMatterInfo {
  title?: string;
  difficulty?: string;
  timevalue?: string;
  stage?: string;
}

/** Render a whole file (task, index.md, glossary, include file) to HTML. */
export function renderDocument(text: string, ctx: RenderContext): { html: string; topMatter: TopMatterInfo } {
  const doc = parseProPra(text, ctx.cfg, { topMatter: ctx.topMatter });
  const info: TopMatterInfo = {};
  for (const e of doc.topMatter?.entries ?? []) {
    const v = e.value.replace(/\s#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (e.key === "title") info.title = v;
    else if (e.key === "difficulty") info.difficulty = v;
    else if (e.key === "timevalue") info.timevalue = v;
    else if (e.key === "stage") info.stage = v;
  }
  const firstLine = doc.topMatter ? doc.lineStarts.indexOf(doc.topMatter.sepFrom) + 1 : 0;
  const late: Late[] = [];
  const { out, lines } = earlyStage(text, doc.bodyFrom, firstLine, ctx, late, 0);
  const md = createMd(lines);
  let html = md.render(out);
  const counters: Record<string, number> = {};
  html = html.replace(new RegExp(`(<p[^>]*>)?${PH_OPEN}(\\d+)${PH_CLOSE}(</p>)?`, "g"), (_m, pre: string | undefined, idx: string, post: string | undefined) => {
    const item = late[Number(idx)];
    let { html: exp, mode } = expandLate(item.call, ctx, counters);
    if (mode === "blockstart") exp = exp.replace(/^(\s*<\w+)/, `$1 data-line="${item.line}"`);
    const ppre = pre ? "<p>" : "";
    const [a, b] = fixParagraphs(mode, ppre, post ?? "");
    // keep the original <p ...> (with data-line) wherever it ends up
    return (a === "<p>" && pre ? pre : a) + exp + (b === "<p>" ? (pre ?? "<p>") : b);
  });
  if (html.includes("<!--pv-toc-->")) html = html.replace(/<!--pv-toc-->/g, buildToc(html));
  return { html, topMatter: info };
}

/** Render a Markdown fragment (no top matter), e.g. a glossary definition for a hover. */
export function renderFragment(text: string, cfg: ParserConfig = { blockMacros: [] }, templates: Record<string, string> = {}): string {
  return renderDocument(text, { cfg, templates, topMatter: false, includes: new Map() }).html;
}
