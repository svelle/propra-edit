// Editor state for inline altdir solutions:
// - altdirField: the solution document of the task, as part of the task's EditorState.
//   It changes only through the altdirChange effect, which undo/redo understand
//   (invertedEffects), so one transaction can change task and solution file together and be
//   undone in one step.
// - enumTrack: a stable identity for every [EC]/[EQ]/[ER] across edits (positions mapped
//   through changes) and the numbering at the last accepted point, to detect when inserting or
//   deleting an enumeration shifts the numbers that the solution file refers to.

import { ChangeSet, EditorState, Facet, MapMode, StateEffect, StateField, Text, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { propraDoc, propraFileInfo } from "../editor/propra-language";
import type { EnumKind } from "../editor/macros";
import { renumberChanges, type Renumbering, type TextChange } from "./segments";

export interface AltdirDoc {
  path: string;
  doc: Text;
  /** False while the solution file does not exist yet (created on save). */
  exists: boolean;
}

/** Initial solution document of a state (set when the tab is created). */
export const altdirInitial = Facet.define<AltdirDoc | null, AltdirDoc | null>({ combine: (v) => v[0] ?? null });

export const altdirChange = StateEffect.define<ChangeSet>();
/** Replace the whole solution document (load or reload from disk); not undoable. */
export const altdirLoad = StateEffect.define<AltdirDoc>();

export const altdirField = StateField.define<AltdirDoc | null>({
  create: (state) => state.facet(altdirInitial),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(altdirLoad)) value = e.value;
      else if (e.is(altdirChange) && value) value = { ...value, doc: e.value.apply(value.doc) };
    }
    return value;
  },
});

const invertAltdir = invertedEffects.of((tr) => {
  const out: StateEffect<ChangeSet>[] = [];
  let doc = tr.startState.field(altdirField, false)?.doc;
  if (!doc) return out;
  for (const e of tr.effects) {
    if (!e.is(altdirChange)) continue;
    out.unshift(altdirChange.of(e.value.invert(doc)));
    doc = e.value.apply(doc);
  }
  return out;
});

// ----- enumeration identity

export interface TrackedEnum {
  id: number;
  kind: EnumKind;
  pos: number;
}

export interface EnumTrack {
  entries: TrackedEnum[];
  /** id -> kind and number at the last accepted point (load, renumbering, "ignore"). */
  baseline: Map<number, { kind: EnumKind; n: number }>;
  nextId: number;
}

/** Accept the current numbering as the new baseline (after renumbering or "ignore"). */
export const acceptNumbering = StateEffect.define<null>();
/** Restore a previous baseline (the inverse of acceptNumbering, used by undo). */
const setBaseline = StateEffect.define<Map<number, { kind: EnumKind; n: number }>>();

const invertBaseline = invertedEffects.of((tr) =>
  tr.effects.some((e) => e.is(acceptNumbering) || e.is(setBaseline)) ? [setBaseline.of(tr.startState.field(enumTrack).baseline)] : [],
);

function numbersOf(entries: TrackedEnum[]): Map<number, { kind: EnumKind; n: number }> {
  const counters: Record<string, number> = { EC: 0, EQ: 0, ER: 0 };
  const m = new Map<number, { kind: EnumKind; n: number }>();
  for (const e of [...entries].sort((a, b) => a.pos - b.pos)) m.set(e.id, { kind: e.kind, n: ++counters[e.kind] });
  return m;
}

function fromDoc(state: EditorState, previous: TrackedEnum[], nextId: number): { entries: TrackedEnum[]; nextId: number } {
  const doc = state.field(propraDoc, false);
  if (!doc) return { entries: [], nextId };
  const byPos = new Map(previous.map((e) => [`${e.kind}@${e.pos}`, e]));
  const entries: TrackedEnum[] = [];
  for (const en of doc.enumerations) {
    const old = byPos.get(`${en.kind}@${en.call.from}`);
    entries.push(old ? { ...old, pos: en.call.from } : { id: nextId++, kind: en.kind, pos: en.call.from });
  }
  return { entries, nextId };
}

