// Cmd/Ctrl+P quick open: fuzzy search over all parts and files by name and title.

import type { OpenableItem } from "../course";
import { fuzzyFilter } from "../fuzzy";
import { ui } from "../i18n";
import { h } from "../ui/dom";

export function quickOpen(items: OpenableItem[], open: (path: string) => void) {
  if (document.querySelector(".quickopen")) return;
  const prevFocus = document.activeElement as HTMLElement | null;
  const input = h("input", { type: "text", placeholder: ui.quickOpen.placeholder, spellcheck: "false" });
  const list = h("div", { class: "quickopen-list", role: "listbox" });
  const box = h("div", { class: "quickopen" }, input, list);
  const overlay = h("div", { class: "overlay overlay-top" }, box);
  let results: OpenableItem[] = [];
  let sel = 0;

  const close = (path?: string) => {
    overlay.remove();
    if (path) open(path);
    else prevFocus?.focus();
  };
  const render = () => {
    results = fuzzyFilter(input.value, items, (it) => `${it.label} ${it.title ?? ""}`, 50);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.replaceChildren(
      ...(results.length
        ? results.map((it, i) => {
            const row = h(
              "div",
              { class: `quickopen-item${i === sel ? " selected" : ""}`, role: "option" },
              h("span", { class: "qo-name" }, it.label),
              it.title ? h("span", { class: "qo-title" }, it.title) : null,
              h("span", { class: "qo-path" }, it.rel),
            );
            row.addEventListener("mousedown", (e) => {
              e.preventDefault();
              close(it.path);
            });
            return row;
          })
        : [h("div", { class: "quickopen-empty" }, ui.quickOpen.noResults)]),
    );
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => {
    sel = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") sel = Math.min(sel + 1, results.length - 1);
    else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
    else if (e.key === "Enter") return close(results[sel]?.path);
    else if (e.key === "Escape") return close();
    else return;
    e.preventDefault();
    render();
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  render();
  input.focus();
}
