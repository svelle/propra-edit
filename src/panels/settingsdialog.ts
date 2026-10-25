// Settings dialog: course root, editor font and soft wrap.

import { de } from "../i18n/de";
import type { Settings } from "../settings";
import { h, showDialog } from "../ui/dom";

export interface SettingsResult {
  changeCourse: boolean;
  values: Pick<Settings, "fontFamily" | "fontSize" | "softWrap" | "grammarEnabled" | "ltDisabledRules" | "ltEnabledRules">;
}

export async function settingsDialog(s: Settings): Promise<SettingsResult | null> {
  const font = h("input", { type: "text", value: s.fontFamily, spellcheck: "false" });
  const size = h("input", { type: "number", min: 8, max: 40, value: s.fontSize });
  const wrap = h("input", { type: "checkbox" });
  wrap.checked = s.softWrap;
  const grammar = h("input", { type: "checkbox" });
  grammar.checked = s.grammarEnabled;
  const disabled = h("input", { type: "text", value: s.ltDisabledRules.join(", "), spellcheck: "false" });
  const enabled = h("input", { type: "text", value: s.ltEnabledRules.join(", "), spellcheck: "false" });
  const body = h(
    "div",
    { class: "form" },
    h("div", { class: "form-row" }, h("span", {}, de.settings.courseRoot), h("code", { class: "form-path" }, s.courseRoot ?? "–")),
    h("label", {}, de.settings.fontFamily, font),
    h("label", {}, de.settings.fontSize, size),
    h("label", { class: "checkbox" }, wrap, de.settings.softWrap),
    h("label", { class: "checkbox" }, grammar, de.settings.grammar),
    h("label", {}, de.settings.disabledRules, disabled),
    h("label", {}, de.settings.enabledRules, enabled),
    h("div", { class: "form-hint" }, de.settings.rulesHint),
  );
  const choice = await showDialog<"ok" | "cancel" | "course">({
    title: de.settings.title,
    body,
    buttons: [
      { label: `${de.settings.courseRoot} ${de.settings.change}`, value: "course" },
      { label: de.common.cancel, value: "cancel" },
      { label: de.common.ok, value: "ok", primary: true },
    ],
    cancelValue: "cancel",
  });
  if (choice === "cancel") return null;
  const n = Number(size.value);
  return {
    changeCourse: choice === "course",
    values: {
      fontFamily: font.value.trim() || s.fontFamily,
      fontSize: Number.isFinite(n) && n >= 8 && n <= 40 ? n : s.fontSize,
      softWrap: wrap.checked,
      grammarEnabled: grammar.checked,
      ltDisabledRules: splitList(disabled.value),
      ltEnabledRules: splitList(enabled.value),
    },
  };
}

function splitList(v: string): string[] {
  return v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
}
