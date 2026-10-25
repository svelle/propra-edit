import { describe, expect, it } from "vitest";
import { ChangeSet, EditorState, Text, type Transaction } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { propraLanguage } from "../editor/propra-language";
import { altdirChange, altdirEditSpec, altdirField, altdirStateExtension, numberingShift, renumberPlan, renumberTransaction } from "./state";
import { applyChanges } from "./segments";

const TASK = "title: T\ntimevalue: 1\ndifficulty: 1\n---\n[EQ] eins\n\n[EQ] zwei\n\n[EC] befehl\n\n[EQ] drei\n\n[INSTRUCTOR::x]\nSiehe [EREFQ::2] und [EREFQ::3].\n[ENDINSTRUCTOR]\n";
const ALT = "- [EREFQ::1] a\n- [EREFQ::2] b\n- [EREFQ::3] c, wie [EREFQ::2]\n- [EREFC::1] d\n";

function make() {
  return EditorState.create({
    doc: TASK,
    extensions: [history(), propraLanguage({ topMatter: true, cfg: { blockMacros: [{ name: "INSTRUCTOR", arity: 1 }] } }), altdirStateExtension({ path: "/alt/t.md", doc: Text.of(ALT.split("\n")), exists: true })],
  });
}

function run(state: EditorState, cmd: typeof undo): EditorState {
  let out = state;
  cmd({ state, dispatch: (tr: Transaction) => (out = tr.state) });
  return out;
}

describe("altdir state", () => {
  it("holds the solution document and applies solution edits", () => {
    let st = make();
    expect(st.field(altdirField)!.doc.toString()).toBe(ALT);
    st = st.update(altdirEditSpec(ChangeSet.of({ from: 0, insert: "Vorspann\n" }, ALT.length))).state;
    expect(st.field(altdirField)!.doc.toString()).toBe("Vorspann\n" + ALT);
  });

  it("reports no shift until an enumeration is inserted before others", () => {
    let st = make();
    expect(numberingShift(st)).toBeNull();
    // typing elsewhere does not matter
    st = st.update({ changes: { from: TASK.indexOf("eins"), insert: "!" } }).state;
    expect(numberingShift(st)).toBeNull();
    // new [EQ] before EQ 2
    st = st.update({ changes: { from: st.doc.toString().indexOf("[EQ] zwei"), insert: "[EQ] neu\n\n" } }).state;
    const shift = numberingShift(st)!;
    expect(shift.moved).toEqual([{ kind: "EQ", from: 2, to: 3 }]);
    expect([...shift.mapping.EQ!]).toEqual([[2, 3], [3, 4]]);
    expect(shift.mapping.EC).toBeUndefined();
  });

  it("renumbers task and solution file in one transaction that undo reverts in one step", () => {
    let st = make();
    st = st.update({ changes: { from: TASK.indexOf("[EQ] zwei"), insert: "[EQ] neu\n\n" } }).state;
    const before = st;
    const plan = renumberPlan(st)!;
    expect(applyChanges(st.field(altdirField)!.doc.toString(), plan.altdir)).toBe("- [EREFQ::1] a\n- [EREFQ::3] b\n- [EREFQ::4] c, wie [EREFQ::3]\n- [EREFC::1] d\n");
    st = renumberTransaction(st, plan).state;
    expect(st.doc.toString()).toContain("Siehe [EREFQ::3] und [EREFQ::4].");
    expect(st.field(altdirField)!.doc.toString()).toContain("- [EREFQ::4] c, wie [EREFQ::3]");
    expect(numberingShift(st)).toBeNull(); // accepted

    const undone = run(st, undo);
    expect(undone.doc.toString()).toBe(before.doc.toString());
    expect(undone.field(altdirField)!.doc.toString()).toBe(ALT);
    expect(numberingShift(undone)).not.toBeNull(); // the warning is back
    const redone = run(undone, redo);
    expect(redone.field(altdirField)!.doc.toString()).toBe(st.field(altdirField)!.doc.toString());
  });

  it("solution edits from the inline editors stay out of the task's undo history", () => {
    let st = make();
    st = st.update(altdirEditSpec(ChangeSet.of({ from: ALT.length, insert: "x" }, ALT.length))).state;
    st = st.update({ changes: { from: 0, insert: "y" } }).state;
    const undone = run(st, undo);
    expect(undone.doc.toString()).toBe(TASK);
    expect(undone.field(altdirField)!.doc.toString()).toBe(ALT + "x");
  });

  it("an undoable solution change (e.g. adding a solution) is reverted by undo", () => {
    let st = make();
    st = st.update({ effects: altdirChange.of(ChangeSet.of({ from: ALT.length, insert: "- [EREFQ::4] \n" }, ALT.length)) }).state;
    expect(run(st, undo).field(altdirField)!.doc.toString()).toBe(ALT);
  });
});