export const enumTrack = StateField.define<EnumTrack>({
  create(state) {
    const { entries, nextId } = fromDoc(state, [], 1);
    return { entries, baseline: numbersOf(entries), nextId };
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      const mapped: TrackedEnum[] = [];
      for (const e of value.entries) {
        const pos = tr.changes.mapPos(e.pos, 1, MapMode.TrackDel);
        if (pos !== null) mapped.push({ ...e, pos });
      }
      const { entries, nextId } = fromDoc(tr.state, mapped, value.nextId);
      next = { entries, baseline: value.baseline, nextId };
    }
    for (const e of tr.effects) {
      if (e.is(acceptNumbering)) next = { ...next, baseline: numbersOf(next.entries) };
      else if (e.is(setBaseline)) next = { ...next, baseline: e.value };
    }
    return next;
  },
});

export interface NumberingShift {
  mapping: Renumbering;
  /** Per kind: the old numbers that moved, for the warning text. */
  moved: { kind: EnumKind; from: number; to: number }[];
  /** Enumerations deleted since the baseline (their solutions keep their numbers). */
  removed: { kind: EnumKind; n: number }[];
}

export function numberingShift(state: EditorState): NumberingShift | null {
  const track = state.field(enumTrack, false);
  if (!track) return null;
  const current = numbersOf(track.entries);
  const mapping: Renumbering = {};
  const removed: { kind: EnumKind; n: number }[] = [];
  for (const [id, old] of track.baseline) {
    const now = current.get(id);
    if (!now) removed.push(old);
    else if (now.n !== old.n) (mapping[old.kind] ??= new Map()).set(old.n, now.n);
  }
  const moved: NumberingShift["moved"] = [];
  for (const kind of ["EC", "EQ", "ER"] as EnumKind[]) {
    const m = mapping[kind];
    if (!m || !m.size) continue;
    const olds = [...m.keys()];
    moved.push({ kind, from: Math.min(...olds), to: Math.max(...olds) });
  }
  if (!moved.length) return null;
  return { mapping, moved, removed };
}

export interface RenumberPlan {
  task: TextChange[];
  altdir: TextChange[];
}

/** The changes "Altdir umnummerieren" would make in the task and in the solution file. */
export function renumberPlan(state: EditorState): RenumberPlan | null {
  const shift = numberingShift(state);
  const alt = state.field(altdirField, false);
  if (!shift) return null;
  const cfg = state.facet(propraFileInfo).cfg;
  return {
    task: renumberChanges(state.doc.toString(), shift.mapping, cfg, state.facet(propraFileInfo).topMatter),
    altdir: alt ? renumberChanges(alt.doc.toString(), shift.mapping, cfg, false) : [],
  };
}

/** One transaction (one undo step) that applies a renumber plan to both documents. */
export function renumberSpec(state: EditorState, plan: RenumberPlan): TransactionSpec {
  const alt = state.field(altdirField, false);
  const effects: StateEffect<unknown>[] = [acceptNumbering.of(null)];
  if (alt && plan.altdir.length) effects.push(altdirChange.of(ChangeSet.of(plan.altdir, alt.doc.length)));
  return { changes: plan.task, effects, userEvent: "renumber" };
}

export function renumberTransaction(state: EditorState, plan: RenumberPlan) {
  return state.update(renumberSpec(state, plan));
}

/** Apply a change made in a solution editor to the task state (not part of the task's undo history). */
export function altdirEditSpec(changes: ChangeSet) {
  return { effects: altdirChange.of(changes), annotations: Transaction.addToHistory.of(false) };
}

export function altdirStateExtension(initial: AltdirDoc | null): Extension {
  return [altdirInitial.of(initial), altdirField, invertAltdir, enumTrack, invertBaseline];
}
