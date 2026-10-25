// Left sidebar: chapters > taskgroups > tasks, with titles, stage/difficulty badges and
// altdir markers; separate nodes for the glossary, _include and other files; a fuzzy filter.

import type { CourseIndex, FileEntry, PartInfo, TaskgroupNode } from "../backend";
import { openableItems, type OpenableItem } from "../course";
import { fuzzyFilter } from "../fuzzy";
import { ui } from "../i18n";
import { h } from "../ui/dom";

export interface FileTreeCallbacks {
  open(path: string): void;
  /** Called with (chapter, taskgroup) when the user selects something inside a taskgroup. */
  selectTaskgroup(chapter: string, taskgroup: string): void;
  expandedChanged(expanded: string[]): void;
  /** Open (or offer to create) the altdir solution file of a task. */
  openSolution(taskPath: string): void;
}

/** Git state of a file in the tree: own change and/or a changed altdir solution. */
export interface GitMark {
  code: "M" | "A" | "?" | "D" | "R" | "U" | null;
  alt: boolean;
}

export class FileTree {
  readonly dom: HTMLElement;
  private gitMarks = new Map<string, GitMark>();
  private list: HTMLElement;
  private filterInput: HTMLInputElement;
  private index: CourseIndex | null = null;
  private expanded: Set<string>;
  private activePath: string | null = null;

