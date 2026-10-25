// Cmd/Ctrl+. : a small menu with the quick fixes (lint actions) of all diagnostics at the cursor.

import { EditorView, type KeyBinding } from "@codemirror/view";
import { forEachDiagnostic, type Action, type Diagnostic } from "@codemirror/lint";
import { ui } from "../i18n";

interface Item {
  diagnostic: Diagnostic;
  action: Action;
  from: number;
  to: number;
}

export function quickFixAt(view: EditorView, pos: number): Item[] {
  const items: Item[] = [];
  forEachDiagnostic(view.state, (d, from, to) => {
    if (pos >= from && pos <= to) for (const action of d.actions ?? []) items.push({ diagnostic: d, action, from, to });
  });
  return items;
}

export function openQuickFix(view: EditorView): boolean {
  document.querySelector(".quickfix-menu")?.remove();
  const pos = view.state.selection.main.head;
  const items = quickFixAt(view, pos);
  const coords = view.coordsAtPos(pos);
  const menu = document.createElement("div");
  menu.className = "quickfix-menu";
  menu.setAttribute("role", "menu");
  menu.style.left = `${coords?.left ?? 100}px`;
  menu.style.top = `${(coords?.bottom ?? 100) + 4}px`;
  let sel = 0;
  const close = () => {
    menu.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    view.focus();
  };
  const run = (i: number) => {
    const it = items[i];
    close();
    if (it) it.action.apply(view, it.from, it.to);
  };
  const render = () => {
    menu.replaceChildren();
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "quickfix-empty";
      e.textContent = ui.quickFix.none;
      menu.append(e);
      return;
    }
    let lastDiag: Diagnostic | null = null;
    items.forEach((it, i) => {
      if (it.diagnostic !== lastDiag) {
        lastDiag = it.diagnostic;
        const h = document.createElement("div");
        h.className = "quickfix-header";
        h.textContent = it.diagnostic.message;
        menu.append(h);
      }
      const row = document.createElement("div");
      row.className = `quickfix-item${i === sel ? " selected" : ""}`;
      row.setAttribute("role", "menuitem");
      row.textContent = it.action.name;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        run(i);
      });
      menu.append(row);
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") sel = Math.min(sel + 1, items.length - 1);
    else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
    else if (e.key === "Enter") run(sel);
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (menu.isConnected) render();
  };
  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  render();
  document.body.append(menu);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  return true;
}

export const quickFixKeymap: KeyBinding[] = [{ key: "Mod-.", run: openQuickFix }];
