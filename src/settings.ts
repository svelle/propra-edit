// App settings with defaults. Stored as one JSON file by the Rust core.

import { backend } from "./backend";

export type WrapMode = "column" | "window" | "off";

export interface Settings {
  courseRoot: string | null;
  openTabs: string[];
  activeTab: string | null;
  treeExpanded: string[];
  sidebarWidth: number;
  rightPanelWidth: number;
  previewVisible: boolean;
  previewWidth: number;
  /** Preview shows [INSTRUCTOR] blocks. */
  previewTutor: boolean;
  fontFamily: string;
  fontSize: number;
  /** Line wrapping: at `wrapColumn` characters, at the window width, or not at all. */
  wrapMode: WrapMode;
  wrapColumn: number;
  /** Prose in a proportional font (top matter, macros, code and tables stay monospace). */
  proportionalProse: boolean;
  proseFontFamily: string;
  /** Inline altdir solutions shown. */
  showSolutions: boolean;
  /** Collapsed solution boxes per file (key: path relative to the course root). */
  solutionCollapsed: Record<string, string[]>;
  grammarEnabled: boolean;
  ltDisabledRules: string[];
  ltEnabledRules: string[];
  /** Optional overrides for development: path to java and to the LanguageTool jar directory. */
  ltJava: string;
  ltLibDir: string;
  /** sedrila build command ({outdir} is replaced); empty = default. */
  buildCommand: string;
  /** Build output directory; empty = app cache directory. */
  buildOutDir: string;
  buildPanelHeight: number;
  gitPanelWidth: number;
  lintPanelHeight: number;
  /** git executable; empty = "git" from PATH. */
  gitPath: string;
  /** Lint ids silenced per file (key: file path relative to the course root). */
  silencedLints: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: Settings = {
  courseRoot: null,
  openTabs: [],
  activeTab: null,
  treeExpanded: [],
  sidebarWidth: 300,
  rightPanelWidth: 380,
  previewVisible: false,
  previewWidth: 520,
  previewTutor: true,
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
  fontSize: 14,
  wrapMode: "column",
  wrapColumn: 100,
  proportionalProse: true,
  proseFontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif',
  showSolutions: true,
  solutionCollapsed: {},
  grammarEnabled: true,
  ltDisabledRules: ["WHITESPACE_RULE"],
  ltEnabledRules: [],
  ltJava: "",
  ltLibDir: "",
  buildCommand: "",
  buildOutDir: "",
  buildPanelHeight: 260,
  gitPanelWidth: 360,
  lintPanelHeight: 160,
  gitPath: "",
  silencedLints: {},
};

export async function loadSettings(): Promise<Settings> {
  const raw = await backend.getSettings().catch(() => ({}));
  const r = raw as Partial<Settings> & { softWrap?: boolean };
  // before wrap modes there was only an on/off switch
  if (r.wrapMode === undefined && r.softWrap === false) r.wrapMode = "off";
  delete r.softWrap;
  return { ...DEFAULT_SETTINGS, ...r };
}

let pending: number | undefined;
/** Debounced save; settings changes are frequent (tabs, tree state). */
export function saveSettings(s: Settings, immediate = false): Promise<void> | void {
  window.clearTimeout(pending);
  if (immediate) return backend.saveSettings({ ...s });
  pending = window.setTimeout(() => void backend.saveSettings({ ...s }).catch(() => {}), 300);
}