  constructor(
    private cb: FileTreeCallbacks,
    expanded: string[] = [],
  ) {
    this.expanded = new Set(expanded);
    this.filterInput = h("input", { type: "search", class: "tree-filter", placeholder: ui.tree.filter, spellcheck: "false" });
    this.filterInput.addEventListener("input", () => this.render());
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.list.querySelector<HTMLElement>(".tree-item[data-path]");
        first?.click();
      } else if (e.key === "Escape") {
        this.filterInput.value = "";
        this.render();
      }
    });
    this.list = h("div", { class: "tree", role: "tree" });
    this.dom = h("div", { class: "filetree" }, this.filterInput, this.list);
  }

  focusFilter() {
    this.filterInput.focus();
    this.filterInput.select();
  }

  setIndex(index: CourseIndex | null) {
    this.index = index;
    this.render();
  }

  setActive(path: string | null) {
    this.activePath = path;
    for (const el of this.list.querySelectorAll<HTMLElement>(".tree-item.active")) el.classList.remove("active");
    if (!path) return;
    const el = [...this.list.querySelectorAll<HTMLElement>(".tree-item[data-path]")].find((e) => e.dataset.path === path);
    if (el) {
      el.classList.add("active");
      el.scrollIntoView({ block: "nearest" });
    }
  }

  /** Expand the nodes leading to `path` (used when a file is opened from elsewhere). */
  reveal(part: PartInfo | undefined) {
    if (!part?.chapter) return;
    const keys = [`ch:${part.chapter}`];
    if (part.taskgroup) keys.push(`tg:${part.chapter}/${part.taskgroup}`);
    if (keys.some((k) => !this.expanded.has(k))) {
      keys.forEach((k) => this.expanded.add(k));
      this.cb.expandedChanged([...this.expanded]);
      this.render();
    }
  }

  private render() {
    this.list.replaceChildren();
    const index = this.index;
    if (!index) return;
    const q = this.filterInput.value.trim();
    if (q) this.renderFiltered(index, q);
    else this.renderTree(index);
    this.setActive(this.activePath);
    this.applyGitMarks();
  }

  setGitMarks(marks: Map<string, GitMark>) {
    this.gitMarks = marks;
    this.applyGitMarks();
  }

  private applyGitMarks() {
    for (const row of this.list.querySelectorAll<HTMLElement>(".tree-item[data-path]")) {
      row.classList.remove("git-M", "git-A", "git-new", "git-D", "git-R", "git-U");
      const cell = row.querySelector<HTMLElement>(".cell-git");
      const alt = row.querySelector<HTMLElement>(".altdir-marker");
      if (cell) cell.replaceChildren();
      if (alt) {
        alt.classList.remove("changed");
        alt.textContent = alt.classList.contains("yes") ? "L" : "";
        alt.title = alt.classList.contains("yes") ? ui.tree.hasAltdir : ui.tree.noAltdir;
      }
      const m = this.gitMarks.get(row.dataset.path!);
      if (!m) continue;
      if (m.code) {
        row.classList.add(`git-${m.code === "?" ? "new" : m.code}`);
        const letter = m.code === "?" ? "N" : m.code === "U" ? "!" : m.code;
        const title = m.code === "?" ? ui.git.markNew : m.code === "A" ? ui.git.markAdded : ui.git.markModified;
        cell?.append(h("span", { class: "git-mark", title }, letter));
      }
      if (m.alt && alt) {
        // a changed (possibly new) solution: "L*"
        alt.classList.add("changed");
        alt.textContent = "L*";
        alt.title = ui.git.markAlt;
      }
    }
  }

  private renderFiltered(index: CourseIndex, q: string) {
    const items = fuzzyFilter(q, openableItems(index), (it) => `${it.label} ${it.title ?? ""}`, 200);
    for (const it of items) this.list.append(this.itemRow(it, 0));
  }

  private group(key: string, label: Node | string, depth: number, fill: (container: HTMLElement) => void, extraClass = "", badges?: Node) {
    const open = this.expanded.has(key);
    const children = h("div", { class: "tree-children", role: "group", style: `--depth:${depth}` });
    const row = h("div", { class: `tree-item tree-group ${extraClass}`, role: "treeitem", "aria-expanded": String(open), style: `--depth:${depth}` }, h("span", { class: "twisty" }, open ? "▾" : "▸"), label, badges ?? emptyBadges());
    row.addEventListener("click", () => {
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      this.cb.expandedChanged([...this.expanded]);
      this.render();
    });
    const wrap = h("div", {}, row, children);
    if (open) fill(children);
    return wrap;
  }

  private partLabel(p: PartInfo) {
    // the name is what authors type in PARTREF/assumes; the title only when it adds something
    const showTitle = p.title && normalizeName(p.title) !== normalizeName(p.name);
    return h(
      "span",
      { class: "tree-label", title: p.title ? `${p.name}: ${p.title}` : p.name },
      h("span", { class: "tree-name" }, p.name),
      showTitle ? h("span", { class: "tree-title" }, p.title) : null,
      p.missing ? h("span", { class: "badge warn", title: ui.tree.missing }, "!") : null,
    );
  }

  /** Fixed, right-aligned columns: git · stage · difficulty · solution (aligned at every depth). */
  private badges(p: PartInfo) {
    const stage = p.stage ? p.stage.split(/\s/)[0] : "";
    const stageCell = stage
      ? h("span", { class: `badge stage stage-${/^[a-z]+$/.test(stage) ? stage : "other"}`, title: ui.tree.stage(p.stage!) }, stage)
      : p.kind === "task"
        ? h("span", { class: "stage-none", title: ui.tree.noStage }, "✓")
        : null;
    const d = Number(p.difficulty);
    const diffCell =
      d >= 1 && d <= 4
        ? h("span", { class: `diff-dots difficulty${d}`, title: ui.tree.difficulty(d) }, "●".repeat(d) + "○".repeat(4 - d))
        : p.difficulty
          ? h("span", { class: "badge warn", title: ui.tree.difficulty(Number.NaN) }, p.difficulty)
          : null;
    const altCell =
      p.kind === "task" && this.index?.altdirAvailable
        ? h("span", { class: `altdir-marker ${p.altdirExists ? "yes" : "no"}`, title: p.altdirExists ? ui.tree.hasAltdir : ui.tree.noAltdir }, p.altdirExists ? "L" : "")
        : null;
    // click on the marker: open the solution file (or create it)
    altCell?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.openSolution(p.path);
    });
    return h("span", { class: "tree-badges" }, h("span", { class: "cell cell-git" }), h("span", { class: "cell cell-stage" }, stageCell), h("span", { class: "cell cell-diff" }, diffCell), h("span", { class: "cell cell-alt" }, altCell));
  }

  private fileRow(path: string, label: Node | string, depth: number, badges?: Node, onSelect?: () => void) {
    const row = h("div", { class: "tree-item tree-file", role: "treeitem", style: `--depth:${depth}`, "data-path": path }, h("span", { class: "twisty" }), label, badges ?? emptyBadges());
    row.addEventListener("click", () => {
      onSelect?.();
      this.cb.open(path);
    });
    return row;
  }

  private itemRow(it: OpenableItem, depth: number) {
    if (it.part) {
      const p = it.part;
      return this.fileRow(it.path, h("span", { class: "tree-label" }, h("span", { class: "tree-name" }, it.label), it.title ? h("span", { class: "tree-title" }, it.title) : null, h("span", { class: "tree-path" }, it.rel)), depth, this.badges(p), () => {
        if (p.chapter && p.taskgroup) this.cb.selectTaskgroup(p.chapter, p.taskgroup);
        else if (p.chapter && p.kind === "taskgroup") this.cb.selectTaskgroup(p.chapter, p.name);
      });
    }
    return this.fileRow(it.path, h("span", { class: "tree-label" }, h("span", { class: "tree-name" }, it.label), h("span", { class: "tree-path" }, it.rel)), depth);
  }

  private plainFiles(files: FileEntry[], depth: number, container: HTMLElement, relBase: string) {
    for (const f of files) {
      const shown = f.rel.startsWith(relBase) ? f.rel.slice(relBase.length) : f.rel;
      if (f.isDir) container.append(h("div", { class: "tree-item tree-dir", style: `--depth:${depth}` }, h("span", { class: "twisty" }), h("span", { class: "tree-name dim" }, shown + "/")));
      else container.append(this.fileRow(f.path, h("span", { class: "tree-label" }, h("span", { class: "tree-name" }, shown)), depth));
    }
  }

  private taskgroupNode(chapter: string, tg: TaskgroupNode, depth: number) {
    const key = `tg:${chapter}/${tg.part.name}`;
    return this.group(key, this.partLabel(tg.part), depth, (c) => {
      if (!tg.part.missing) c.append(this.fileRow(tg.part.path, indexLabel(), depth + 1, undefined, () => this.cb.selectTaskgroup(chapter, tg.part.name)));
      for (const t of tg.tasks) {
        c.append(this.fileRow(t.path, this.partLabel(t), depth + 1, this.badges(t), () => this.cb.selectTaskgroup(chapter, tg.part.name)));
      }
      for (const z of tg.zipdirs) c.append(h("div", { class: "tree-item tree-dir", style: `--depth:${depth + 1}`, title: z.rel }, h("span", { class: "twisty" }), h("span", { class: "tree-name" }, z.name)));
      if (tg.files.length) {
        const base = tg.part.rel.replace(/index\.md$/, "");
        c.append(this.group(`res:${chapter}/${tg.part.name}`, h("span", { class: "tree-name dim" }, `${ui.tree.resources} (${tg.files.length})`), depth + 1, (rc) => this.plainFiles(tg.files, depth + 2, rc, base)));
      }
    }, "", this.badges(tg.part));
  }

  private renderTree(index: CourseIndex) {
    if (index.duplicateNames.length) this.list.append(h("div", { class: "tree-warning" }, ui.tree.duplicates(index.duplicateNames)));
    for (const ch of index.chapters) {
      this.list.append(
        this.group(`ch:${ch.part.name}`, this.partLabel(ch.part), 0, (c) => {
          if (!ch.part.missing) c.append(this.fileRow(ch.part.path, indexLabel(), 1));
          for (const tg of ch.taskgroups) c.append(this.taskgroupNode(ch.part.name, tg, 1));
          for (const z of ch.zipdirs) c.append(h("div", { class: "tree-item tree-dir", style: "--depth:1" }, h("span", { class: "twisty" }), h("span", { class: "tree-name" }, z.name)));
        }, "tree-chapter", this.badges(ch.part)),
      );
    }
    if (index.glossary) {
      this.list.append(this.fileRow(index.glossary.path, h("span", { class: "tree-label" }, h("span", { class: "tree-name" }, ui.tree.glossary), h("span", { class: "tree-title" }, ui.tree.terms(index.glossaryTerms.length))), 0));
    }
    if (index.includeFiles.length) {
      const base = index.includeFiles[0].rel.replace(/_include\/.*$/, "_include/");
      this.list.append(this.group("special:include", h("span", { class: "tree-name" }, ui.tree.includes), 0, (c) => this.plainFiles(index.includeFiles, 1, c, base)));
    }
    const others = [...index.topFiles, ...index.unconfigured];
    if (others.length) {
      this.list.append(
        this.group("special:other", h("span", { class: "tree-name" }, ui.tree.otherFiles), 0, (c) => {
          this.plainFiles(index.topFiles, 1, c, "");
          if (index.unconfigured.length) {
            c.append(h("div", { class: "tree-item tree-dir", style: "--depth:1" }, h("span", { class: "twisty" }), h("span", { class: "tree-name dim" }, ui.tree.unconfigured)));
            this.plainFiles(index.unconfigured, 2, c, "");
          }
        }),
      );
    }
  }
}

function emptyBadges() {
  return h("span", { class: "tree-badges" }, h("span", { class: "cell cell-git" }), h("span", { class: "cell cell-stage" }), h("span", { class: "cell cell-diff" }), h("span", { class: "cell cell-alt" }));
}

/** The chapter's or taskgroup's own page (index.md), not a disabled entry. */
function indexLabel() {
  return h("span", { class: "tree-label tree-index", title: ui.tree.indexTitle }, h("span", { class: "tree-icon" }, "≡"), h("span", { class: "tree-name" }, "index.md"));
}

function normalizeName(s: string) {
  return s.toLowerCase().replace(/[\s_\-:]+/g, "");
}
