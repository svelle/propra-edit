// Builds the CodeMirror extension set for one open file.

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, LanguageDescription } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { languages } from "@codemirror/language-data";
import { propraLanguage } from "./propra-language";
import { lintKeymap } from "@codemirror/lint";
import { quickFixKeymap } from "./quickfix";
import type { ParserConfig } from "./parser";

export const wrapCompartment = new Compartment();
export const languageCompartment = new Compartment();

export interface FileSetup {
  path: string;
  isMarkdown: boolean;
  topMatter: boolean;
  parserConfig: ParserConfig;
  softWrap: boolean;
  /** Extra extensions from the app (update listener, key bindings). */
  extra: Extension;
  /** Extra extensions for Markdown files only (grammar, lints, completion). */
  markdownExtra: Extension;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Language support for non-Markdown files (loaded lazily); resolves to [] if none fits. */
export async function loadOtherLanguage(path: string): Promise<Extension> {
  const desc = LanguageDescription.matchFilename(languages, fileName(path));
  if (!desc) return [];
  try {
    return await desc.load();
  } catch {
    return [];
  }
}

/** Extensions for small embedded editors (glossary panel, inline solutions). */
export function embeddedEditorExtensions(cfg: ParserConfig, topMatter: boolean, extra: Extension): Extension {
  return [
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSpecialChars(),
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...quickFixKeymap]),
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
    propraLanguage({ topMatter, cfg }),
    extra,
  ];
}

export function createState(text: string, setup: FileSetup): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      wrapCompartment.of(setup.softWrap ? EditorView.lineWrapping : []),
      languageCompartment.of(setup.isMarkdown ? propraLanguage({ topMatter: setup.topMatter, cfg: setup.parserConfig }) : []),
      setup.isMarkdown ? setup.markdownExtra : [],
      keymap.of([...quickFixKeymap, ...lintKeymap]),
      setup.extra,
    ],
  });
}
