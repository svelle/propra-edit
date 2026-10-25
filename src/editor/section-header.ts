// Sticky header above the editor: the section (and heading, block) the top visible line is in,
// e.g. „Arbeitsschritte · Git initialisieren“. Clicking it jumps to the section start.

import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, showPanel, type Panel } from "@codemirror/view";
import { ui } from "../i18n";
import type { ProPraDoc } from "./parser";
import { propraDoc } from "./propra-language";

export interface HeaderInfo {
  /** Section type (goal, background, …) or null outside sections. */
  section: string | null;
  /** Line of the [SECTION] call (0-based), or the heading line if there is no section. */
  line: number;
  /** Last Markdown heading between the section start and the line. */
  heading: string | null;
  /** Enclosing [INSTRUCTOR]/[HINT]/… block name and its first argument. */
  block: string | null;
}

const HEADING_RE = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

/** What the header shows for a 0-based line (pure, for tests). */
export function headerAt(doc: ProPraDoc, line: number): HeaderInfo | null {
  let section: HeaderInfo["section"] = null;
  let start = -1;
  let block: string | null = null;
  let lastSectionEnd = -1;
  for (const b of doc.blocks) {
    if (b.open.line > line) break;
    const end = b.close ? b.close.line : b.bodyEndLine;
    if (line > end) {
      if (b.family === "section") lastSectionEnd = Math.max(lastSectionEnd, end);
      continue;
    }
    if (b.family === "section") {
      section = b.open.args[0] ?? null;
      start = b.open.line;
    } else {
      block = b.open.args[0] ? `${b.name}: ${b.open.args[0]}` : b.name;
    }
  }
  const bodyStart = doc.topMatter ? doc.lineStarts.indexOf(doc.topMatter.sepFrom) + 1 : 0;
  let heading: string | null = null;
  let headingLine = -1;
  // a heading from an earlier section does not describe text after its [ENDSECTION]
  for (let l = line; l >= Math.max(start, bodyStart, lastSectionEnd + 1); l--) {
    if (doc.fences.some((f) => l >= f.startLine && l <= f.endLine)) continue;
    const text = doc.text.slice(doc.lineStarts[l], (doc.lineStarts[l + 1] ?? doc.text.length + 1) - 1);
    const m = HEADING_RE.exec(text);
    if (m) {
      heading = m[1];
      headingLine = l;
      break;
    }
  }
  if (!section && !heading && !block) return null;
  return { section, line: start >= 0 ? start : headingLine, heading, block };
}

export function headerLabel(h: HeaderInfo): string {
  const parts = [h.section ? (ui.editor.sectionNames[h.section as keyof typeof ui.editor.sectionNames] ?? h.section) : null, h.heading, h.block];
  return parts.filter(Boolean).join("  ·  ");
}

function topLine(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 2);
  return view.state.doc.lineAt(block.from).number - 1;
}

function headerPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-section-header";
  let target = -1;
  let frame = 0;
  const update = () => {
    frame = 0;
    const doc = view.state.field(propraDoc, false);
    const line = topLine(view);
    const info = doc ? headerAt(doc, line) : null;
    // where the section line itself is visible, show the task title instead (fixed height:
    // the editor must not jump when the header changes)
    const show = info && info.line < line;
    const title = doc?.topMatter?.entries.find((e) => e.key === "title")?.value.replace(/^["']|["']$/g, "") ?? "";
    dom.textContent = show ? headerLabel(info) : title;
    dom.className = `cm-section-header${show ? "" : " empty"}${show && info.section ? ` cm-pm-sec-${info.section}` : ""}`;
    dom.title = show ? ui.editor.sectionHeaderTitle : "";
    target = show ? info.line : -1;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  dom.addEventListener("mousedown", (e) => {
    if (target < 0) return;
    e.preventDefault();
    const pos = view.state.doc.line(target + 1).from;
    view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 4 }) });
    view.focus();
  });
  view.scrollDOM.addEventListener("scroll", schedule, { passive: true });
  // layout may not be read while the view is being constructed or updated
  schedule();
  return {
    dom,
    top: true,
    update: (u) => {
      if (u.docChanged || u.geometryChanged || u.viewportChanged) schedule();
    },
    destroy: () => {
      view.scrollDOM.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    },
  };
}

export function sectionHeader(): Extension {
  return showPanel.of(headerPanel);
}
