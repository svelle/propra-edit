import { StateEffect } from "@codemirror/state";

/** Dispatched when diagnostics should be recomputed (new LanguageTool results, settings changed). */
export const lintRefresh = StateEffect.define<null>();
