// The active UI strings. `ui` is one object for the whole app: setLanguage() overwrites its
// contents in place, so every module sees the chosen language. Call it before building the UI.

import { de, type Strings } from "./de";
import { en } from "./en";

export type UiLanguage = "de" | "en";
export const UI_LANGUAGES: { id: UiLanguage; label: string }[] = [
  { id: "de", label: "Deutsch" },
  { id: "en", label: "English" },
];

function assign(target: Record<string, unknown>, src: Record<string, unknown>) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sub = (target[k] && typeof target[k] === "object" ? target[k] : (target[k] = {})) as Record<string, unknown>;
      assign(sub, v as Record<string, unknown>);
    } else target[k] = v;
  }
}

export const ui = {} as Strings;
assign(ui as unknown as Record<string, unknown>, de as unknown as Record<string, unknown>);
let current: UiLanguage = "de";

export function setLanguage(lang: UiLanguage) {
  current = lang === "en" ? "en" : "de";
  // reset to German first so keys an English table leaves empty (CodeMirror phrases) clear
  (ui as unknown as Record<string, unknown>).codemirror = {};
  assign(ui as unknown as Record<string, unknown>, de as unknown as Record<string, unknown>);
  if (current === "en") {
    (ui as unknown as Record<string, unknown>).codemirror = {};
    assign(ui as unknown as Record<string, unknown>, en as unknown as Record<string, unknown>);
  }
  document.documentElement.lang = current;
}

export function uiLanguage(): UiLanguage {
  return current;
}
