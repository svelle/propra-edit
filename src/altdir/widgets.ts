// Inline altdir solutions in the task editor: below the paragraph of each [EC]/[EQ]/[ER] a
// collapsible box with the matching solution segment, editable in place (slice editor on the
// solution document); a box at the end with orphaned solutions, the preamble and other parts;
// a whole-file box when the solution file has no EREF markers; "+ Lösung anlegen"; and a
// warning bar when inserting/deleting enumerations shifted the numbering.

import { ChangeSet, EditorSelection, Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, showPanel, ViewPlugin, WidgetType, type DecorationSet, type Panel, type ViewUpdate } from "@codemirror/view";
import { propraDoc } from "../editor/propra-language";
import type { ProPraDoc } from "../editor/parser";
import type { EnumKind } from "../editor/macros";
import { setSlice, sliceField, SliceHost, syncAnnotation, type SliceRange } from "../editor/slice";
import { ui } from "../i18n";
import { contentEnd, keyOf, pairSegments, segmentAltdir, solutionInsertion, type Segment } from "./segments";
import { acceptNumbering, altdirChange, altdirEditSpec, altdirField, altdirLoad, numberingShift, renumberPlan, renumberSpec, type RenumberPlan } from "./state";

export interface AltdirEnv {
  /** Extensions for the inline solution editors (language, grammar checking, …). */
  editorExtensions(): Extension;
  isCollapsed(key: string): boolean;
  setCollapsed(key: string, collapsed: boolean): void;
  showSolutions(): boolean;
  confirmRenumber(plan: RenumberPlan, state: EditorState): Promise<boolean>;
}

export const altdirEnv = Facet.define<AltdirEnv, AltdirEnv | null>({ combine: (v) => v[0] ?? null });

export const setSolutionsVisible = StateEffect.define<boolean>();
export const toggleCollapsed = StateEffect.define<string>();

interface UiState {
  visible: boolean;
  collapsed: Set<string>;
}

const uiField = StateField.define<UiState>({
  create(state) {
    const env = state.facet(altdirEnv);
    return { visible: env?.showSolutions() ?? true, collapsed: new Set() };
  },
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setSolutionsVisible)) v = { ...v, visible: e.value };
      else if (e.is(toggleCollapsed)) {
        const c = new Set(v.collapsed);
        if (c.has(e.value)) c.delete(e.value);
        else c.add(e.value);
        v = { ...v, collapsed: c };
      }
    }
    return v;
  },
});

/** Collapse state lives in the environment (persisted per file); the effect only triggers a redraw. */
function isCollapsed(state: EditorState, key: string): boolean {
  const env = state.facet(altdirEnv);
  return env ? env.isCollapsed(key) : state.field(uiField).collapsed.has(key);
}

// ----- solution editors

class SolutionController {
  host: SliceHost;
  main: EditorView | null = null;
  private views = new Map<string, EditorView>();
  private pendingFocus: { key: string; pos: number } | null = null;

  constructor(private env: AltdirEnv) {
    this.host = new SliceHost((changes) => this.main?.dispatch({ ...altdirEditSpec(changes), annotations: [syncAnnotation.of(true)] }));
  }

