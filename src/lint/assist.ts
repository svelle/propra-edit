// Top matter and macro assistance: completion, hover tooltips, Cmd/Ctrl+click navigation.

import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, type Tooltip } from "@codemirror/view";
import { renderFragment } from "../preview/render";
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { buildMacroTable } from "../editor/macros";
import { propraDoc, propraFileInfo } from "../editor/propra-language";
import type { MacroCall } from "../editor/parser";
import { ui } from "../i18n";
import { propraEnv, type PartRef, type PropraEnv, type TermRef } from "./env";
import { listItems } from "./structural";

const TASK_KEYS = ["title", "timevalue", "difficulty", "stage", "explains", "assumes", "requires"];
const GROUP_KEYS = ["title", "stage", "explains"];
const CHAPTER_KEYS = ["title", "stage"];

function keysFor(env: PropraEnv): string[] {
  return env.fileKind === "task" ? TASK_KEYS : env.fileKind === "taskgroup" ? GROUP_KEYS : env.fileKind === "chapter" ? CHAPTER_KEYS : ["title"];
}

function partOptions(env: PropraEnv): Completion[] {
  const parts = env.parts();
  if (!parts) return [];
  return [...parts.values()].map((p) => ({ label: p.name, detail: p.title ?? undefined, type: p.kind === "task" ? "variable" : "namespace", info: p.rel }));
}

function termOptions(env: PropraEnv): Completion[] {
  const g = env.glossary();
  if (!g) return [];
  return [...g.entries()].map(([name, t]) => ({ label: name, detail: t.names[0] !== name ? `→ ${t.names[0]}` : undefined, type: "text" }));
}

/** Completion for the last comma-separated item before the cursor. */
function listCompletion(ctx: CompletionContext, valueBefore: string, options: Completion[]): CompletionResult | null {
  const last = valueBefore.split(",").pop() ?? "";
  const token = last.trimStart();
  return { from: ctx.pos - token.length, options, validFor: /^[^,]*$/ };
}

