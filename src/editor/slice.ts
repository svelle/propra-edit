// Slice editors: an EditorView that holds a whole document but shows and edits only the range
// [from, to) of it. Everything else is hidden behind block decorations, cannot be entered, and
// cannot be changed from inside the view. Several slice views of the same document are kept in
// sync with each other and with a "master" (a tab's state or a state field) by a SliceHost.
//
// Used for the glossary side panel (one [TERM] block) and the inline altdir solutions.

import { Annotation, EditorState, RangeSet, StateEffect, StateField, Transaction, type ChangeSet, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

/** Marks transactions that replay changes made elsewhere (must not be forwarded again). */
export const syncAnnotation = Annotation.define<boolean>();

export interface SliceRange {
  from: number;
  to: number;
}

export const setSlice = StateEffect.define<SliceRange | null>();

export const sliceField = StateField.define<SliceRange | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSlice)) return e.value;
    if (!value || !tr.docChanged) return value;
    // typing at either edge of the slice extends it
    const from = tr.changes.mapPos(value.from, -1);
    const to = Math.max(from, tr.changes.mapPos(value.to, 1));
    return { from, to };
  },
});

class HiddenWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-slice-hidden";
    return el;
  }
}
const hidden = Decoration.replace({ block: true, widget: new HiddenWidget() });

export function hiddenRanges(state: EditorState): DecorationSet {
  const r = state.field(sliceField, false);
  if (!r) return Decoration.none;
  const doc = state.doc;
  const ranges = [];
  if (r.from > 0) {
    // lines before the slice: from 0 to the end of the line before `from`
    const firstVisible = doc.lineAt(Math.min(r.from, doc.length));
    if (firstVisible.from > 0) ranges.push(hidden.range(0, firstVisible.from - 1));
  }
  if (r.to < doc.length) {
    const lastVisible = doc.lineAt(Math.max(r.from, r.to - 1));
    if (lastVisible.to < doc.length) ranges.push(hidden.range(lastVisible.to + 1, doc.length));
  }
  return Decoration.set(ranges);
}

const hiddenField = StateField.define<DecorationSet>({
  create: hiddenRanges,
  update(value, tr) {
    return tr.docChanged || tr.effects.some((e) => e.is(setSlice)) ? hiddenRanges(tr.state) : value;
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f) as RangeSet<Decoration>)],
});

/** Local edits may only touch the visible slice (replayed changes are always accepted). */
const keepInsideSlice = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(syncAnnotation)) return tr;
  const r = tr.startState.field(sliceField, false);
  if (!r) return tr;
  let ok = true;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA < r.from || toA > r.to) ok = false;
  });
  return ok ? tr : [];
});

export function sliceExtension(): Extension {
  return [sliceField, hiddenField, keepInsideSlice];
}

/** Manages the slice views of one document. */
export class SliceHost {
  private views = new Set<EditorView>();

  /** `onLocal` applies a change made in one of the views to the master document. */
  constructor(private onLocal: (changes: ChangeSet, origin: EditorView) => void) {}

  createView(parent: HTMLElement, doc: string | Text, slice: SliceRange, extensions: Extension): EditorView {
    const view: EditorView = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [sliceExtension(), extensions] }),
      dispatchTransactions: (trs) => {
        view.update(trs);
        for (const tr of trs) {
          if (!tr.docChanged || tr.annotation(syncAnnotation)) continue;
          for (const other of this.views) if (other !== view) replay(other, tr.changes);
          this.onLocal(tr.changes, view);
        }
      },
    });
    view.dispatch({ effects: setSlice.of(slice), annotations: syncAnnotation.of(true) });
    this.views.add(view);
    return view;
  }

  destroyView(view: EditorView) {
    this.views.delete(view);
    view.destroy();
  }

  /** Apply a change made to the master (outside the slice views) to all views. */
  pushExternal(changes: ChangeSet) {
    for (const v of this.views) replay(v, changes);
  }

  /** Replace the content of all views (e.g. after a reload with different length). */
  resetAll(doc: Text) {
    for (const v of this.views) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc }, annotations: [syncAnnotation.of(true), Transaction.addToHistory.of(false)] });
    }
  }

  get size() {
    return this.views.size;
  }

  destroyAll() {
    for (const v of this.views) v.destroy();
    this.views.clear();
  }
}

export function replay(view: EditorView, changes: ChangeSet) {
  if (changes.length !== view.state.doc.length) return; // out of sync; caller resets
  view.dispatch({ changes, annotations: [syncAnnotation.of(true), Transaction.addToHistory.of(false)] });
}
