// Preview panel: renders the active file roughly like sedrila would, inside a shadow root
// styled with the course's own CSS. Rendering is debounced; scrolling follows the editor's
// top visible source line via the data-line attributes the renderer emits.

import { parseProPra, type MacroCall, type ParserConfig } from "../editor/parser";
import { ui } from "../i18n";
import { escapeHtml, includeKeyOf, renderDocument, type IncludeContent } from "../preview/render";
import { h } from "../ui/dom";

export interface PreviewSource {
  path: string;
  text: string;
  /** Part files have top matter; include files do not. */
  topMatter: boolean;
}

export interface PreviewDeps {
  source(): PreviewSource | null;
  parserConfig(): ParserConfig;
  templates(): Record<string, string>;
  courseCss(): Promise<string>;
  /** Resolve INCLUDE/SNIPPET/PROT calls of `path` to file paths (null if not found). */
  resolve(path: string, calls: MacroCall[]): Promise<(string | null)[]>;
  /** File text, preferring unsaved editor content; null if missing. */
  readText(path: string): Promise<string | null>;
  openPart(name: string): void;
  openTerm(name: string): void;
  openUrl(url: string): void;
  /** Double-click in the preview: show this source line in the editor. */
  revealLine(line: number): void;
  tutorView: boolean;
  setTutorView(on: boolean): void;
  closed(): void;
}

/** Scope a page stylesheet to the shadow root: :root/html/body become the preview root. */
export function scopeCss(css: string): string {
  return css.replace(/(^|[\s,{}>+~(])(:root|html|body)(?=[\s,{.:[>+~)])/g, (_m, pre: string) => `${pre}.pv-root`);
}

const BASE_CSS = `
:host { display: block; height: 100%; }
.pv-root { min-height: 100%; box-sizing: border-box; padding: 0 18px 24px; }
.pv-root main { max-width: none; margin: 0; }
.pv-missing, .pv-unexpanded { color: #c00; font-style: italic; }
.pv-hide-instructor .blockmacro-instructor { display: none; }
pre.mermaid { background: none; border: none; }
.pv-flash { outline: 2px solid #f90; outline-offset: 2px; transition: outline-color 1s; }
.pv-note { margin-top: 32px; padding-top: 8px; border-top: 1px solid #8884; font-size: 12px; opacity: .7; }
a { cursor: pointer; }
`;

const MERMAID_CACHE = new Map<string, string>();
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let mermaidId = 0;

function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((m) => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
    return m.default;
  });
  return mermaidPromise;
}

export class PreviewPanel {
  readonly dom: HTMLElement;
  private shadow: ShadowRoot;
  private styleEl = document.createElement("style");
  private content = document.createElement("div");
  private tutorBox = h("input", { type: "checkbox" }) as HTMLInputElement;
  private timer: number | undefined;
  private generation = 0;
  private lastKey = "";
  private lines: { line: number; el: HTMLElement }[] = [];
  private syncLine = 0;
  private lastPath = "";
  visible = false;

