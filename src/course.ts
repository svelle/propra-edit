// Frontend view of the CourseIndex: flat lists for quick open, the part namespace,
// and the decision whether a file has top matter.

import type { CourseIndex, PartInfo } from "./backend";
import type { ParserConfig } from "./editor/parser";

export interface OpenableItem {
  path: string;
  rel: string;
  /** Display name (part name or file name). */
  label: string;
  title: string | null;
  kind: "task" | "taskgroup" | "chapter" | "glossary" | "include" | "file";
  part?: PartInfo;
}

export function openableItems(index: CourseIndex): OpenableItem[] {
  const out: OpenableItem[] = [];
  const part = (p: PartInfo): OpenableItem => ({ path: p.path, rel: p.rel, label: p.name, title: p.title, kind: p.kind as OpenableItem["kind"], part: p });
  for (const ch of index.chapters) {
    if (!ch.part.missing) out.push(part(ch.part));
    for (const tg of ch.taskgroups) {
      if (!tg.part.missing) out.push(part(tg.part));
      for (const t of tg.tasks) out.push(part(t));
      for (const f of tg.files) out.push({ path: f.path, rel: f.rel, label: f.name, title: null, kind: "file" });
    }
  }
  if (index.glossary) out.push({ path: index.glossary.path, rel: index.glossary.rel, label: "glossary.md", title: "Glossar", kind: "glossary" });
  for (const f of index.includeFiles) out.push({ path: f.path, rel: f.rel, label: f.name, title: null, kind: "include" });
  for (const f of index.topFiles) out.push({ path: f.path, rel: f.rel, label: f.name, title: null, kind: "file" });
  return out;
}

/** All names in the global part namespace (chapters, taskgroups, tasks, zip dirs). */
export function partNames(index: CourseIndex): Set<string> {
  const names = new Set<string>();
  for (const ch of index.chapters) {
    names.add(ch.part.name);
    ch.zipdirs.forEach((z) => names.add(z.name));
    for (const tg of ch.taskgroups) {
      names.add(tg.part.name);
      tg.tasks.forEach((t) => names.add(t.name));
      tg.zipdirs.forEach((z) => names.add(z.name));
    }
  }
  return names;
}

/** The task whose altdir solution file is `path`. */
export function findTaskBySolution(index: CourseIndex, path: string): PartInfo | undefined {
  for (const ch of index.chapters) for (const tg of ch.taskgroups) for (const t of tg.tasks) if (t.altdirPath === path) return t;
  return undefined;
}

export function findPartByPath(index: CourseIndex, path: string): PartInfo | undefined {
  for (const ch of index.chapters) {
    if (ch.part.path === path) return ch.part;
    for (const tg of ch.taskgroups) {
      if (tg.part.path === path) return tg.part;
      const t = tg.tasks.find((x) => x.path === path);
      if (t) return t;
    }
  }
  return undefined;
}

const TOPMATTER_START = /^([A-Za-z_][\w-]*[ \t]*:|---\r?$)/;

/**
 * Whether a file is read with top matter. Part files always are (sedrila requires it);
 * include files and altdir files never; other Markdown files if they look like it.
 */
export function hasTopMatter(index: CourseIndex | null, path: string, text: string): boolean {
  if (!path.toLowerCase().endsWith(".md")) return false;
  if (index) {
    if (findPartByPath(index, path) || index.glossary?.path === path) return true;
    if (index.includeFiles.some((f) => f.path === path)) return false;
    if (index.config.altdir && path.startsWith(index.config.altdir)) return false;
  }
  return TOPMATTER_START.test(text) && /^---$/m.test(text);
}

export function parserConfigFor(index: CourseIndex | null): ParserConfig {
  return index ? { blockMacros: index.config.blockMacros } : { blockMacros: [] };
}

/** Part names: letters (incl. umlauts), digits, dash, underscore (sedrila naming conventions). */
export const PART_NAME_RE = /^[\p{L}\p{N}_-]+$/u;