async function completePropra(ctx: CompletionContext): Promise<CompletionResult | null> {
  const env = ctx.state.facet(propraEnv);
  const doc = ctx.state.field(propraDoc, false);
  if (!env || !doc) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);

  // ----- top matter
  if (doc.topMatter && ctx.pos <= doc.topMatter.to) {
    const keyOnly = /^([A-Za-z_][\w-]*)?$/.exec(before);
    if (keyOnly) {
      const used = new Set(doc.topMatter.entries.map((e) => e.key));
      return {
        from: line.from,
        options: keysFor(env).filter((k) => !used.has(k)).map((k) => ({ label: k, type: "property", apply: `${k}: ` })),
        validFor: /^[\w-]*$/,
      };
    }
    const kv = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(before);
    if (!kv) return null;
    const [, key, value] = kv;
    if (key === "stage") return { from: ctx.pos - value.length, options: env.stages().map((s) => ({ label: s, type: "enum" })) };
    if (key === "difficulty") return { from: ctx.pos - value.length, options: ui.assist.difficulties.map((d, i) => ({ label: String(i + 1), detail: d, type: "enum" })) };
    if (key === "assumes" || key === "requires") return listCompletion(ctx, value, partOptions(env));
    if (key === "explains") return listCompletion(ctx, value, termOptions(env));
    return null;
  }

  // ----- macros
  const open = before.lastIndexOf("[");
  if (open === -1 || before.indexOf("]", open) !== -1) return null;
  const inner = before.slice(open + 1);
  const parts = inner.split("::");
  const name = parts[0];
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) && !(parts.length === 1 && name === "")) return null;
  if (parts.length === 1) {
    if (!name && !ctx.explicit) return null;
    const info = ctx.state.facet(propraFileInfo);
    const table = buildMacroTable(info.cfg.blockMacros);
    const options: Completion[] = [...table.values()].map((d) => ({
      label: d.name,
      type: d.kind === "inline" ? "function" : "keyword",
      detail: d.arity ? "::…".repeat(d.arity) : undefined,
      apply: d.arity ? `${d.name}::` : `${d.name}]`,
    }));
    return { from: ctx.pos - name.length, options, validFor: /^[A-Z0-9_]*$/ };
  }
  const argIndex = parts.length - 2;
  const partial = parts[parts.length - 1];
  const from = ctx.pos - partial.length;
  switch (name) {
    case "PARTREF":
    case "PARTREF2":
      return argIndex === 0 ? { from, options: partOptions(env), validFor: /^[^\]:]*$/ } : null;
    case "TERMREF":
    case "TERMREF2":
      return argIndex === 0 ? { from, options: termOptions(env), validFor: /^[^\]:]*$/ } : null;
    case "SECTION":
    case "INNERSECTION": {
      const types = env.sectionTypes();
      if (argIndex === 0) return { from, options: Object.keys(types).map((t) => ({ label: t, type: "enum", apply: `${t}::` })) };
      const subs = types[parts[1]] ?? [];
      const last = partial.split(",").pop() ?? "";
      return { from: ctx.pos - last.length, options: subs.map((s) => ({ label: s, type: "enum" })), validFor: /^[a-z]*$/ };
    }
    case "EREFC":
    case "EREFQ":
    case "EREFR": {
      const kind = "E" + name.slice(4);
      const n = doc.enumerations.filter((e) => e.kind === kind).length;
      return { from, options: Array.from({ length: n }, (_, i) => ({ label: String(i + 1), type: "constant" })) };
    }
    case "INCLUDE":
    case "PROT":
    case "SNIPPET":
    case "TREEREF": {
      if (argIndex !== 0) return null;
      const itree = name === "TREEREF";
      const slash = partial.lastIndexOf("/");
      const prefixLen = slash !== -1 ? slash + 1 : /^(ALT:|ITREE:)/.exec(partial)?.[0].length ?? 0;
      let entries: { name: string; isDir: boolean }[] = [];
      try {
        entries = await env.listDir(partial, itree);
      } catch {
        return null;
      }
      const options: Completion[] = entries.map((e) => ({ label: e.isDir ? `${e.name}/` : e.name, type: e.isDir ? "namespace" : "variable" }));
      if (!partial && !itree) options.unshift({ label: "ALT:", type: "keyword", detail: "altdir" }, { label: "ITREE:", type: "keyword", detail: "itreedir" }, { label: "/", type: "keyword", detail: "chapterdir" });
      return { from: from + prefixLen, options, validFor: /^[^/\]:]*$/ };
    }
  }
  return null;
}

// ----- targets under the cursor (hover and Cmd/Ctrl+click)

type Target = { kind: "part"; part: PartRef } | { kind: "term"; name: string; term: TermRef | undefined } | { kind: "include"; call: MacroCall };

function targetAt(state: EditorState, pos: number): { target: Target; from: number; to: number } | null {
  const env = state.facet(propraEnv);
  const doc = state.field(propraDoc, false);
  if (!env || !doc) return null;
  const parts = env.parts();
  const glossary = env.glossary();
  if (doc.topMatter && pos <= doc.topMatter.to) {
    for (const e of doc.topMatter.entries) {
      if (pos < e.valueFrom || pos > e.valueTo) continue;
      for (const it of listItems(e)) {
        if (pos < it.from || pos > it.to) continue;
        if ((e.key === "assumes" || e.key === "requires") && parts?.has(it.name)) return { target: { kind: "part", part: parts.get(it.name)! }, from: it.from, to: it.to };
        if (e.key === "explains") return { target: { kind: "term", name: it.name, term: glossary?.get(it.name) }, from: it.from, to: it.to };
      }
    }
    return null;
  }
  for (const call of doc.macros) {
    if (call.from > pos) break;
    if (pos > call.to) continue;
    const r = call.argRanges[0];
    if (!r || pos < call.from || pos > call.to) continue;
    if ((call.name === "PARTREF" || call.name === "PARTREF2") && parts?.has(call.args[0])) return { target: { kind: "part", part: parts.get(call.args[0])! }, from: r.from, to: r.to };
    if (call.name === "TERMREF" || call.name === "TERMREF2") return { target: { kind: "term", name: call.args[0], term: glossary?.get(call.args[0]) }, from: r.from, to: r.to };
    if (["INCLUDE", "PROT", "SNIPPET", "TREEREF"].includes(call.name)) return { target: { kind: "include", call }, from: r.from, to: r.to };
  }
  return null;
}