  mount(key: string, parent: HTMLElement, range: SliceRange, main: EditorView) {
    this.main = main;
    this.unmount(key);
    const alt = main.state.field(altdirField, false);
    if (!alt) return;
    const view = this.host.createView(parent, alt.doc, range, [
      this.env.editorExtensions(),
      keymap.of([{ key: "Escape", run: () => (main.focus(), true) }]),
      // the main editor must re-measure when an inline editor changes height
      EditorView.updateListener.of((u) => {
        if (u.heightChanged || u.geometryChanged) this.main?.requestMeasure();
      }),
    ]);
    this.views.set(key, view);
    requestAnimationFrame(() => main.requestMeasure());
    if (this.pendingFocus?.key === key) {
      const pos = Math.min(this.pendingFocus.pos, view.state.doc.length);
      this.pendingFocus = null;
      requestAnimationFrame(() => {
        view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true, annotations: syncAnnotation.of(true) });
        view.focus();
      });
    }
  }

  setRange(key: string, range: SliceRange) {
    const v = this.views.get(key);
    if (!v) return;
    const cur = v.state.field(sliceField, false);
    if (cur && cur.from === range.from && cur.to === range.to) return;
    v.dispatch({ effects: setSlice.of(range), annotations: syncAnnotation.of(true) });
  }

  /** Destroy the editors that live inside `dom` (a widget being removed). */
  unmountIn(dom: HTMLElement) {
    for (const [k, v] of this.views) {
      if (dom.contains(v.dom)) {
        this.host.destroyView(v);
        this.views.delete(k);
      }
    }
  }

  unmount(key: string) {
    const v = this.views.get(key);
    if (v) {
      this.host.destroyView(v);
      this.views.delete(key);
    }
  }

  focusLater(key: string, pos: number) {
    this.pendingFocus = { key, pos };
  }
}


const controllers = new WeakMap<HTMLElement, SolutionController>();
const controllerOf = (dom: HTMLElement) => controllers.get(dom);

const controllerFacet = Facet.define<SolutionController, SolutionController | null>({ combine: (v) => v[0] ?? null });

/** Forwards solution changes that did not come from the inline editors to them. */
const syncPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      const c = view.state.facet(controllerFacet);
      if (c) c.main = view;
    }
    update(u: ViewUpdate) {
      const c = u.state.facet(controllerFacet);
      if (!c) return;
      c.main = u.view;
      for (const tr of u.transactions) {
        if (tr.annotation(syncAnnotation)) continue;
        for (const e of tr.effects) {
          if (e.is(altdirChange)) c.host.pushExternal(e.value);
          else if (e.is(altdirLoad)) c.host.resetAll(e.value.doc);
        }
      }
    }
  },
);

interface Section {
  key: string;
  title: string;
  range: SliceRange;
}

class SolutionWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly title: string,
    readonly ranges: SliceRange[],
    readonly collapsed: boolean,
    readonly addable: { kind: EnumKind; n: number } | null,
    readonly sections: Section[] | null = null,
  ) {
    super();
  }

  private shape() {
    return `${this.key}|${this.collapsed}|${this.ranges.length}|${this.sections?.map((s) => s.key).join(",") ?? ""}|${!!this.addable}`;
  }

  eq(o: SolutionWidget) {
    return this.shape() === o.shape() && JSON.stringify(this.ranges) === JSON.stringify(o.ranges) && JSON.stringify(this.sections) === JSON.stringify(o.sections);
  }

  updateDOM(_dom: HTMLElement, view: EditorView): boolean {
    const prev = (_dom as HTMLElement & { solWidget?: SolutionWidget }).solWidget;
    if (!prev || prev.shape() !== this.shape()) return false;
    const c = view.state.facet(controllerFacet);
    this.editorKeys().forEach(([k, r]) => c?.setRange(k, r));
    (_dom as HTMLElement & { solWidget?: SolutionWidget }).solWidget = this;
    return true;
  }

  private editorKeys(): [string, SliceRange][] {
    if (this.sections) return this.sections.map((s) => [s.key, s.range]);
    return this.ranges.map((r, i) => [`${this.key}#${i}`, r]);
  }

  toDOM(view: EditorView) {
    const c = view.state.facet(controllerFacet);
    // outer element carries the spacing as padding: CodeMirror measures block widgets with
    // offsetHeight, which ignores margins
    const outer = document.createElement("div") as HTMLElement & { solWidget?: SolutionWidget };
    outer.className = `cm-sol-wrap${this.sections ? " cm-sol-end" : ""}`;
    outer.solWidget = this;
    if (c) controllers.set(outer, c);
    const dom = document.createElement("div");
    outer.append(dom);
    dom.className = `cm-sol${this.collapsed ? " collapsed" : ""}`;
    const head = document.createElement("div");
    head.className = "cm-sol-head";
    const toggle = document.createElement("button");
    toggle.className = "cm-sol-toggle";
    toggle.textContent = this.collapsed ? "▸" : "▾";
    toggle.title = this.collapsed ? ui.altdir.expand : ui.altdir.collapse;
    toggle.addEventListener("click", () => {
      view.state.facet(altdirEnv)?.setCollapsed(this.key, !this.collapsed);
      view.dispatch({ effects: toggleCollapsed.of(this.key) });
    });
    const title = document.createElement("span");
    title.className = "cm-sol-title";
    title.textContent = this.title;
    head.append(toggle, title);
    if (this.addable && !this.ranges.length) {
      const add = document.createElement("button");
      add.className = "cm-sol-add";
      add.textContent = ui.altdir.add;
      add.addEventListener("click", () => addSolution(view, this.addable!.kind, this.addable!.n));
      head.append(add);
    }
    dom.append(head);
    if (!this.collapsed && c) {
      for (const [k, r] of this.editorKeys()) {
        if (this.sections) {
          const st = document.createElement("div");
          st.className = "cm-sol-section-title";
          st.textContent = this.sections.find((s) => s.key === k)!.title;
          dom.append(st);
        }
        const host = document.createElement("div");
        host.className = "cm-sol-editor";
        dom.append(host);
        c.mount(k, host, r, view);
      }
    }
    return outer;
  }

  destroy(dom: HTMLElement) {
    controllerOf(dom)?.unmountIn(dom);
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return this.collapsed ? 28 : 28 + 22 * Math.max(1, this.ranges.length + (this.sections?.length ?? 0)) * 2;
  }
}

