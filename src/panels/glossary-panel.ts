// Right-hand glossary panel: a term outline with search, a small editor showing one [TERM]
// block of glossary.md at a time (edits go straight into the glossary document), and the list
// of places that reference the term ("Wo verwendet?").

import type { ChangeSet, Extension, Text } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseProPra, type ParserConfig } from "../editor/parser";
import { setSlice, SliceHost, syncAnnotation } from "../editor/slice";
import { glossaryTerms, type GlossaryTerm } from "../glossary/model";
import { fuzzyFilter } from "../fuzzy";
import { de } from "../i18n/de";
import { h } from "../ui/dom";

export interface TermUsage {
  term: string;
  path: string;
  rel: string;
  line: number;
  kind: string;
}

export interface GlossaryPanelDeps {
  /** The current glossary document (from its tab), or null if no glossary is open. */
  masterDoc(): Text | null;
  applyToMaster(changes: ChangeSet): void;
  extensions(): Extension;
  parserConfig(): ParserConfig;
  usages(): Promise<TermUsage[]>;
  open(path: string, line: number): void;
  /** Called with a position in glossary.md when a term is picked (to sync the main editor). */
  picked(pos: number): void;
  closed(): void;
}

export class GlossaryPanel {
  readonly dom: HTMLElement;
  private host: SliceHost;
  private view: EditorView | null = null;
  private search = h("input", { type: "search", class: "rp-search", placeholder: de.glossary.search, spellcheck: "false" });
  private outline = h("div", { class: "rp-outline", role: "listbox" });
  private title = h("div", { class: "rp-term-title" });
  private editorHost = h("div", { class: "rp-editor" });
  private usagesList = h("div", { class: "rp-usages" });
  private current: string | null = null;
  visible = false;

  constructor(private deps: GlossaryPanelDeps) {
    this.host = new SliceHost((changes) => deps.applyToMaster(changes));
    this.search.addEventListener("input", () => this.renderOutline());
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.outline.querySelector<HTMLElement>(".rp-item")?.click();
    });
    const close = h("button", { class: "rp-close", title: de.common.close, "aria-label": de.common.close }, "×");
    close.addEventListener("click", () => this.hide());
    this.dom = h(
      "aside",
      { class: "rightpanel", hidden: true },
      h("div", { class: "rp-header" }, h("span", { class: "rp-heading" }, de.glossary.title), close),
      this.search,
      this.outline,
      this.title,
      this.editorHost,
      this.usagesList,
    );
  }

  private terms(): GlossaryTerm[] {
    const doc = this.view?.state.doc ?? this.deps.masterDoc();
    return doc ? glossaryTerms(parseProPra(doc.toString(), this.deps.parserConfig())) : [];
  }

  hasFocus(): boolean {
    return this.visible && this.dom.contains(document.activeElement);
  }

  /** Show the panel, optionally at a term (by any of its names) and cursor position. */
  show(name?: string, cursor?: number) {
    const master = this.deps.masterDoc();
    if (!master) return;
    this.visible = true;
    this.dom.hidden = false;
    if (!this.view) {
      const term = this.find(name) ?? this.terms()[0];
      this.view = this.host.createView(this.editorHost, master, term ? this.rangeOf(term) : { from: 0, to: 0 }, this.deps.extensions());
      this.current = term?.names[0] ?? null;
    }
    if (name) this.select(name, cursor);
    else this.renderAll();
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.dom.hidden = true;
    if (this.view) this.host.destroyView(this.view);
    this.view = null;
    this.deps.closed();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  private find(name?: string): GlossaryTerm | undefined {
    if (!name) return undefined;
    return this.terms().find((t) => t.names.includes(name));
  }

  private rangeOf(t: GlossaryTerm) {
    const doc = this.view?.state.doc ?? this.deps.masterDoc()!;
    const from = doc.lineAt(t.from).from;
    const endLine = doc.lineAt(t.to);
    return { from, to: Math.min(doc.length, endLine.to + 1) };
  }

  select(name: string, cursor?: number) {
    const t = this.find(name);
    if (!t || !this.view) return;
    this.current = t.names[0];
    const range = this.rangeOf(t);
    const pos = cursor ?? (t.term0 ? t.to : Math.min(t.bodyTo, t.bodyFrom + Math.max(0, this.view.state.doc.sliceString(t.bodyFrom, t.bodyTo).trimEnd().length)));
    this.view.dispatch({
      effects: [setSlice.of(range), EditorView.scrollIntoView(pos, { y: "center" })],
      selection: EditorSelection.cursor(Math.max(range.from, Math.min(pos, range.to))),
      annotations: syncAnnotation.of(true),
    });
    this.view.focus();
    this.deps.picked(t.from);
    this.renderAll();
  }

  /** The glossary changed outside the panel (main editor, reload). */
  pushExternal(changes: ChangeSet) {
    if (!this.view) return;
    if (changes.length !== this.view.state.doc.length) return this.reset();
    this.host.pushExternal(changes);
    this.renderOutline();
  }

  reset() {
    const master = this.deps.masterDoc();
    if (!this.view || !master) return;
    this.host.resetAll(master);
    if (this.current) this.select(this.current);
  }

  /** Called after the glossary text changed (from any side), to refresh outline and title. */
  refresh() {
    if (this.visible) this.renderOutline();
  }

  private renderAll() {
    this.renderOutline();
    this.renderTitle();
    void this.renderUsages();
  }

  private renderTitle() {
    const t = this.find(this.current ?? undefined);
    this.title.textContent = t ? (t.names.length > 1 ? `${t.names[0]} (${t.names.slice(1).join(", ")})` : t.names[0]) : de.glossary.noTerm;
  }

  private renderOutline() {
    const terms = this.terms();
    const items = fuzzyFilter(this.search.value, terms, (t) => t.names.join(" "), 400);
    this.outline.replaceChildren(
      ...items.map((t) => {
        const el = h("div", { class: `rp-item${t.names[0] === this.current ? " active" : ""}`, role: "option", title: t.names.join(" | ") }, t.names[0], t.names.length > 1 ? h("span", { class: "rp-syn" }, t.names.slice(1).join(", ")) : null);
        el.addEventListener("click", () => this.select(t.names[0]));
        return el;
      }),
    );
    this.outline.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  private async renderUsages() {
    const t = this.find(this.current ?? undefined);
    if (!t) {
      this.usagesList.replaceChildren();
      return;
    }
    let all: TermUsage[] = [];
    try {
      all = await this.deps.usages();
    } catch {
      /* no course */
    }
    const names = new Set(t.names);
    const hits = all.filter((u) => names.has(u.term));
    const header = h("div", { class: "rp-usages-title" }, de.glossary.usages(hits.length));
    const list = hits.map((u) => {
      const el = h("div", { class: "rp-usage", title: u.rel }, h("span", { class: "rp-usage-file" }, u.rel.replace(/^[^/]+\//, "")), h("span", { class: "rp-usage-line" }, u.kind === "explains" ? "explains" : `Z. ${u.line + 1}`));
      el.addEventListener("click", () => this.deps.open(u.path, u.line));
      return el;
    });
    this.usagesList.replaceChildren(header, ...list);
  }
}
