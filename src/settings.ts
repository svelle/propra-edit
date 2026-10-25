// App settings with defaults. Stored as one JSON file by the Rust core.

import { backend } from "./backend";

export interface Settings {
  courseRoot: string | null;
  openTabs: string[];
  activeTab: string | null;
  treeExpanded: string[];
  sidebarWidth: number;
  fontFamily: string;
  fontSize: number;
  softWrap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  courseRoot: null,
  openTabs: [],
  activeTab: null,
  treeExpanded: [],
  sidebarWidth: 300,
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
  fontSize: 14,
  softWrap: true,
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