function addSolution(view: EditorView, kind: EnumKind, n: number) {
  const alt = view.state.field(altdirField, false);
  const c = view.state.facet(controllerFacet);
  if (!alt) return;
  const text = alt.doc.toString();
  const ins = solutionInsertion(text, segmentAltdir(text), kind, n);
  // focus the new solution's editor once it has been rendered
  c?.focusLater(`${keyOf(kind, n)}#0`, ins.cursor);
  view.dispatch({ effects: altdirChange.of(ChangeSet.of({ from: ins.from, insert: ins.insert }, alt.doc.length)), userEvent: "input.solution" });
}

/** End of the paragraph containing `line` (the last line before a blank line or block macro). */
function paragraphEnd(doc: ProPraDoc, line: number): number {
  const lines = doc.lineStarts;
  const textOf = (l: number) => doc.text.slice(lines[l], l + 1 < lines.length ? lines[l + 1] - 1 : doc.text.length);
  const blockLines = new Set(doc.macros.filter((m) => m.def && m.def.kind !== "inline" && m.aloneOnLine).map((m) => m.line));
  let l = line;
  while (l + 1 < lines.length && textOf(l + 1).trim() !== "" && !blockLines.has(l + 1)) l++;
  return l + 1 < lines.length ? lines[l + 1] - 1 : doc.text.length;
}

/** The visible part of a segment: without trailing blank lines. */
function segRange(text: string, s: Segment): SliceRange {
  const end = contentEnd(text, s);
  return { from: s.from, to: end > s.from ? end : s.to };
}