async function resolveInclude(env: PropraEnv, call: MacroCall) {
  const [st] = await env.checkIncludes([{ macroName: call.name, arg: call.args[0] ?? "", snippet: call.name === "SNIPPET" ? call.args[1] : undefined }]);
  return st;
}

function tooltipDom(title: string, ...lines: string[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "cm-pm-hover";
  const t = document.createElement("div");
  t.className = "cm-pm-hover-title";
  t.textContent = title;
  el.append(t);
  for (const l of lines) {
    const d = document.createElement("div");
    d.className = "cm-pm-hover-line";
    d.textContent = l;
    el.append(d);
  }
  return el;
}

const propraHover = hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
  const hit = targetAt(view.state, pos);
  const env = view.state.facet(propraEnv);
  if (!hit || !env) return null;
  const { target } = hit;
  let dom: HTMLElement;
  if (target.kind === "part") {
    dom = tooltipDom(target.part.title ?? target.part.name, target.part.rel, ui.assist.clickToOpen);
  } else if (target.kind === "term") {
    if (!target.term) return null;
    const term = target.term;
    const synonyms = term.names.filter((n) => n !== term.names[0]);
    dom = tooltipDom(term.names[0], synonyms.length ? ui.assist.synonyms(synonyms) : ui.assist.noSynonyms);
    const def = document.createElement("div");
    def.className = "cm-pm-hover-def";
    if (term.term0 || !term.body.trim()) def.textContent = ui.assist.term0;
    else def.innerHTML = renderFragment(term.body, view.state.facet(propraFileInfo).cfg);
    const edit = document.createElement("button");
    edit.className = "cm-pm-hover-edit";
    edit.textContent = ui.assist.editTerm;
    edit.addEventListener("click", () => env.openTerm(term.names[0]));
    dom.append(def, edit);
  } else {
    const st = await resolveInclude(env, target.call).catch(() => null);
    if (!st?.path) return null;
    dom = tooltipDom(st.exists ? ui.assist.includeTarget : ui.assist.includeMissing, st.path, st.exists ? ui.assist.clickToOpen : "");
  }
  return { pos: hit.from, end: hit.to, above: true, create: () => ({ dom }) };
});

const modClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) return false;
    const hit = targetAt(view.state, pos);
    const env = view.state.facet(propraEnv);
    if (!hit || !env) return false;
    e.preventDefault();
    const t = hit.target;
    if (t.kind === "part") env.open(t.part.path);
    else if (t.kind === "term") {
      if (t.term) env.openTerm(t.term.names[0]);
    } else void resolveInclude(env, t.call).then((st) => st?.exists && st.path && env.open(st.path));
    return true;
  },
});

/** F12: go to the definition of the part, term or include at the cursor. */
function goToDefinition(view: EditorView): boolean {
  const hit = targetAt(view.state, view.state.selection.main.head);
  const env = view.state.facet(propraEnv);
  if (!hit || !env) return false;
  const t = hit.target;
  if (t.kind === "part") env.open(t.part.path);
  else if (t.kind === "term") {
    if (t.term) env.openTerm(t.term.names[0]);
    else env.createTerm(t.name);
  } else void resolveInclude(env, t.call).then((st) => st?.exists && st.path && env.open(st.path));
  return true;
}

export function propraAssist(): Extension {
  return [autocompletion({ override: [completePropra], icons: false }), propraHover, modClick, keymap.of([{ key: "F12", run: goToDefinition }])];
}