  constructor(private deps: PreviewDeps) {
    const close = h("button", { class: "rp-close", title: ui.common.close, "aria-label": ui.common.close }, "×");
    close.addEventListener("click", () => this.hide());
    this.tutorBox.checked = deps.tutorView;
    this.tutorBox.addEventListener("change", () => {
      deps.setTutorView(this.tutorBox.checked);
      this.applyTutor();
    });
    const body = h("div", { class: "pv-host" });
    this.shadow = body.attachShadow({ mode: "open" });
    this.content.className = "pv-root";
    this.shadow.append(this.styleEl, this.content);
    this.dom = h(
      "aside",
      { class: "rightpanel preview-panel", hidden: true },
      h("div", { class: "rp-header" }, h("span", { class: "rp-heading" }, ui.preview.title), h("label", { class: "pv-tutor", title: ui.preview.tutorTitle }, this.tutorBox, ui.preview.tutor), close),
      body,
    );
    this.content.addEventListener("click", (e) => this.onClick(e));
    this.content.addEventListener("dblclick", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-line]");
      if (el) this.deps.revealLine(Number(el.dataset.line));
    });
    this.applyTutor();
  }

  async show() {
    this.visible = true;
    this.dom.hidden = false;
    this.styleEl.textContent = BASE_CSS + scopeCss(await this.deps.courseCss().catch(() => ""));
    this.lastKey = "";
    this.update(0);
  }

  hide() {
    this.visible = false;
    this.dom.hidden = true;
    this.deps.closed();
  }

  /** Re-read the course CSS and re-render (after file changes on disk). */
  invalidate() {
    this.lastKey = "";
    if (this.visible) void this.show();
  }

  /** Schedule a re-render (call on document changes and tab switches). */
  update(delay = 250) {
    if (!this.visible) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.render(), delay);
  }

  /** Scroll so that the element for `line` (the editor's top visible line) is at the top; Infinity = end. */
  syncTo(line: number) {
    this.syncLine = line;
    if (!this.visible || !this.lines.length) return;
    const scroller = this.shadow.host as HTMLElement;
    if (line === Infinity) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    let i = 0;
    while (i + 1 < this.lines.length && this.lines[i + 1].line <= line) i++;
    const cur = this.lines[i];
    const next = this.lines[i + 1];
    const top = (el: HTMLElement) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    let y = top(cur.el);
    if (line < cur.line) y = 0;
    else if (next && next.line > cur.line) y += ((top(next.el) - y) * (line - cur.line)) / (next.line - cur.line);
    scroller.scrollTop = Math.max(0, y - 8);
  }

  private applyTutor() {
    this.content.classList.toggle("pv-hide-instructor", !this.tutorBox.checked);
  }

  private async includesFor(src: PreviewSource): Promise<Map<string, IncludeContent>> {
    const doc = parseProPra(src.text, this.deps.parserConfig(), { topMatter: src.topMatter });
    const calls = doc.includes.filter((c) => c.name !== "TREEREF" && c.def && c.args.length === c.def.arity);
    const result = new Map<string, IncludeContent>();
    if (!calls.length) return result;
    const paths = await this.deps.resolve(src.path, calls).catch(() => calls.map(() => null));
    await Promise.all(
      calls.map(async (call, i) => {
        const p = paths[i];
        const text = p ? await this.deps.readText(p).catch(() => null) : null;
        result.set(includeKeyOf(call), { text, path: p });
      }),
    );
    return result;
  }

  private async render() {
    const src = this.deps.source();
    const gen = ++this.generation;
    if (!src) {
      this.content.replaceChildren(h("p", { class: "pv-note" }, ui.preview.nothing));
      this.lines = [];
      return;
    }
    const includes = await this.includesFor(src);
    if (gen !== this.generation) return;
    const key = `${src.path}\0${src.text}\0${[...includes.values()].map((v) => v.text).join("\0")}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    let html: string;
    let title = "";
    let difficulty = "";
    try {
      const r = renderDocument(src.text, { cfg: this.deps.parserConfig(), templates: this.deps.templates(), topMatter: src.topMatter, includes });
      html = r.html;
      title = r.topMatter.title ?? "";
      difficulty = r.topMatter.difficulty ?? "";
    } catch (e) {
      html = `<p class="pv-missing">${escapeHtml(String(e))}</p>`;
    }
    const scroller = this.shadow.host as HTMLElement;
    const scrollTop = scroller.scrollTop;
    const open = [...this.content.querySelectorAll("details")].map((d) => d.open);
    const diffClass = difficulty ? ` pagetype-task-difficulty${escapeHtml(difficulty)}` : "";
    this.content.innerHTML =
      `<main>${title ? `<h1>${escapeHtml(title)}</h1>` : ""}<div id="taskbody" class="pagetype-task${diffClass}">${html}</div></main>` +
      `<p class="pv-note">${escapeHtml(ui.preview.approximate)}</p>`;
    this.content.querySelectorAll("details").forEach((d, i) => (d.open = open[i] ?? false));
    this.lines = [...this.content.querySelectorAll<HTMLElement>("[data-line]")]
      .map((el) => ({ line: Number(el.dataset.line), el }))
      .sort((a, b) => a.line - b.line);
    if (src.path !== this.lastPath) {
      this.lastPath = src.path;
      this.syncTo(this.syncLine);
    } else scroller.scrollTop = scrollTop;
    void this.renderMermaid(gen);
  }

  private async renderMermaid(gen: number) {
    const nodes = [...this.content.querySelectorAll<HTMLElement>("pre.mermaid")];
    if (!nodes.length) return;
    const pending = nodes.filter((n) => {
      const svg = MERMAID_CACHE.get(n.textContent ?? "");
      if (svg !== undefined) n.innerHTML = svg;
      return svg === undefined;
    });
    if (!pending.length) return;
    const mermaid = await loadMermaid().catch(() => null);
    if (!mermaid) return;
    for (const n of pending) {
      const code = n.textContent ?? "";
      let svg: string;
      try {
        svg = (await mermaid.render(`pv-mermaid-${++mermaidId}`, code)).svg;
      } catch (e) {
        svg = `<span class="pv-missing">${escapeHtml(ui.preview.mermaidError(String(e)))}</span>`;
      }
      MERMAID_CACHE.set(code, svg);
      if (gen === this.generation && n.isConnected) n.innerHTML = svg;
    }
  }

  private onClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.part) this.deps.openPart(a.dataset.part);
    else if (a.dataset.term) this.deps.openTerm(a.dataset.term);
    else {
      const href = a.getAttribute("href") ?? "";
      if (/^(https?|mailto):/i.test(href)) this.deps.openUrl(href);
    }
  }
}
