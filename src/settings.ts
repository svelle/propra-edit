// App settings with defaults. Stored as one JSON file by the Rust core.

import { backend } from "./backend";

export interface Settings {
  courseRoot: string | null;
  openTabs: string[];
  activeTab: string | null;
  treeExpanded: string[];
  sidebarWidth: number;
  rightPanelWidth: number;
  fontFamily: string;
  fontSize: number;
  softWrap: boolean;
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
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
  fontSize: 14,
  softWrap: true,
  showSolutions: true,
  solutionCollapsed: {},
  grammarEnabled: true,
  ltDisabledRules: ["WHITESPACE_RULE"],
  ltEnabledRules: [],
  ltJava: "",
  ltLibDir: "",
  silencedLints: {},
};

export async function loadSettings(): Promise<Settings> {
  const raw = await backend.getSettings().catch(() => ({}));
  return { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) };
}

let pending: number | undefined;
/** Debounced save; settings changes are frequent (tabs, tree state). */
export function saveSettings(s: Settings, immediate = false): Promise<void> | void {
  window.clearTimeout(pending);
  if (immediate) return backend.saveSettings({ ...s });
  pending = window.setTimeout(() => void backend.saveSettings({ ...s }).catch(() => {}), 300);
}
