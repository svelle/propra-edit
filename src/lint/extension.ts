// Structural lints as a CodeMirror lint source.

import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { linter, type Diagnostic } from "@codemirror/lint";
import { propraDoc } from "../editor/propra-language";
import { lintRefresh } from "../editor/refresh";
import { de } from "../i18n/de";
import { propraEnv } from "./env";
import { includeKey, structuralLints, type IncludeStatus } from "./structural";

export function structuralLinter(): Extension {
  return linter(
    async (view): Promise<Diagnostic[]> => {
      const env = view.state.facet(propraEnv);
      const doc = view.state.field(propraDoc, false);
      if (!env || !doc) return [];
      const includes = new Map<string, IncludeStatus>();
      const calls = doc.includes.filter((c) => c.def && c.args.length === c.def.arity);
      if (calls.length && env.parts()) {
        const unique = [...new Map(calls.map((c) => [includeKey(c), c])).values()];
        try {
          const res = await env.checkIncludes(unique.map((c) => ({ macroName: c.name, arg: c.args[0], snippet: c.name === "SNIPPET" ? c.args[1] : undefined })));
          unique.forEach((c, i) => includes.set(includeKey(c), res[i]));
        } catch {
          /* no course: include checks are skipped */
        }
      }
      const parts = env.parts();
      const glossary = env.glossary();
      const silenced = new Set(env.silenced());
      const findings = structuralLints(doc, {
        fileKind: env.fileKind,
        stages: env.stages(),
        sectionTypes: env.sectionTypes(),
        partNames: parts ? new Set(parts.keys()) : null,
        glossaryNames: glossary ? new Set(glossary.keys()) : null,
        includes,
      });
      return findings
        .filter((f) => !silenced.has(f.id))
        .map((f) => ({
          from: f.from,
          to: Math.max(f.to, f.from + 1),
          severity: f.severity,
          message: f.message,
          source: `ProPra: ${f.id}`,
          markClass: "cm-pm-lint",
          actions: [
            ...(f.id === "termref-unknown" || f.id === "topmatter-explains"
              ? [{ name: de.lint.createTerm, apply: (v: EditorView, from: number, to: number) => env.createTerm(v.state.sliceDoc(from, to)) }]
              : []),
            { name: de.lint.silence, apply: () => env.silence(f.id) },
          ],
        }));
    },
    { delay: 300, needsRefresh: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(lintRefresh))) },
  );
}
