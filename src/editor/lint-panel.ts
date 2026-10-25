// The problem list (CodeMirror's lint panel): toggled by the same command that opens it, and
// resizable by dragging its top edge. The height is shared by all editors (CSS variable).

import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { closeLintPanel, openLintPanel } from "@codemirror/lint";

export function isLintPanelOpen(view: EditorView): boolean {
  return !!view.dom.querySelector(".cm-panel-lint");
}

export function toggleLintPanel(view: EditorView): boolean {
  return isLintPanelOpen(view) ? closeLintPanel(view) : openLintPanel(view);
}

export function setLintPanelHeight(px: number) {
  document.documentElement.style.setProperty("--lint-panel-height", `${Math.round(px)}px`);
}

/** Adds a drag handle to the lint panel; `saved` is called with the new height after a drag. */
export function lintPanelExtras(saved: (px: number) => void): Extension {
  const grip = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        this.attach();
      }
      update() {
        this.attach();
      }
      attach() {
        const panel = this.view.dom.querySelector<HTMLElement>(".cm-panel-lint:not(.has-grip)");
        if (!panel) return;
        panel.classList.add("has-grip");
        const handle = document.createElement("div");
        handle.className = "cm-lint-grip";
        handle.addEventListener("pointerdown", (e) => {
          const list = panel.querySelector("ul");
          if (!list) return;
          e.preventDefault();
          handle.setPointerCapture(e.pointerId);
          const startY = e.clientY;
          const startH = list.getBoundingClientRect().height;
          const max = () => Math.max(80, this.view.dom.getBoundingClientRect().height - 120);
          const move = (ev: PointerEvent) => setLintPanelHeight(Math.min(max(), Math.max(48, startH - (ev.clientY - startY))));
          handle.addEventListener("pointermove", move);
          handle.addEventListener(
            "pointerup",
            () => {
              handle.removeEventListener("pointermove", move);
              saved(list.getBoundingClientRect().height);
              this.view.requestMeasure();
            },
            { once: true },
          );
        });
        panel.prepend(handle);
      }
    },
  );
  return [grip, Prec.high(keymap.of([{ key: "Mod-Shift-m", run: toggleLintPanel, preventDefault: true }]))];
}
