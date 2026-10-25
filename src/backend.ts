// Typed bridge to the Rust core. Paths are opaque native strings produced by Rust;
// the frontend never builds paths by string concatenation.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PartKind = "chapter" | "taskgroup" | "task" | "zipdir";

export interface PartInfo {
  name: string;
  kind: PartKind;
  path: string;
  rel: string;
  title: string | null;
  stage: string | null;
  difficulty: string | null;
  timevalue: number | null;
  chapter: string | null;
  taskgroup: string | null;
  altdirPath: string | null;
  altdirExists: boolean;
  missing: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  rel: string;
  isDir: boolean;
}

export interface TaskgroupNode {
  part: PartInfo;
  tasks: PartInfo[];
  zipdirs: PartInfo[];
  files: FileEntry[];
}

export interface ChapterNode {
  part: PartInfo;
  taskgroups: TaskgroupNode[];
  zipdirs: PartInfo[];
}

export interface GlossaryTerm {
  names: string[];
  term0: boolean;
  line: number;
  endLine: number | null;
}

export interface CourseConfig {
  root: string;
  chapterdir: string;
  altdir: string | null;
  itreedir: string | null;
  stages: string[];
  blockMacros: { name: string; arity: number }[];
  sectionTypes: Record<string, string[]>;
  chapters: { name: string; taskgroups: string[] }[];
  /** All blockmacro_topmatter templates. */
  topmatter: Record<string, string>;
  baseresourcedir: string | null;
}

export interface BuildDone {
  id: number;
  code: number | null;
  elapsedMs: number;
  cancelled: boolean;
  error: string | null;
}

export interface CourseIndex {
  config: CourseConfig;
  chapters: ChapterNode[];
  glossary: FileEntry | null;
  glossaryTerms: GlossaryTerm[];
  topFiles: FileEntry[];
  includeFiles: FileEntry[];
  unconfigured: FileEntry[];
  duplicateNames: string[];
  altdirAvailable: boolean;
}

export interface TextFile {
  text: string;
  eol: "\n" | "\r\n";
  bom: boolean;
  mixedEol: boolean;
}

export interface LtStatus {
  state: "starting" | "ready" | "error" | "stopped";
  message: string | null;
}

export interface NewTaskPaths {
  task: string;
  altdir: string | null;
  template: string;
}

export const backend = {
  getSettings: () => invoke<Record<string, unknown>>("get_settings"),
  saveSettings: (value: Record<string, unknown>) => invoke<void>("save_settings", { value }),
  openCourse: (root: string) => invoke<CourseIndex>("open_course", { root }),
  refreshIndex: () => invoke<CourseIndex>("refresh_index"),
  readTextFile: (path: string) => invoke<TextFile>("read_text_file", { path }),
  writeTextFile: (path: string, text: string, eol: string, bom: boolean) =>
    invoke<void>("write_text_file", { path, text, eol, bom }),
  createFile: (path: string, text: string) => invoke<void>("create_file", { path, text }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  newTaskPaths: (chapter: string, taskgroup: string, name: string) =>
    invoke<NewTaskPaths>("new_task_paths", { chapter, taskgroup, name }),
  isCourseRoot: (dir: string) => invoke<boolean>("is_course_root", { dir }),
  checkIncludes: (context: string, queries: { macroName: string; arg: string; snippet?: string }[]) =>
    invoke<{ path: string | null; exists: boolean; treeMissing: boolean; snippetFound: boolean | null }[]>("check_includes", { context, queries }),
  termUsages: () => invoke<{ term: string; path: string; rel: string; line: number; kind: string }[]>("term_usages"),
  listIncludeDir: (context: string, partial: string, itreeMode: boolean) =>
    invoke<{ name: string; isDir: boolean }[]>("list_include_dir", { context, partial, itreeMode }),
  ltStatus: () => invoke<LtStatus>("lt_status"),
  ltRestart: () => invoke<void>("lt_restart"),
  ltCheck: (data: string, disabledRules: string[], enabledRules: string[]) =>
    invoke<string>("lt_check", { data, language: "de-DE", disabledRules, enabledRules }),
  courseCss: () => invoke<string>("course_css"),
  readLogs: () => invoke<{ dir: string; app: string; languagetool: string }>("read_logs"),
  openLogDir: () => invoke<void>("open_log_dir"),
  logFrontend: (level: "error" | "info", message: string) => invoke<void>("log_frontend", { level, message }),
  coursePath: (rel: string) => invoke<string>("course_path", { rel }),
  buildDefaultOutdir: () => invoke<string>("build_default_outdir"),
  buildStart: (command: string, outdir: string) => invoke<[number, string]>("build_start", { command, outdir }),
  buildCancel: () => invoke<boolean>("build_cancel"),
  sedrilaTest: (command: string) => invoke<string>("sedrila_test", { command }),
  openBuiltPage: (outdir: string, name: string) => invoke<string>("open_built_page", { outdir, name }),
  getDictionary: () => invoke<string[]>("get_dictionary"),
  saveDictionary: (words: string[]) => invoke<void>("save_dictionary", { words }),
};

export const events = {
  onFileChanged: (cb: (paths: string[]) => void): Promise<UnlistenFn> => listen<string[]>("file-changed", (e) => cb(e.payload)),
  onIndexChanged: (cb: (index: CourseIndex) => void): Promise<UnlistenFn> =>
    listen<CourseIndex>("index-changed", (e) => cb(e.payload)),
  onLtStatus: (cb: (s: LtStatus) => void): Promise<UnlistenFn> => listen<LtStatus>("lt-status", (e) => cb(e.payload)),
  onBuildLine: (cb: (l: { id: number; line: string }) => void): Promise<UnlistenFn> => listen<{ id: number; line: string }>("build-line", (e) => cb(e.payload)),
  onBuildDone: (cb: (d: BuildDone) => void): Promise<UnlistenFn> => listen<BuildDone>("build-done", (e) => cb(e.payload)),
  onIndexError: (cb: (msg: string) => void): Promise<UnlistenFn> => listen<string>("index-error", (e) => cb(e.payload)),
};
