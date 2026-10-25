// Side-by-side diff of a file against HEAD (left: HEAD, right: current text incl. unsaved
// changes), read-only, unchanged stretches collapsed.

import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { de } from "../i18n/de";
import { h, showDialog } from "../ui/dom";

export async function showDiff(opts: { title: string; head: string | null; current: string; extensions?: Extension; open?: () => void }): Promise<void> {
  const ro: Extension = [EditorState.phrases.of({ "$ unchanged lines": de.git.unchangedLines }), lineNumbers(), EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false), opts.extensions ?? []];
  const host = h("div", { class: "diff-host" });
  const labels = h("div", { class: "diff-labels" }, h("span", {}, opts.head === null ? de.git.diffNew : de.git.diffHead), h("span", {}, de.git.diffCurrent));
  const same = opts.head === opts.current;
  const body = h("div", { class: "diff" }, same ? h("p", {}, de.git.diffSame) : labels, same ? null : host);
  let view: MergeView | null = null;
  const choice = await showDialog<"open" | "close">({
    title: opts.title,
    body,
    buttons: [...(opts.open ? [{ label: de.git.openFile, value: "open" as const }] : []), { label: de.common.close, value: "close" as const, primary: true }],
    cancelValue: "close",
    onOpen: (root) => {
      root.classList.add("dialog-wide");
      if (same) return;
      view = new MergeView({
        a: { doc: opts.head ?? "", extensions: ro },
        b: { doc: opts.current, extensions: ro },
        parent: host,
        collapseUnchanged: { margin: 3, minSize: 6 },
        highlightChanges: true,
        gutter: true,
      });
    },
  });
  (view as MergeView | null)?.destroy();
  if (choice === "open") opts.open?.();
}