function buildDecorations(state: EditorState): DecorationSet {
  const alt = state.field(altdirField, false);
  const doc = state.field(propraDoc, false);
  if (!alt || !doc || !state.field(uiField).visible) return Decoration.none;
  const text = alt.doc.toString();
  const seg = segmentAltdir(text);
  const out: Range<Decoration>[] = [];
  const widget = (pos: number, w: SolutionWidget) => out.push(Decoration.widget({ widget: w, block: true, side: 1 }).range(pos));

  if (!seg.hasMarkers && text.trim() !== "") {
    // no EREF markers: show the whole file once, below the [INSTRUCTOR] that includes it
    const instr = doc.blocks.find((b) => b.name === "INSTRUCTOR" && b.close && doc.includes.some((c) => c.name === "INCLUDE" && /^ALT:/.test(c.args[0] ?? "") && c.from > b.open.from && c.to < b.close!.from));
    const pos = instr?.close ? instr.close.to : doc.text.length;
    widget(Math.min(pos, state.doc.length), new SolutionWidget("fallback", ui.altdir.wholeFile, [{ from: 0, to: text.length }], isCollapsed(state, "fallback"), null));
    return Decoration.set(out, true);
  }

  const enumKeys = new Set(doc.enumerations.map((e) => keyOf(e.kind, e.number)));
  const pairing = pairSegments(seg, enumKeys);
  for (const e of doc.enumerations) {
    const key = keyOf(e.kind, e.number);
    const segs = pairing.byKey.get(key) ?? [];
    widget(paragraphEnd(doc, e.call.line), new SolutionWidget(key, ui.altdir.title(e.kind, e.number), segs.map((s) => segRange(text, s)), isCollapsed(state, key), { kind: e.kind, n: e.number }));
  }
  const sections: Section[] = [];
  for (const s of seg.segments) {
    if (contentEnd(text, s) === s.from && s.kind !== "solution") continue; // blank
    if (s.kind === "preamble") sections.push({ key: "end:preamble", title: ui.altdir.preamble, range: segRange(text, s) });
    else if (s.kind === "other") sections.push({ key: `end:other@${s.from}`, title: ui.altdir.other, range: segRange(text, s) });
  }
  pairing.orphans.forEach((s, i) => sections.push({ key: `end:orphan:${s.key}#${i}`, title: ui.altdir.orphan(s.key!), range: segRange(text, s) }));
  if (sections.length) {
    // stable keys: other@pos changes when text above changes, so key "other" by order instead
    let o = 0;
    for (const s of sections) if (s.key.startsWith("end:other@")) s.key = `end:other#${o++}`;
    widget(state.doc.length, new SolutionWidget("end", ui.altdir.endBox, [], isCollapsed(state, "end"), null, sections));
  }
  return Decoration.set(out, true);
}

const decorationField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    const altChanged = tr.effects.some((e) => e.is(altdirChange) || e.is(altdirLoad) || e.is(toggleCollapsed) || e.is(setSolutionsVisible));
    return tr.docChanged || altChanged ? buildDecorations(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ----- renumbering warning bar

const shiftField = StateField.define<string | null>({
  create: (s) => shiftMessage(s),
  update: (v, tr) => (tr.docChanged || tr.effects.length ? shiftMessage(tr.state) : v),
  provide: (f) => showPanel.from(f, (msg) => (msg ? (view) => renumberPanel(view) : null)),
});

function shiftMessage(state: EditorState): string | null {
  if (!state.field(altdirField, false)) return null;
  const shift = numberingShift(state);
  if (!shift) return null;
  return ui.altdir.shifted(shift.moved.map((m) => (m.from === m.to ? `${m.kind} ${m.from}` : `${m.kind} ${m.from} bis ${m.to}`)).join(", "));
}

function renumberPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-renumber-bar";
  const msg = document.createElement("span");
  const fix = document.createElement("button");
  fix.className = "primary";
  fix.textContent = ui.altdir.renumber;
  fix.addEventListener("click", async () => {
    const plan = renumberPlan(view.state);
    const env = view.state.facet(altdirEnv);
    if (!plan || !env) return;
    const startState = view.state;
    if (!(await env.confirmRenumber(plan, startState))) return;
    if (view.state !== startState) return; // edited meanwhile; the bar stays and can be used again
    view.dispatch(renumberSpec(view.state, plan));
  });
  const ignore = document.createElement("button");
  ignore.textContent = ui.altdir.ignore;
  ignore.addEventListener("click", () => view.dispatch({ effects: acceptNumbering.of(null) }));
  dom.append(msg, fix, ignore);
  const render = (s: EditorState) => (msg.textContent = s.field(shiftField) ?? "");
  render(view.state);
  return { dom, top: true, update: (u) => render(u.state) };
}

export function altdirViewExtension(env: AltdirEnv): Extension {
  return [altdirEnv.of(env), controllerFacet.of(new SolutionController(env)), uiField, decorationField, syncPlugin, shiftField];
}

export { buildDecorations as buildSolutionDecorations };
