// Per-file environment for lints, completion and hovers: course data and callbacks into the app.

import { Facet } from "@codemirror/state";
import type { FileKind, IncludeStatus } from "./structural";

export interface PartRef {
  name: string;
  title: string | null;
  rel: string;
  path: string;
  kind: string;
}

export interface TermRef {
  names: string[];
  line: number;
  term0: boolean;
}

export interface IncludeQuery {
  macroName: string;
  arg: string;
  snippet?: string;
}

export interface PropraEnv {
  path: string;
  fileKind: FileKind;
  stages(): string[];
  sectionTypes(): Record<string, string[]>;
  /** Part namespace; null if no course is open. */
  parts(): Map<string, PartRef> | null;
  /** Glossary names (every synonym) -> term; null if unknown. */
  glossary(): Map<string, TermRef> | null;
  glossaryPath(): string | null;
  checkIncludes(queries: IncludeQuery[]): Promise<IncludeStatus[]>;
  listDir(partial: string, itree: boolean): Promise<{ name: string; isDir: boolean }[]>;
  open(path: string, line?: number): void;
  silenced(): string[];
  silence(id: string): void;
}

export const propraEnv = Facet.define<PropraEnv, PropraEnv | null>({ combine: (v) => v[0] ?? null });
