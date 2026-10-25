// Markdown rendering with an approximation of sedrila's macros. Used for glossary definitions
// in hovers now; the full preview (Phase 6) builds on it.

import MarkdownIt from "markdown-it";
import { parseProPra, type MacroCall, type ParserConfig } from "../editor/parser";

const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function expandInline(call: MacroCall, counters: Record<string, number>): string | null {
  const [a, b] = call.args;
  switch (call.name) {
    case "TERMREF":
      return `<span class="pv-termref">${escapeHtml(a ?? "")}</span>`;
    case "TERMREF2":
      return `<span class="pv-termref">${escapeHtml(b?.startsWith("-") ? (a ?? "") + b.slice(1) : (b ?? ""))}</span>`;
    case "PARTREF":
      return `<span class="pv-partref">${escapeHtml(a ?? "")}</span>`;
    case "PARTREF2":
      return `<span class="pv-partref">${escapeHtml(b ?? "")}</span>`;
    case "HREF":
      return `<a href="${escapeHtml(a ?? "")}">${escapeHtml(a ?? "")}</a>`;
    case "EC":
    case "EQ":
    case "ER":
      counters[call.name] = (counters[call.name] ?? 0) + 1;
      return `<span class="pv-enum pv-enum-${call.name.toLowerCase()}">${counters[call.name]}</span>`;
    case "EREFC":
    case "EREFQ":
    case "EREFR":
      return `<span class="pv-enum pv-enum-${("E" + call.name.slice(4)).toLowerCase()}">${escapeHtml(a ?? "")}</span>`;
    default:
      return null;
  }
}

/** Render a Markdown fragment (no top matter); unknown or block macros stay visible as code. */
export function renderFragment(text: string, cfg: ParserConfig = { blockMacros: [] }): string {
  const doc = parseProPra(text, cfg, { topMatter: false });
  const counters: Record<string, number> = {};
  let out = "";
  let pos = 0;
  for (const call of doc.macros) {
    const html = expandInline(call, counters) ?? `<code class="pv-macro">${escapeHtml(text.slice(call.from, call.to))}</code>`;
    out += text.slice(pos, call.from) + html;
    pos = call.to;
  }
  out += text.slice(pos);
  return md.render(out);
}
