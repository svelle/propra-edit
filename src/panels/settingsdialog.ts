// Settings dialog: course root, editor font, soft wrap, grammar rules, sedrila build.

import { ui, UI_LANGUAGES } from "../i18n";
import type { Settings } from "../settings";
import { h, showDialog } from "../ui/dom";

export interface SettingsResult {
  changeCourse: boolean;
  values: Pick<Settings, "uiLanguage" | "fontFamily" | "fontSize" | "wrapMode" | "wrapColumn" | "proportionalProse" | "proseFontFamily" | "grammarEnabled" | "ltDisabledRules" | "ltEnabledRules" | "buildCommand" | "buildOutDir" | "gitPath">;
}

export interface SettingsDialogDeps {
  defaultOutDir(): Promise<string>;
  testSedrila(command: string): Promise<string>;
}

export async function settingsDialog(s: Settings, deps: SettingsDialogDeps): Promise<SettingsResult | null> {
  const font = h("input", { type: "text", value: s.fontFamily, spellcheck: "false" });
  const size = h("input", { type: "number", min: 8, max: 40, value: s.fontSize });
  const language = h("select", {}, ...UI_LANGUAGES.map((l) => h("option", { value: l.id }, l.label))) as HTMLSelectElement;
  language.value = s.uiLanguage;
  const proportional = h("input", { type: "checkbox" });
  proportional.checked = s.proportionalProse;
  const proseFont = h("input", { type: "text", value: s.proseFontFamily, spellcheck: "false" });
  const wrapMode = h("select", {}, h("option", { value: "column" }, ui.settings.wrapColumnMode), h("option", { value: "window" }, ui.settings.wrapWindow), h("option", { value: "off" }, ui.settings.wrapOff)) as HTMLSelectElement;
  wrapMode.value = s.wrapMode;
  const wrapColumn = h("input", { type: "number", min: 40, max: 400, value: s.wrapColumn });
  const syncWrap = () => ((wrapColumn as HTMLInputElement).disabled = wrapMode.value !== "column");
  wrapMode.addEventListener("change", syncWrap);
  syncWrap();
  const syncProse = () => ((proseFont as HTMLInputElement).disabled = !proportional.checked);
  proportional.addEventListener("change", syncProse);
  syncProse();
  const grammar = h("input", { type: "checkbox" });
  grammar.checked = s.grammarEnabled;
  const disabled = h("input", { type: "text", value: s.ltDisabledRules.join(", "), spellcheck: "false" });
  const enabled = h("input", { type: "text", value: s.ltEnabledRules.join(", "), spellcheck: "false" });
  const buildCmd = h("input", { type: "text", value: s.buildCommand, placeholder: ui.settings.buildCommandDefault, spellcheck: "false" });
  const outDir = h("input", { type: "text", value: s.buildOutDir, spellcheck: "false" });
  void deps.defaultOutDir().then((d) => (outDir.placeholder = d), () => {});
  const gitPath = h("input", { type: "text", value: s.gitPath, placeholder: "git", spellcheck: "false" });
  const testResult = h("div", { class: "form-hint" });
  const testBtn = h("button", { type: "button" }, ui.settings.testSedrila);
  testBtn.addEventListener("click", () => {
    testResult.textContent = ui.settings.testing;
    testResult.classList.remove("form-error");
    deps.testSedrila(buildCmd.value).then(
      (out) => (testResult.textContent = ui.settings.testOk(out.trim().split("\n").pop() ?? "")),
      (e) => {
        testResult.textContent = String(e);
        testResult.classList.add("form-error");
      },
    );
  });
  const body = h(
    "div",
    { class: "form" },
    h("div", { class: "form-row" }, h("span", {}, ui.settings.courseRoot), h("code", { class: "form-path" }, s.courseRoot ?? "–")),
    h("label", {}, ui.settings.language, language),
    h("label", {}, ui.settings.fontFamily, font),
    h("label", {}, ui.settings.fontSize, size),
    h("label", { class: "checkbox" }, proportional, ui.settings.proportionalProse),
    h("label", {}, ui.settings.proseFont, proseFont),
    h("div", { class: "form-row form-inline" }, h("label", {}, ui.settings.wrap, wrapMode), h("label", {}, ui.settings.wrapColumn, wrapColumn)),
    h("label", { class: "checkbox" }, grammar, ui.settings.grammar),
    h("label", {}, ui.settings.disabledRules, disabled),
    h("label", {}, ui.settings.enabledRules, enabled),
    h("div", { class: "form-hint" }, ui.settings.rulesHint),
    h("label", {}, ui.settings.buildCommand, buildCmd),
    h("div", { class: "form-hint" }, ui.settings.buildCommandHint),
    h("label", {}, ui.settings.buildOutDir, outDir),
    h("div", { class: "form-row" }, testBtn),
    testResult,
    h("label", {}, ui.git.gitPath, gitPath),
  );
  const choice = await showDialog<"ok" | "cancel" | "course">({
    title: ui.settings.title,
    body,
    buttons: [
      { label: ui.settings.changeCourse, value: "course" },
      { label: ui.common.cancel, value: "cancel" },
      { label: ui.common.ok, value: "ok", primary: true },
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
      uiLanguage: language.value as Settings["uiLanguage"],
      wrapMode: wrapMode.value as Settings["wrapMode"],
      wrapColumn: clampInt(Number(wrapColumn.value), 40, 400, s.wrapColumn),
      proportionalProse: proportional.checked,
      proseFontFamily: proseFont.value.trim() || s.proseFontFamily,
      grammarEnabled: grammar.checked,
      ltDisabledRules: splitList(disabled.value),
      ltEnabledRules: splitList(enabled.value),
      buildCommand: buildCmd.value.trim(),
      buildOutDir: outDir.value.trim(),
      gitPath: gitPath.value.trim(),
    },
  };
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function splitList(v: string): string[] {
  return v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
}
