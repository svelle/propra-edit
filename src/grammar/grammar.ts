// Grammar and spell checking in the editor: chunks the document, asks the GrammarClient for
// results (asynchronously, never blocking typing), and turns them into lint diagnostics with
// quick fixes. Dictionary, ignore and rule settings are applied when rendering, so they take
// effect immediately without re-checking.

import { StateEffect, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { forceLinting, linter, type Action, type Diagnostic } from "@codemirror/lint";
import { propraDoc } from "../editor/propra-language";
import { de } from "../i18n/de";
import { GrammarClient, type ChunkMatch } from "./client";
import { buildMask, chunksOf, type Chunk } from "./mask";

export interface GrammarSettings {
  enabled: boolean;
  disabledRules: string[];
  enabledRules: string[];
}

export interface GrammarDeps {
  check(data: string, disabledRules: string[], enabledRules: string[]): Promise<string>;
  saveDictionary(words: string[]): void;
  saveSettings(s: GrammarSettings): void;
  /** Called when the number of pending checks may have changed. */
  onActivity?(): void;
}

/** Dispatched when new results arrive or settings change; makes the linter run again. */
export const grammarRefresh = StateEffect.define<null>();

const SEVERITY = { spelling: "error", grammar: "warning", style: "info" } as const;

/** Split names like "Commit (git)" or "Web-API" into the words a speller looks at. */
export function wordsOf(name: string): string[] {
  const words = new Set<string>([name]);
  for (const w of name.split(/[\s()|,/]+/)) {
    if (!w) continue;
    words.add(w);
    for (const p of w.split(/[-_]/)) if (p) words.add(p);
  }
  return [...words];
}

export class GrammarService {
  readonly client: GrammarClient;
  private dictionary = new Set<string>();
  private accepted = new Set<string>();
  private ignored = new Set<string>();
  private views = new Set<EditorView>();

  constructor(
    private deps: GrammarDeps,
    public settings: GrammarSettings,
  ) {
    this.client = new GrammarClient(
      (data) => this.deps.check(data, this.settings.disabledRules, this.settings.enabledRules),
      () => this.refresh(),
    );
  }

  setDictionary(words: string[]) {
    this.dictionary = new Set(words.map((w) => w.toLocaleLowerCase("de")));
    this.refresh();
  }

  /** Glossary terms and part names are accepted by the speller automatically. */
  setAcceptedNames(names: Iterable<string>) {
    const s = new Set<string>();
    for (const n of names) for (const w of wordsOf(n)) s.add(w.toLocaleLowerCase("de"));
    this.accepted = s;
    this.refresh();
  }

  updateSettings(s: GrammarSettings) {
    const rulesChanged = s.disabledRules.join() !== this.settings.disabledRules.join() || s.enabledRules.join() !== this.settings.enabledRules.join();
    this.settings = s;
    if (rulesChanged) this.client.clear();
    this.refresh();
  }

  isAccepted(word: string): boolean {
    const w = word.trim().toLocaleLowerCase("de");
    if (!w) return false;
    if (this.dictionary.has(w) || this.accepted.has(w)) return true;
    // inflected forms of glossary terms and part names: Commits, Branches, Repos, Shells
    for (const suffix of ["s", "es", "en", "n", "e"]) {
      if (w.length > suffix.length + 2 && w.endsWith(suffix) && this.accepted.has(w.slice(0, -suffix.length))) return true;
    }
    const parts = w.split(/[-_]/).filter(Boolean);
    return parts.length > 1 && parts.every((p) => this.dictionary.has(p) || this.accepted.has(p));
  }

  /** Re-run the linter of every attached view. */
  refresh() {
    this.deps.onActivity?.();
    for (const v of this.views) {
      v.dispatch({ effects: grammarRefresh.of(null) });
      forceLinting(v);
    }
  }

  private visible(chunk: Chunk, m: ChunkMatch): boolean {
    if (this.settings.disabledRules.includes(m.ruleId)) return false;
    if (this.ignored.has(`${chunk.key}|${m.rel}|${m.ruleId}`)) return false;
    if (m.category === "spelling" && this.isAccepted(m.word)) return false;
    return true;
  }

  private actions(chunk: Chunk, m: ChunkMatch): Action[] {
    const acts: Action[] = m.replacements.map((r) => ({
      name: r === "" ? de.grammar.remove : r,
      apply: (view, from, to) => view.dispatch({ changes: { from, to, insert: r } }),
    }));
    acts.push({
      name: de.grammar.ignore,
      apply: () => {
        this.ignored.add(`${chunk.key}|${m.rel}|${m.ruleId}`);
        this.refresh();
      },
    });
    if (m.category === "spelling") {
      acts.push({
        name: de.grammar.addToDictionary,
        apply: () => {
          this.dictionary.add(m.word.trim().toLocaleLowerCase("de"));
          this.deps.saveDictionary([...this.dictionary]);
          this.refresh();
        },
      });
    }
    acts.push({
      name: de.grammar.disableRule,
      apply: () => {
        this.updateSettings({ ...this.settings, disabledRules: [...this.settings.disabledRules, m.ruleId] });
        this.deps.saveSettings(this.settings);
      },
    });
    return acts;
  }

  private lint(view: EditorView): Diagnostic[] {
    if (!this.settings.enabled) return [];
    const state = view.state;
    const doc = state.field(propraDoc, false); // absent for non-Markdown files
    if (!doc) return [];
    const tree = ensureSyntaxTree(state, state.doc.length, 200);
    const mask = buildMask(doc.text, doc, tree);
    const chunks = chunksOf(mask, doc);
    const out: Diagnostic[] = [];
    const missing: Chunk[] = [];
    for (const c of chunks) {
      const res = this.client.get(c);
      if (!res) {
        missing.push(c);
        continue;
      }
      for (const m of res) {
        if (!this.visible(c, m)) continue;
        const from = c.from + m.rel;
        out.push({
          from,
          to: Math.max(from + m.len, from + 1),
          severity: SEVERITY[m.category],
          source: "LanguageTool",
          message: m.message,
          markClass: `cm-lt cm-lt-${m.category}`,
          renderMessage: () => {
            const el = document.createElement("div");
            el.className = "cm-lt-message";
            const msg = document.createElement("div");
            msg.textContent = m.message;
            const rule = document.createElement("div");
            rule.className = "cm-lt-rule";
            rule.textContent = `${m.ruleDescription} (${m.ruleId})`;
            el.append(msg, rule);
            return el;
          },
          actions: this.actions(c, m),
        });
      }
    }
    if (missing.length) {
      this.client.request(missing);
      this.deps.onActivity?.();
    }
    return out;
  }

  extension(): Extension {
    const service = this;
    return [
      linter((view) => this.lint(view), {
        delay: 400,
        needsRefresh: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(grammarRefresh))),
      }),
      ViewPlugin.fromClass(
        class {
          constructor(readonly view: EditorView) {
            service.views.add(view);
          }
          destroy() {
            service.views.delete(this.view);
          }
        },
      ),
    ];
  }
}
