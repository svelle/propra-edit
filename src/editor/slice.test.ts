import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { hiddenRanges, setSlice, sliceExtension, sliceField, syncAnnotation } from "./slice";

const DOC = "zeile 1\nzeile 2\n[TERM::X]\nText\n[ENDTERM]\nzeile 6\n";
function sliced() {
  const from = DOC.indexOf("[TERM");
  const to = DOC.indexOf("zeile 6");
  const st = EditorState.create({ doc: DOC, extensions: sliceExtension() });
  return st.update({ effects: setSlice.of({ from, to }) }).state;
}

describe("slice editor state", () => {
  it("hides the lines outside the slice", () => {
    const st = sliced();
    const ranges: [number, number][] = [];
    hiddenRanges(st).between(0, st.doc.length, (f, t) => void ranges.push([f, t]));
    expect(ranges.map(([f, t]) => DOC.slice(f, t))).toEqual(["zeile 1\nzeile 2", "zeile 6\n"]);
  });

  it("extends the slice when typing at its edges and inside", () => {
    let st = sliced();
    st = st.update({ changes: { from: st.field(sliceField)!.from, insert: "A" } }).state;
    st = st.update({ changes: { from: st.field(sliceField)!.to, insert: "B" } }).state;
    const r = st.field(sliceField)!;
    expect(st.doc.sliceString(r.from, r.to)).toBe("A[TERM::X]\nText\n[ENDTERM]\nB");
  });

  it("rejects local edits outside the slice but accepts replayed ones", () => {
    const st = sliced();
    expect(st.update({ changes: { from: 0, insert: "x" } }).state.doc.toString()).toBe(DOC);
    expect(st.update({ changes: { from: 0, insert: "x" }, annotations: syncAnnotation.of(true) }).state.doc.toString()).toBe("x" + DOC);
    // a replayed change before the slice moves the slice along
    const moved = st.update({ changes: { from: 0, insert: "xyz" }, annotations: syncAnnotation.of(true) }).state;
    const r = moved.field(sliceField)!;
    expect(moved.doc.sliceString(r.from, r.to)).toBe("[TERM::X]\nText\n[ENDTERM]\n");
  });
});
