// Main application controller: course, tabs, the single EditorView, saving and
// reacting to external file changes.

import { EditorView, type ViewUpdate } from "@codemirror/view";
import { EditorState, Text } from "@codemirror/state";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { backend, events, type CourseIndex, type LtStatus, type TextFile } from "./backend";
import { findPartByPath, hasTopMatter, openableItems, parserConfigFor, partNames } from "./course";
import { GrammarService } from "./grammar/grammar";
import { ChangeSet, EditorSelection, Transaction } from "@codemirror/state";
import { parseProPra } from "./editor/parser";
import { embeddedEditorExtensions } from "./editor/setup";
import { syncAnnotation } from "./editor/slice";
import { glossaryTerms, termInsertion } from "./glossary/model";
import { GlossaryPanel, type TermUsage } from "./panels/glossary-panel";
import { PreviewPanel } from "./panels/preview";
import { openLogs, type LogTab } from "./panels/logs";
import { GitPanel, isStaged, statusLetter } from "./panels/git-panel";
import { showDiff } from "./panels/diff";
import type { GitMark } from "./panels/filetree";
import type { GitFile, RepoStatus } from "./backend";
import { BuildPanel } from "./panels/build-panel";
import { locateProblem, type BuildProblem } from "./build/output";
import { openUrl } from "@tauri-apps/plugin-opener";
import { altdirField, altdirLoad, altdirStateExtension, type AltdirDoc, type RenumberPlan } from "./altdir/state";
import { altdirViewExtension, setSolutionsVisible, type AltdirEnv } from "./altdir/widgets";
import { applyChanges, type TextChange } from "./altdir/segments";
import { diagnosticCount, forceLinting } from "@codemirror/lint";
import { setLintPanelHeight, toggleLintPanel } from "./editor/lint-panel";
import { lintRefresh } from "./editor/refresh";
import { propraAssist } from "./lint/assist";
import { propraEnv, type IncludeQuery, type PartRef, type PropraEnv, type TermRef } from "./lint/env";
import { structuralLinter } from "./lint/extension";
import type { FileKind, IncludeStatus } from "./lint/structural";
import { createState, languageCompartment, loadOtherLanguage, wrapCompartment } from "./editor/setup";
import { ui } from "./i18n";
import { FileTree } from "./panels/filetree";
import { newTaskDialog } from "./panels/newtask";
import { quickOpen } from "./panels/quickopen";
import { settingsDialog } from "./panels/settingsdialog";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./settings";
import { h, showDialog, toast } from "./ui/dom";

interface Tab {
  path: string;
  name: string;
  rel: string;
  state: EditorState;
  /** Document as last loaded from / saved to disk. */
  savedDoc: Text;
  /** Disk text as last seen (to recognize our own saves in watcher events). */
  diskText: string;
  eol: "\n" | "\r\n";
  bom: boolean;
  scrollTop: number;
  deleted: boolean;
  wrap: boolean;
  /** The task's solution file in altdir (shown inline), if any. */
  alt: AltTab | null;
}

interface AltTab {
  path: string;
  exists: boolean;
  savedDoc: Text;
  diskText: string;
  eol: "\n" | "\r\n";
  bom: boolean;
}

const MINIMAL_TEMPLATE = 'title: ""\nstage: draft\ntimevalue: 1.0\ndifficulty: 2\n---\n\n[SECTION::goal::idea]\n\n[ENDSECTION]\n';

function baseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export class App {
  private settings!: Settings;
  private index: CourseIndex | null = null;
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private view!: EditorView;
  private tree!: FileTree;
  private selectedTaskgroup: { chapter: string; taskgroup: string } | null = null;

  private tabBar = h("div", { class: "tabbar", role: "tablist" });
  private editorHost = h("div", { class: "editor-host" });
  private welcome = h("div", { class: "welcome" });
  private statusPath = h("bdi", { class: "status-path-inner" });
  private statusFile = h("span", { class: "status-file" });
  private statusLeft = h("span", { class: "status-left" }, h("span", { class: "status-path" }, this.statusPath), this.statusFile);
  private statusPos = h("span", { class: "status-pos" });
  private statusRight = h("span", { class: "status-right" });
  private statusLt = h("button", { class: "status-lt", title: ui.logs.statusHint });
  private grammar!: GrammarService;
  private statusProblems = h("button", { class: "status-problems", title: ui.problems.title });
  private partMap: Map<string, PartRef> | null = null;
  private glossaryMap: Map<string, TermRef> | null = null;
  private includeCache = new Map<string, IncludeStatus>();
  private ltStatus: LtStatus = { state: "starting", message: null };
  private glossaryPanel!: GlossaryPanel;
  private preview!: PreviewPanel;
  private buildPanel!: BuildPanel;
  private gitPanel!: GitPanel;
  private gitTimer: number | undefined;
  private toolbarSync: (() => void)[] = [];
  private saveBtn!: HTMLButtonElement;
  private sidebar!: HTMLElement;
  private statusGit = h("button", { class: "status-git", hidden: true });
  private buildId = 0;
  private scrollToken = 0;
  private buildProblems = new Map<string, BuildProblem[]>();
  private diskTextCache = new Map<string, string | null>();
  private glossaryDiskText: string | null = null;
  private glossaryTimer: number | undefined;
  private usagesCache: Promise<TermUsage[]> | null = null;

  async start(root: HTMLElement) {
    this.settings = await loadSettings();
    this.applyFontSettings();
    this.grammar = new GrammarService(
      {
        check: (data, disabled, enabled) => backend.ltCheck(data, disabled, enabled),
        saveDictionary: (words) => void backend.saveDictionary(words).catch((e) => toast(String(e), "error")),
        saveSettings: (g) => {
          this.settings.ltDisabledRules = g.disabledRules;
          this.settings.ltEnabledRules = g.enabledRules;
          saveSettings(this.settings);
        },
        onActivity: () => this.updateLtStatus(),
      },
      this.grammarSettings(),
    );
    void backend.getDictionary().then((w) => this.grammar.setDictionary(w)).catch(() => {});
    this.statusLt.addEventListener("click", () => void this.showLogs("languagetool"));
    this.tree = new FileTree(
      {
        open: (p) => void this.openFile(p),
        selectTaskgroup: (chapter, taskgroup) => (this.selectedTaskgroup = { chapter, taskgroup }),
        expandedChanged: (exp) => {
          this.settings.treeExpanded = exp;
          saveSettings(this.settings);
        },
      },
      this.settings.treeExpanded,
    );
    this.view = new EditorView({
      parent: this.editorHost,
      state: EditorState.create({ doc: "" }),
      dispatchTransactions: (trs, view) => {
        view.update(trs);
        if (this.active) this.active.state = view.state;
        if (this.active && this.active === this.glossaryTab()) {
          for (const tr of trs) {
            if (!tr.docChanged || tr.annotation(syncAnnotation)) continue;
            this.glossaryPanel.pushExternal(tr.changes);
            this.onGlossaryChanged();
          }
        }
      },
    });
    this.glossaryPanel = new GlossaryPanel({
      masterDoc: () => this.glossaryTab()?.state.doc ?? null,
      applyToMaster: (changes) => this.applyToGlossary(changes, false),
      extensions: () => embeddedEditorExtensions(parserConfigFor(this.index), true, [propraEnv.of(this.makeEnv(this.index?.glossary?.path ?? "")), propraAssist(), this.grammar.extension()]),
      parserConfig: () => parserConfigFor(this.index),
      usages: () => (this.usagesCache ??= backend.termUsages().catch(() => [])),
      open: (p, line) => void this.openAt(p, line),
      picked: (pos) => {
        if (this.active && this.active === this.glossaryTab()) this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 40 }) });
      },
      closed: () => this.view.focus(),
    });
    this.preview = new PreviewPanel({
      source: () => {
        const tab = this.active;
        if (!tab || !tab.path.toLowerCase().endsWith(".md")) return null;
        const text = this.view.state.doc.toString();
        return { path: tab.path, text, topMatter: hasTopMatter(this.index, tab.path, text) };
      },
      parserConfig: () => parserConfigFor(this.index),
      templates: () => this.index?.config.topmatter ?? {},
      courseCss: () => backend.courseCss(),
      resolve: async (path, calls) => {
        const res = await this.checkIncludesCached(
          path,
          calls.map((c) => ({ macroName: c.name, arg: c.args[0] ?? "", snippet: c.name === "SNIPPET" ? c.args[1] : undefined })),
        );
        return res.map((r) => (r.exists ? r.path : null));
      },
      readText: (p) => this.liveText(p),
      openPart: (name) => {
        const part = this.partMap?.get(name);
        if (part) void this.openFile(part.path);
        else toast(ui.preview.unknownPart(name), "error");
      },
      openTerm: (name) => void this.openTerm(name),
      openUrl: (url) => void openUrl(url).catch((e) => toast(String(e), "error")),
      revealLine: (line) => {
        const l = this.view.state.doc.line(Math.min(line + 1, this.view.state.doc.lines));
        this.view.dispatch({ selection: EditorSelection.cursor(l.from), effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 60 }) });
        this.view.focus();
      },
      tutorView: this.settings.previewTutor,
      setTutorView: (on) => {
        this.settings.previewTutor = on;
        saveSettings(this.settings);
      },
      closed: () => {
        this.settings.previewVisible = false;
        saveSettings(this.settings);
        this.view.focus();
      },
    });
    this.view.scrollDOM.addEventListener("scroll", () => this.syncPreview(), { passive: true });
    this.gitPanel = new GitPanel({
      status: () => backend.gitStatus(),
      stage: (root, rels) => backend.gitStage(root, rels),
      unstage: (root, rels, hasCommits) => backend.gitUnstage(root, rels, hasCommits),
      commit: (root, message) => backend.gitCommit(root, message),
      push: (root, up) => backend.gitPush(root, up),
      pull: (root) => backend.gitPull(root),
      open: (p) => void this.openFile(p),
      diff: (f) => void this.diffFile(f.path, f.rel),
      saveAll: () => this.saveAllDirty(),
      statusChanged: (repos) => this.onGitStatus(repos),
      closed: () => this.view.focus(),
    });
    this.statusGit.addEventListener("click", () => this.toggleGit());
    window.addEventListener("focus", () => this.scheduleGitRefresh(100));
    this.buildPanel = new BuildPanel({
      start: async () => {
        if (!this.index) throw new Error(ui.build.noCourse);
        await this.saveAllDirty();
        this.buildId = -1; // accept output that arrives before the id is known
        const [id, cmd] = await backend.buildStart(this.settings.buildCommand, this.settings.buildOutDir);
        this.buildId = id;
        return cmd;
      },
      cancel: () => void backend.buildCancel(),
      canOpenPage: () => !!this.activePartName(),
      openPage: () => {
        const name = this.activePartName();
        if (!name) return toast(ui.build.noPart, "error");
        backend.openBuiltPage(this.settings.buildOutDir, name).then(
          (p) => toast(ui.build.pageOpened(p)),
          (e) => toast(String(e), "error"),
        );
      },
      openProblem: (p) => void this.openBuildProblem(p),
      activeRel: () => (this.active ? this.relOf(this.active.path) : null),
      problemsChanged: (summary) => {
        this.buildProblems = new Map();
        for (const p of summary.problems) {
          const list = this.buildProblems.get(p.file) ?? [];
          list.push(p);
          this.buildProblems.set(p.file, list);
        }
        this.refreshLints();
      },
      closed: () => this.view.focus(),
      height: this.settings.buildPanelHeight,
      setHeight: (px) => {
        this.settings.buildPanelHeight = px;
        saveSettings(this.settings);
      },
    });
    this.buildLayout(root);
    this.bindGlobalKeys();
    await this.bindBackendEvents();
    this.renderTabs();
    this.updateStatus();

    if (this.settings.courseRoot) {
      const ok = await this.loadCourse(this.settings.courseRoot, false);
      if (ok) await this.restoreTabs();
      if (ok && this.settings.previewVisible) void this.preview.show();
    } else {
      this.showWelcome();
    }
  }

  // ----- layout

  private buildLayout(root: HTMLElement) {
    const btn = (label: string, title: string, onclick: () => void) => h("button", { class: "tool", title, onclick }, label);
    // toggles show their state (aria-pressed); panels report hide/show via their `hidden` attribute
    const toggle = (label: string, title: string, onclick: () => void, isOn: () => boolean, watch?: HTMLElement) => {
      const b = btn(label, title, onclick);
      b.classList.add("toggle");
      const sync = () => b.setAttribute("aria-pressed", String(isOn()));
      this.toolbarSync.push(sync);
      if (watch) new MutationObserver(sync).observe(watch, { attributes: true, attributeFilter: ["hidden"] });
      sync();
      return b;
    };
    const sep = () => h("span", { class: "tool-sep", "aria-hidden": "true" });
    const iconOnly = (b: HTMLButtonElement) => (b.classList.add("icon-only"), b);
    const sidebar = h("aside", { class: "sidebar", hidden: !this.settings.sidebarVisible }, this.tree.dom);
    sidebar.style.width = `${this.settings.sidebarWidth}px`;
    this.sidebar = sidebar;
    this.saveBtn = btn(ui.toolbar.save, `${ui.toolbar.save} (${modKey()}+S)`, () => void this.saveActive());
    const toolbar = h(
      "header",
      { class: "toolbar" },
      iconOnly(toggle("◧", ui.toolbar.sidebarTitle(`${modKey()}+Shift+E`), () => this.toggleSidebar(), () => !sidebar.hidden, sidebar)),
      sep(),
      btn(ui.toolbar.openCourse, ui.toolbar.openCourse, () => void this.chooseCourse()),
      btn(ui.toolbar.newTask, `${ui.toolbar.newTask} (${modKey()}+N)`, () => void this.newTask()),
      this.saveBtn,
      sep(),
      btn(ui.toolbar.quickOpen, `${ui.toolbar.quickOpen} (${modKey()}+P)`, () => this.quickOpen()),
      sep(),
      toggle(ui.glossary.toolbar, ui.glossary.toolbarTitle, () => void this.toggleGlossary(), () => !this.glossaryPanel.dom.hidden, this.glossaryPanel.dom),
      toggle(ui.altdir.toolbar, ui.altdir.toolbarTitle, () => this.toggleSolutions(), () => this.settings.showSolutions),
      toggle(ui.preview.toolbar, ui.preview.toolbarTitle(`${modKey()}+Shift+V`), () => this.togglePreview(), () => !this.preview.dom.hidden, this.preview.dom),
      toggle(ui.git.toolbar, ui.git.toolbarTitle(`${modKey()}+Shift+G`), () => this.toggleGit(), () => !this.gitPanel.dom.hidden, this.gitPanel.dom),
      sep(),
      btn(ui.build.toolbar, ui.build.toolbarTitle(`${modKey()}+B`), () => void this.buildPanel.run()),
      h("span", { class: "spacer" }),
      btn(ui.logs.toolbar, ui.logs.toolbarTitle, () => void this.showLogs("app")),
      btn("⚙", ui.toolbar.settings, () => void this.openSettings()),
    );
    const resizer = h("div", { class: "resizer sidebar-resizer" });
    resizer.addEventListener("pointerdown", (e) => {
      resizer.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = sidebar.offsetWidth;
      const move = (ev: PointerEvent) => (sidebar.style.width = `${Math.max(180, Math.min(700, startW + ev.clientX - startX))}px`);
      const up = () => {
        resizer.removeEventListener("pointermove", move);
        this.settings.sidebarWidth = sidebar.offsetWidth;
        saveSettings(this.settings);
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up, { once: true });
    });
    const main = h("main", { class: "main" }, this.tabBar, this.editorHost, this.welcome, this.buildPanel.dom);
    this.statusProblems.addEventListener("click", () => {
      toggleLintPanel(this.view);
      this.view.focus();
    });
    const status = h("footer", { class: "statusbar" }, this.statusLeft, this.statusPos, this.statusProblems, h("span", { class: "spacer" }), this.statusRight, this.statusGit, this.statusLt);
    const rightResizer = h("div", { class: "resizer" });
    const panel = this.glossaryPanel.dom;
    panel.style.width = `${this.settings.rightPanelWidth}px`;
    rightResizer.addEventListener("pointerdown", (e) => {
      if (panel.hidden) return;
      rightResizer.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = panel.offsetWidth;
      const move = (ev: PointerEvent) => (panel.style.width = `${Math.max(260, Math.min(900, startW - (ev.clientX - startX)))}px`);
      rightResizer.addEventListener("pointermove", move);
      rightResizer.addEventListener(
        "pointerup",
        () => {
          rightResizer.removeEventListener("pointermove", move);
          this.settings.rightPanelWidth = panel.offsetWidth;
          saveSettings(this.settings);
        },
        { once: true },
      );
    });
    const pv = this.preview.dom;
    pv.style.width = `${this.settings.previewWidth}px`;
    const pvResizer = h("div", { class: "resizer" });
    pvResizer.addEventListener("pointerdown", (e) => {
      if (pv.hidden) return;
      pvResizer.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = pv.offsetWidth;
      const move = (ev: PointerEvent) => (pv.style.width = `${Math.max(280, Math.min(1400, startW - (ev.clientX - startX)))}px`);
      pvResizer.addEventListener("pointermove", move);
      pvResizer.addEventListener(
        "pointerup",
        () => {
          pvResizer.removeEventListener("pointermove", move);
          this.settings.previewWidth = pv.offsetWidth;
          saveSettings(this.settings);
          this.syncPreview();
        },
        { once: true },
      );
    });
    const gp = this.gitPanel.dom;
    gp.style.width = `${this.settings.gitPanelWidth}px`;
    const gpResizer = h("div", { class: "resizer" });
    gpResizer.addEventListener("pointerdown", (e) => {
      if (gp.hidden) return;
      gpResizer.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = gp.offsetWidth;
      const move = (ev: PointerEvent) => (gp.style.width = `${Math.max(260, Math.min(900, startW - (ev.clientX - startX)))}px`);
      gpResizer.addEventListener("pointermove", move);
      gpResizer.addEventListener(
        "pointerup",
        () => {
          gpResizer.removeEventListener("pointermove", move);
          this.settings.gitPanelWidth = gp.offsetWidth;
          saveSettings(this.settings);
        },
        { once: true },
      );
    });
    root.replaceChildren(toolbar, h("div", { class: "workspace" }, sidebar, resizer, main, pvResizer, pv, rightResizer, panel, gpResizer, gp), status);
  }

  private lineWrap() {
    return this.settings.wrapMode !== "off";
  }

  private applyFontSettings() {
    const s = this.settings;
    const root = document.documentElement;
    root.style.setProperty("--editor-font", s.fontFamily);
    root.style.setProperty("--editor-font-size", `${s.fontSize}px`);
    root.style.setProperty("--prose-font", s.proseFontFamily || DEFAULT_SETTINGS.proseFontFamily);
    root.classList.toggle("prose-proportional", s.proportionalProse);
    setLintPanelHeight(s.lintPanelHeight);
    root.classList.toggle("wrap-column", s.wrapMode === "column");
    const measure = () => {
      const font = s.proportionalProse ? s.proseFontFamily || DEFAULT_SETTINGS.proseFontFamily : s.fontFamily;
      root.style.setProperty("--wrap-width", `${Math.round(wrapWidth(font, s.fontSize, s.wrapColumn))}px`);
    };
    measure();
    void document.fonts?.ready.then(measure);
  }

  private showWelcome(message?: string) {
    this.welcome.replaceChildren(
      h("h1", {}, ui.welcome.title),
      h("p", {}, ui.welcome.text),
      message ? h("p", { class: "form-error" }, message) : "",
      h("button", { class: "primary", onclick: () => void this.chooseCourse() }, ui.welcome.choose),
    );
    this.welcome.hidden = false;
    this.editorHost.hidden = true;
  }

  private updateMainVisibility() {
    const hasTab = !!this.active;
    this.editorHost.hidden = !hasTab;
    this.welcome.hidden = hasTab || !!this.index;
    if (!hasTab && !this.index) this.welcome.hidden = false;
  }

  // ----- course

  private async chooseCourse() {
    const dir = await openDialog({ directory: true, multiple: false, title: ui.welcome.choose }).catch(() => null);
    if (typeof dir !== "string") return;
    if (!(await backend.isCourseRoot(dir))) {
      toast(ui.welcome.notACourse(dir), "error");
      if (!this.index) this.showWelcome(ui.welcome.notACourse(dir));
      return;
    }
    if (this.settings.courseRoot && this.settings.courseRoot !== dir) {
      for (const t of [...this.tabs]) if (!(await this.closeTab(t))) return;
    }
    await this.loadCourse(dir, true);
  }

  private async loadCourse(dir: string, remember: boolean): Promise<boolean> {
    try {
      const index = await backend.openCourse(dir);
      this.setIndex(index);
      if (remember) {
        this.settings.courseRoot = dir;
        saveSettings(this.settings, true);
      }
      this.updateMainVisibility();
      return true;
    } catch (e) {
      this.showWelcome(ui.welcome.loadFailed(String(e)));
      return false;
    }
  }

  private grammarSettings() {
    return { enabled: this.settings.grammarEnabled, disabledRules: this.settings.ltDisabledRules, enabledRules: this.settings.ltEnabledRules };
  }

  private setIndex(index: CourseIndex) {
    this.index = index;
    this.includeCache.clear();
    this.diskTextCache.clear();
    this.scheduleGitRefresh(0);
    this.partMap = new Map();
    const addPart = (p: { name: string; title: string | null; rel: string; path: string; kind: string }) => this.partMap!.set(p.name, { name: p.name, title: p.title, rel: p.rel, path: p.path, kind: p.kind });
    for (const ch of index.chapters) {
      addPart(ch.part);
      ch.zipdirs.forEach(addPart);
      for (const tg of ch.taskgroups) {
        addPart(tg.part);
        tg.tasks.forEach(addPart);
        tg.zipdirs.forEach(addPart);
      }
    }
    this.usagesCache = null;
    this.grammar.setAcceptedNames([...partNames(index), ...index.glossaryTerms.flatMap((t) => t.names)]);
    void this.loadGlossaryFromDisk();
    this.tree.setIndex(index);
    this.tree.setActive(this.active?.path ?? null);
    this.updateStatus();
  }

  // ----- glossary

  private glossaryTab(): Tab | undefined {
    const p = this.index?.glossary?.path;
    return p ? this.tabs.find((t) => t.path === p) : undefined;
  }

  private async loadGlossaryFromDisk() {
    const p = this.index?.glossary?.path;
    if (!p) {
      this.glossaryDiskText = null;
      return this.recomputeGlossary();
    }
    try {
      this.glossaryDiskText = (await backend.readTextFile(p)).text;
    } catch {
      this.glossaryDiskText = null;
    }
    this.recomputeGlossary();
  }

  private onGlossaryChanged() {
    window.clearTimeout(this.glossaryTimer);
    this.glossaryTimer = window.setTimeout(() => this.recomputeGlossary(), 250);
  }

  /** Rebuild the term map from the glossary tab (if open, including unsaved edits) or from disk. */
  private recomputeGlossary() {
    const tab = this.glossaryTab();
    const text = tab ? tab.state.doc.toString() : this.glossaryDiskText;
    if (text === null) {
      this.glossaryMap = null;
    } else {
      const map = new Map<string, TermRef>();
      for (const t of glossaryTerms(parseProPra(text, parserConfigFor(this.index)))) {
        const ref: TermRef = { names: t.names, line: t.line, term0: t.term0, body: text.slice(t.bodyFrom, t.bodyTo) };
        for (const n of t.names) if (!map.has(n)) map.set(n, ref);
      }
      this.glossaryMap = map;
    }
    if (this.index) this.grammar.setAcceptedNames([...partNames(this.index), ...(this.glossaryMap?.keys() ?? [])]);
    this.glossaryPanel.refresh();
    this.refreshLints();
  }

  /** Apply a change to glossary.md (its tab), from the panel or a quick fix. */
  private applyToGlossary(changes: ChangeSet, addToHistory: boolean) {
    const tab = this.glossaryTab();
    if (!tab) return;
    const annotations = [syncAnnotation.of(true), Transaction.addToHistory.of(addToHistory)];
    if (tab === this.active) this.view.dispatch({ changes, annotations });
    else tab.state = tab.state.update({ changes, annotations }).state;
    this.renderTabs();
    this.onGlossaryChanged();
  }

  private async ensureGlossaryTab(): Promise<Tab | null> {
    const p = this.index?.glossary?.path;
    if (!p) {
      toast(ui.glossary.noGlossary, "error");
      return null;
    }
    return this.glossaryTab() ?? (await this.openFile(p, { activate: false }));
  }

  private async toggleGlossary() {
    if (this.glossaryPanel.visible) return this.glossaryPanel.hide();
    if (await this.ensureGlossaryTab()) this.glossaryPanel.show();
  }

  private async openTerm(name: string) {
    if (await this.ensureGlossaryTab()) this.glossaryPanel.show(name);
  }

  private async createTerm(name: string) {
    const tab = await this.ensureGlossaryTab();
    if (!tab) return;
    name = name.trim();
    const doc = tab.state.doc;
    const exists = glossaryTerms(parseProPra(doc.toString(), parserConfigFor(this.index))).some((t) => t.names.includes(name));
    if (exists) {
      toast(ui.glossary.exists(name));
      return this.glossaryPanel.show(name);
    }
    const ins = termInsertion(parseProPra(doc.toString(), parserConfigFor(this.index)), name);
    const changes = ChangeSet.of({ from: ins.from, insert: ins.insert }, doc.length);
    this.applyToGlossary(changes, true); // undoable in the glossary tab
    this.glossaryPanel.pushExternal(changes);
    this.recomputeGlossary();
    this.glossaryPanel.show(name, ins.cursor);
    toast(ui.glossary.created(name));
  }

  private async restoreTabs() {
    const paths = this.settings.openTabs;
    for (const p of paths) await this.openFile(p, { activate: false, quiet: true });
    const act = this.tabs.find((t) => t.path === this.settings.activeTab) ?? this.tabs[0];
    if (act) this.activate(act);
  }

  // ----- tabs

  private persistTabs() {
    this.settings.openTabs = this.tabs.map((t) => t.path);
    this.settings.activeTab = this.active?.path ?? null;
    saveSettings(this.settings);
  }

  private isDirty(tab: Tab) {
    return !tab.state.doc.eq(tab.savedDoc) || tab.deleted || this.altDirty(tab);
  }

  private altDirty(tab: Tab): boolean {
    const alt = tab.alt && tab.state.field(altdirField, false);
    return !!alt && !alt.doc.eq(tab.alt!.savedDoc);
  }

  private makeState(tab: { path: string }, text: string, alt: AltdirDoc | null = null): EditorState {
    const isMarkdown = tab.path.toLowerCase().endsWith(".md");
    const altExt = alt ? [altdirStateExtension(alt), altdirViewExtension(this.makeAltdirEnv(tab.path, alt.path))] : [];
    return createState(text, {
      path: tab.path,
      isMarkdown,
      topMatter: isMarkdown && hasTopMatter(this.index, tab.path, text),
      parserConfig: parserConfigFor(this.index),
      softWrap: this.lineWrap(),
      lintPanelSaved: (px) => {
        this.settings.lintPanelHeight = Math.round(px);
        saveSettings(this.settings);
      },
      extra: EditorView.updateListener.of((u: ViewUpdate) => this.onEditorUpdate(u)),
      markdownExtra: [propraEnv.of(this.makeEnv(tab.path)), structuralLinter(), propraAssist(), this.grammar.extension(), altExt],
    });
  }

  private makeAltdirEnv(taskPath: string, altPath: string): AltdirEnv {
    const rel = () => (this.index && findPartByPath(this.index, taskPath)?.rel) || taskPath;
    return {
      editorExtensions: () => embeddedEditorExtensions(parserConfigFor(this.index), false, [propraEnv.of(this.makeEnv(altPath)), propraAssist(), this.grammar.extension()]),
      isCollapsed: (key) => (this.settings.solutionCollapsed[rel()] ?? []).includes(key),
      setCollapsed: (key, collapsed) => {
        const r = rel();
        const list = new Set(this.settings.solutionCollapsed[r] ?? []);
        if (collapsed) list.add(key);
        else list.delete(key);
        this.settings.solutionCollapsed[r] = [...list];
        saveSettings(this.settings);
      },
      showSolutions: () => this.settings.showSolutions,
      confirmRenumber: (plan, state) => this.confirmRenumber(plan, state),
    };
  }

  private async confirmRenumber(plan: RenumberPlan, state: EditorState): Promise<boolean> {
    const altText = state.field(altdirField, false)?.doc.toString() ?? "";
    const section = (label: string, text: string, changes: TextChange[]) => {
      const after = applyChanges(text, changes);
      const a = text.split("\n");
      const b = after.split("\n");
      const rows: Node[] = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        rows.push(h("div", { class: "diff-del" }, `${i + 1}  − ${a[i] ?? ""}`), h("div", { class: "diff-add" }, `${i + 1}  + ${b[i] ?? ""}`));
      }
      return h("div", { class: "diff-file" }, h("div", { class: "diff-title" }, label), ...(rows.length ? rows : [h("div", { class: "form-hint" }, ui.altdir.noChanges)]));
    };
    const body = h("div", { class: "diff" }, h("p", {}, ui.altdir.confirmText), section(ui.altdir.taskFile, state.doc.toString(), plan.task), section(ui.altdir.altFile, altText, plan.altdir));
    return showDialog({
      title: ui.altdir.confirmTitle,
      body,
      buttons: [
        { label: ui.common.cancel, value: false },
        { label: ui.altdir.confirm, value: true, primary: true },
      ],
      cancelValue: false,
    });
  }

  private toggleSolutions() {
    this.settings.showSolutions = !this.settings.showSolutions;
    saveSettings(this.settings);
    if (this.active?.alt) this.view.dispatch({ effects: setSolutionsVisible.of(this.settings.showSolutions) });
    this.toolbarSync.forEach((f) => f());
  }

  private fileKind(path: string): FileKind {
    const index = this.index;
    if (!index) return "other";
    const part = findPartByPath(index, path);
    if (part) return part.kind === "zipdir" ? "other" : part.kind;
    if (index.glossary?.path === path) return "glossary";
    if (index.includeFiles.some((f) => f.path === path)) return "include";
    return "other";
  }

  private makeEnv(path: string): PropraEnv {
    const rel = () => (this.index ? (openableItems(this.index).find((i) => i.path === path)?.rel ?? path) : path);
    return {
      path,
      fileKind: this.fileKind(path),
      stages: () => this.index?.config.stages ?? [],
      sectionTypes: () => this.index?.config.sectionTypes ?? {},
      parts: () => this.partMap,
      glossary: () => this.glossaryMap,
      glossaryPath: () => this.index?.glossary?.path ?? null,
      checkIncludes: (queries: IncludeQuery[]) => this.checkIncludesCached(path, queries),
      buildProblems: () => this.buildProblems.get(rel()) ?? [],
      listDir: (partial, itree) => backend.listIncludeDir(path, partial, itree),
      open: (p, line) => void this.openAt(p, line),
      openTerm: (name) => void this.openTerm(name),
      createTerm: (name) => void this.createTerm(name),
      silenced: () => this.settings.silencedLints[rel()] ?? [],
      silence: (id) => {
        const r = rel();
        const list = (this.settings.silencedLints[r] ??= []);
        if (!list.includes(id)) list.push(id);
        saveSettings(this.settings);
        toast(ui.lint.silenced(id));
        this.refreshLints();
      },
    };
  }

  private async checkIncludesCached(path: string, queries: IncludeQuery[]): Promise<IncludeStatus[]> {
    const key = (q: IncludeQuery) => `${path}|${q.macroName}|${q.arg}|${q.snippet ?? ""}`;
    const missing = queries.filter((q) => !this.includeCache.has(key(q)));
    if (missing.length) {
      const res = await backend.checkIncludes(path, missing);
      missing.forEach((q, i) => this.includeCache.set(key(q), res[i]));
    }
    return queries.map((q) => this.includeCache.get(key(q))!);
  }

  /** Text of a file as the user sees it: open tabs and inline solutions win over disk. */
  private async liveText(path: string): Promise<string | null> {
    for (const tab of this.tabs) {
      const state = tab === this.active ? this.view.state : tab.state;
      if (tab.path === path) return state.doc.toString();
      const alt = tab.alt?.path === path ? state.field(altdirField, false) : null;
      if (alt) return alt.doc.toString();
    }
    if (!this.diskTextCache.has(path)) this.diskTextCache.set(path, await backend.readTextFile(path).then((f) => f.text, () => null));
    return this.diskTextCache.get(path) ?? null;
  }

  private relOf(path: string): string | null {
    return this.index ? (openableItems(this.index).find((i) => i.path === path)?.rel ?? null) : null;
  }

  /** Name of the active part (task, taskgroup, chapter), for opening its built page. */
  private activePartName(): string | null {
    if (!this.active || !this.index) return null;
    const part = findPartByPath(this.index, this.active.path);
    return part && part.kind !== "zipdir" ? part.name : this.index.glossary?.path === this.active.path ? "glossary" : null;
  }

  private async saveAllDirty() {
    for (const tab of [...this.tabs]) {
      if (tab === this.active) tab.state = this.view.state;
      if (this.isDirty(tab)) await this.saveTab(tab);
    }
  }

  private async openBuildProblem(p: BuildProblem) {
    let path: string;
    try {
      path = await backend.coursePath(p.file);
    } catch (e) {
      return toast(String(e), "error");
    }
    if (!(await backend.pathExists(path).catch(() => false))) return toast(ui.build.notInCourse(p.file), "error");
    const tab = await this.openFile(path);
    if (!tab || tab !== this.active) return;
    const loc = locateProblem(this.view.state.doc.toString(), p);
    const pos = loc?.from ?? 0;
    this.scrollToken++;
    this.view.dispatch({ selection: loc ? EditorSelection.range(loc.from, loc.to) : EditorSelection.cursor(0), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    this.view.focus();
  }

  private toggleSidebar() {
    this.sidebar.hidden = !this.sidebar.hidden;
    this.settings.sidebarVisible = !this.sidebar.hidden;
    saveSettings(this.settings);
    this.view.requestMeasure();
  }

  private toggleGit() {
    if (this.gitPanel.visible) this.gitPanel.hide();
    else this.gitPanel.show();
  }

  private scheduleGitRefresh(delay = 600) {
    if (!this.index) return;
    window.clearTimeout(this.gitTimer);
    this.gitTimer = window.setTimeout(() => void this.gitPanel.refresh(), delay);
  }

  /** Tree markers and status bar from the git status of both repos. */
  private onGitStatus(repos: RepoStatus[]) {
    const marks = new Map<string, GitMark>();
    const code = (f: GitFile): GitMark["code"] => {
      const l = statusLetter(f, isStaged(f) && f.worktree === ".");
      return (["M", "A", "?", "D", "R", "U"].includes(l) ? l : "M") as GitMark["code"];
    };
    for (const r of repos) {
      for (const f of r.files) {
        if (f.submodule) continue;
        if (r.kind === "course") marks.set(f.path, { code: code(f), alt: marks.get(f.path)?.alt ?? false });
        else if (f.taskPath) marks.set(f.taskPath, { code: marks.get(f.taskPath)?.code ?? null, alt: true });
      }
    }
    this.tree.setGitMarks(marks);
    const course = repos.find((r) => r.kind === "course");
    if (!course) {
      this.statusGit.hidden = true;
      return;
    }
    const changed = repos.reduce((n, r) => n + r.files.length, 0);
    const sync = `${course.ahead ? ` ↑${course.ahead}` : ""}${course.behind ? ` ↓${course.behind}` : ""}`;
    this.statusGit.hidden = false;
    this.statusGit.textContent = `⎇ ${course.branch ?? ui.git.detached}${sync}${changed ? ` · ${changed}` : ""}`;
    this.statusGit.title = repos.map((r) => `${r.kind === "altdir" ? ui.git.altdirRepo : ui.git.courseRepo}: ${r.branch ?? "–"}, ${ui.git.changes(r.files.length)}`).join("\n");
  }

  /** Diff of a file (as currently in the editor, if open) against HEAD. */
  private async diffFile(path: string, rel: string) {
    let head: string | null;
    try {
      head = await backend.gitHeadText(path);
    } catch (e) {
      return toast(String(e), "error");
    }
    const current = (await this.liveText(path)) ?? "";
    await showDiff({ title: ui.git.diffTitle(rel), head, current, open: () => void this.openFile(path) });
  }

  private togglePreview() {
    if (this.preview.visible) this.preview.hide();
    else {
      this.settings.previewVisible = true;
      saveSettings(this.settings);
      void this.preview.show().then(() => this.syncPreview());
    }
  }

  private syncPreview() {
    if (!this.preview.visible || !this.active) return;
    const sd = this.view.scrollDOM;
    const block = this.view.lineBlockAtHeight(sd.scrollTop);
    const atEnd = sd.scrollTop > 0 && sd.scrollTop + sd.clientHeight >= sd.scrollHeight - 2;
    this.preview.syncTo(atEnd ? Infinity : this.view.state.doc.lineAt(block.from).number - 1);
  }

  private refreshLints() {
    this.view.dispatch({ effects: lintRefresh.of(null) });
    forceLinting(this.view);
  }

  /** Open a file and put the cursor on a 0-based line. */
  private async openAt(path: string, line?: number) {
    const tab = await this.openFile(path);
    if (!tab || line === undefined || tab !== this.active) return;
    const l = this.view.state.doc.line(Math.min(line + 1, this.view.state.doc.lines));
    this.scrollToken++;
    this.view.dispatch({ selection: EditorSelection.cursor(l.from), effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 60 }) });
    this.view.focus();
  }

  async openFile(path: string, opts: { activate?: boolean; quiet?: boolean } = {}) {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      if (opts.activate !== false && existing !== this.active) this.activate(existing);
      return existing;
    }
    let file: TextFile;
    try {
      file = await backend.readTextFile(path);
    } catch (e) {
      if (!opts.quiet) toast(ui.file.openFailed(String(e)), "error");
      return null;
    }
    const part = this.index ? findPartByPath(this.index, path) : undefined;
    const rel = part?.rel ?? openableItems(this.index ?? emptyIndex()).find((i) => i.path === path)?.rel ?? path;
    let alt: AltTab | null = null;
    if (part?.kind === "task" && part.altdirPath && this.index?.altdirAvailable) {
      let altFile: TextFile = { text: "", eol: file.eol, bom: false, mixedEol: false };
      let exists = false;
      try {
        altFile = await backend.readTextFile(part.altdirPath);
        exists = true;
      } catch {
        /* no solution file yet: created on save */
      }
      alt = { path: part.altdirPath, exists, savedDoc: Text.of(altFile.text.split("\n")), diskText: altFile.text, eol: altFile.eol, bom: altFile.bom };
    }
    const tab: Tab = {
      path,
      name: baseName(path),
      rel,
      alt,
      state: this.makeState({ path }, file.text, alt ? { path: alt.path, doc: alt.savedDoc, exists: alt.exists } : null),
      savedDoc: null as unknown as Text,
      diskText: file.text,
      eol: file.eol,
      bom: file.bom,
      scrollTop: 0,
      deleted: false,
      wrap: this.lineWrap(),
    };
    tab.savedDoc = tab.state.doc;
    if (file.mixedEol && !opts.quiet) toast(ui.file.mixedEol(tab.name));
    const insertAt = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(insertAt, 0, tab);
    if (!path.toLowerCase().endsWith(".md")) {
      void loadOtherLanguage(path).then((ext) => {
        tab.state = tab.state.update({ effects: languageCompartment.reconfigure(ext) }).state;
        if (this.active === tab) this.view.setState(tab.state);
      });
    }
    if (opts.activate !== false) this.activate(tab);
    else this.renderTabs();
    this.persistTabs();
    return tab;
  }

  private activate(tab: Tab) {
    if (this.active && this.active !== tab) {
      this.active.scrollTop = this.view.scrollDOM.scrollTop;
      this.active.state = this.view.state;
    }
    this.active = tab;
    if (tab.alt) tab.state = tab.state.update({ effects: setSolutionsVisible.of(this.settings.showSolutions) }).state;
    if (tab.wrap !== this.lineWrap()) {
      tab.state = tab.state.update({ effects: wrapCompartment.reconfigure(this.lineWrap() ? EditorView.lineWrapping : []) }).state;
      tab.wrap = this.lineWrap();
    }
    this.view.setState(tab.state);
    const token = ++this.scrollToken;
    requestAnimationFrame(() => {
      // skipped if a jump to a position (openAt, problem click) happened in the meantime
      if (token === this.scrollToken) this.view.scrollDOM.scrollTop = tab.scrollTop;
      this.syncPreview();
    });
    this.preview.update(0);
    this.buildPanel.activeChanged();
    this.updateMainVisibility();
    this.renderTabs();
    this.updateStatus();
    const part = this.index ? findPartByPath(this.index, tab.path) : undefined;
    this.tree.reveal(part);
    this.tree.setActive(tab.path);
    if (part?.chapter) this.selectedTaskgroup = { chapter: part.chapter, taskgroup: part.taskgroup ?? part.name };
    this.persistTabs();
    this.view.focus();
  }

  private async closeTab(tab: Tab): Promise<boolean> {
    if (this.isDirty(tab)) {
      const choice = await showDialog<"save" | "discard" | "cancel">({
        title: ui.tabs.closeUnsavedTitle,
        body: ui.tabs.closeUnsaved(tab.name),
        buttons: [
          { label: ui.common.cancel, value: "cancel" },
          { label: ui.common.discard, value: "discard" },
          { label: ui.common.save, value: "save", primary: true },
        ],
        cancelValue: "cancel",
      });
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this.saveTab(tab))) return false;
    }
    if (tab === this.glossaryTab()) this.glossaryPanel.hide();
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else {
        this.view.setState(EditorState.create({ doc: "" }));
        this.preview.update(0);
        this.tree.setActive(null);
        this.updateMainVisibility();
      }
    }
    this.renderTabs();
    this.updateStatus();
    this.persistTabs();
    return true;
  }

  private renderTabs() {
    this.tabBar.replaceChildren(
      ...this.tabs.map((t) => {
        const dirty = this.isDirty(t);
        const close = h("button", { class: "tab-close", title: ui.common.close, "aria-label": ui.common.close }, "×");
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.closeTab(t);
        });
        const el = h(
          "div",
          { class: `tab${t === this.active ? " active" : ""}${dirty ? " dirty" : ""}`, role: "tab", title: t.rel },
          h("span", { class: "tab-name" }, t.name.replace(/\.md$/i, "")),
          h("span", { class: "tab-dirty", title: ui.tabs.unsaved }, "●"),
          close,
        );
        el.addEventListener("mousedown", (e) => {
          if (e.button === 1) {
            e.preventDefault();
            void this.closeTab(t);
          }
        });
        el.addEventListener("click", () => this.activate(t));
        return el;
      }),
    );
    const act = this.active;
    // „Speichern“ shows whether there is something to save
    this.saveBtn?.classList.toggle("has-changes", !!act && this.isDirty(act));
    void getCurrentWindow()
      .setTitle(act ? `${act.name}${this.isDirty(act) ? " ●" : ""} · ${ui.appName}` : ui.appName)
      .catch(() => {});
  }

  private lastDirty = new WeakMap<Tab, boolean>();
  private onEditorUpdate(u: ViewUpdate) {
    const tab = this.active;
    if (!tab || u.state !== this.view.state) return;
    if (u.docChanged || u.transactions.some((t) => t.effects.length)) {
      const dirty = this.isDirty(tab);
      if (this.lastDirty.get(tab) !== dirty) {
        this.lastDirty.set(tab, dirty);
        this.renderTabs();
      }
    }
    if (u.selectionSet || u.docChanged) this.updateCursor();
    if (u.docChanged || u.transactions.some((t) => t.effects.length)) this.preview.update();
    this.updateProblems();
  }

  // ----- saving

  private async saveActive() {
    const g = this.glossaryTab();
    if (g && this.glossaryPanel.hasFocus()) {
      if (g === this.active) g.state = this.view.state;
      await this.saveTab(g);
      return;
    }
    if (this.active) {
      this.active.state = this.view.state;
      await this.saveTab(this.active);
    }
  }

  private async saveTab(tab: Tab): Promise<boolean> {
    const doc = tab.state.doc;
    const text = doc.toString();
    try {
      await backend.writeTextFile(tab.path, text, tab.eol, tab.bom);
    } catch (e) {
      toast(ui.file.saveFailed(String(e)), "error");
      return false;
    }
    tab.savedDoc = doc;
    tab.diskText = text;
    tab.deleted = false;
    const altDoc = tab.alt && tab.state.field(altdirField, false)?.doc;
    if (tab.alt && altDoc && (this.altDirty(tab) || (!tab.alt.exists && altDoc.length > 0))) {
      const altText = altDoc.toString();
      try {
        if (tab.alt.exists) await backend.writeTextFile(tab.alt.path, altText, tab.alt.eol, tab.alt.bom);
        else {
          await backend.createFile(tab.alt.path, altText);
          tab.alt.exists = true;
          toast(ui.altdir.created(tab.alt.path));
        }
        tab.alt.savedDoc = altDoc;
        tab.alt.diskText = altText;
      } catch (e) {
        toast(ui.file.saveFailed(String(e)), "error");
        this.renderTabs();
        return false;
      }
    }
    this.lastDirty.set(tab, this.isDirty(tab));
    this.renderTabs();
    this.scheduleGitRefresh();
    toast(ui.file.saved(tab.name));
    return true;
  }

  // ----- external changes

  private async bindBackendEvents() {
    try {
      await events.onFileChanged((paths) => void this.onFilesChanged(paths));
      await events.onIndexChanged((index) => this.setIndex(index));
      await events.onIndexError((msg) => toast(msg, "error"));
      await events.onBuildLine((l) => {
        if (l.id === this.buildId || this.buildId === -1) this.buildPanel.line(l.line);
      });
      await events.onBuildDone((d) => {
        if (d.id === this.buildId || this.buildId === -1) this.buildPanel.finish(d);
      });
      await events.onLtStatus((st) => {
        this.ltStatus = st;
        this.updateLtStatus();
        if (st.state === "ready") this.grammar.refresh();
      });
      this.ltStatus = await backend.ltStatus();
    } catch {
      /* not running inside Tauri */
    }
    try {
      const win = getCurrentWindow();
      await win.onCloseRequested(async (event) => {
        if (this.active) this.active.state = this.view.state;
        const dirty = this.tabs.filter((t) => this.isDirty(t));
        this.persistTabs();
        await saveSettings(this.settings, true);
        if (!dirty.length) return;
        event.preventDefault();
        const quit = await showDialog({
          title: ui.tabs.closeUnsavedTitle,
          body: ui.tabs.quitUnsaved(dirty.length),
          buttons: [
            { label: ui.common.cancel, value: false },
            { label: ui.tabs.quit, value: true, primary: true },
          ],
          cancelValue: false,
        });
        if (quit) await win.destroy();
      });
    } catch {
      /* not running inside Tauri */
    }
  }

  private async onFilesChanged(paths: string[]) {
    const changed = new Set(paths);
    this.usagesCache = null;
    for (const p of paths) this.diskTextCache.delete(p);
    this.scheduleGitRefresh();
    this.preview.invalidate();
    const gp = this.index?.glossary?.path;
    if (gp && changed.has(gp) && !this.glossaryTab()) void this.loadGlossaryFromDisk();
    for (const tab of this.tabs) if (tab.alt && changed.has(tab.alt.path)) await this.onAltdirChanged(tab);
    if (this.includeCache.size) {
      this.includeCache.clear();
      this.refreshLints();
    }
    for (const tab of this.tabs) {
      if (!changed.has(tab.path)) continue;
      if (tab === this.active) tab.state = this.view.state;
      let file: TextFile;
      try {
        file = await backend.readTextFile(tab.path);
      } catch {
        if (!(await backend.pathExists(tab.path).catch(() => true))) {
          tab.deleted = true;
          toast(ui.file.deleted(tab.name), "error");
          this.renderTabs();
        }
        continue;
      }
      tab.deleted = false;
      if (file.text === tab.diskText) continue; // our own save, or no real change
      const dirty = !tab.state.doc.eq(tab.savedDoc);
      if (dirty) {
        const reload = await showDialog({
          title: ui.file.externalChangeTitle,
          body: ui.file.externalChange(tab.name),
          buttons: [
            { label: ui.file.keepMine, value: false },
            { label: ui.file.reload, value: true, primary: true },
          ],
          cancelValue: false,
        });
        tab.diskText = file.text;
        if (!reload) continue;
      } else {
        toast(ui.file.reloaded(tab.name));
      }
      this.replaceContent(tab, file);
    }
  }

  /** The solution file of an open task changed on disk. */
  private async onAltdirChanged(tab: Tab) {
    const alt = tab.alt!;
    let file: TextFile;
    try {
      file = await backend.readTextFile(alt.path);
    } catch {
      return; // deleted: keep the in-memory version; saving recreates it
    }
    if (file.text === alt.diskText) return;
    if (tab === this.active) tab.state = this.view.state;
    if (this.altDirty(tab)) {
      const reload = await showDialog({
        title: ui.file.externalChangeTitle,
        body: ui.altdir.externalChange(tab.name),
        buttons: [
          { label: ui.file.keepMine, value: false },
          { label: ui.file.reload, value: true, primary: true },
        ],
        cancelValue: false,
      });
      alt.diskText = file.text;
      if (!reload) return;
    } else {
      toast(ui.altdir.reloaded(tab.name));
    }
    const doc = Text.of(file.text.split("\n"));
    Object.assign(alt, { exists: true, savedDoc: doc, diskText: file.text, eol: file.eol, bom: file.bom });
    const spec = { effects: altdirLoad.of({ path: alt.path, doc, exists: true }), annotations: Transaction.addToHistory.of(false) };
    if (tab === this.active) this.view.dispatch(spec);
    else tab.state = tab.state.update(spec).state;
    this.renderTabs();
  }

  /** Replace a tab's content with disk content as one undoable transaction. */
  private replaceContent(tab: Tab, file: TextFile) {
    if (tab === this.active) tab.state = this.view.state;
    const tr = tab.state.update({ changes: { from: 0, to: tab.state.doc.length, insert: file.text } });
    tab.state = tr.state;
    tab.savedDoc = tab.state.doc;
    tab.diskText = file.text;
    tab.eol = file.eol;
    tab.bom = file.bom;
    if (tab === this.active) this.view.setState(tab.state);
    if (tab === this.glossaryTab()) {
      this.glossaryPanel.reset();
      this.onGlossaryChanged();
    }
    this.lastDirty.set(tab, false);
    this.renderTabs();
  }

  // ----- commands

  private quickOpen() {
    if (!this.index) return;
    quickOpen(openableItems(this.index), (p) => void this.openFile(p));
  }

  private async newTask() {
    if (!this.index) return;
    const req = await newTaskDialog(this.index, this.selectedTaskgroup);
    if (!req) return;
    try {
      const paths = await backend.newTaskPaths(req.chapter, req.taskgroup, req.name);
      let template = MINIMAL_TEMPLATE;
      try {
        template = (await backend.readTextFile(paths.template)).text;
      } catch {
        toast(ui.newTask.noTemplate);
      }
      await backend.createFile(paths.task, template);
      if (req.withAltdir && paths.altdir) await backend.createFile(paths.altdir, "");
      this.setIndex(await backend.refreshIndex());
      await this.openFile(paths.task);
    } catch (e) {
      toast(String(e), "error");
    }
  }

  private async openSettings() {
    const result = await settingsDialog(this.settings, { defaultOutDir: () => backend.buildDefaultOutdir(), testSedrila: (cmd) => backend.sedrilaTest(cmd) });
    if (!result) return;
    if (result.changeCourse) return void this.chooseCourse();
    const languageChanged = result.values.uiLanguage !== this.settings.uiLanguage;
    Object.assign(this.settings, result.values);
    if (languageChanged) {
      await saveSettings(this.settings, true);
      // rebuilding the window is simplest; only without unsaved changes, otherwise on next start
      if (!this.tabs.some((t) => this.isDirty(t))) return location.reload();
      toast(ui.settings.languageRestart);
    }
    this.applyFontSettings();
    this.grammar.updateSettings(this.grammarSettings());
    if (this.active && this.active.wrap !== this.lineWrap()) this.activate(this.active);
    this.view.requestMeasure();
    saveSettings(this.settings);
  }

  private bindGlobalKeys() {
    document.addEventListener(
      "keydown",
      (e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || e.altKey) return;
        const key = e.key.toLowerCase();
        let handled = true;
        if (key === "s" && !e.shiftKey) void this.saveActive();
        else if (key === "p" && !e.shiftKey) this.quickOpen();
        else if (key === "w" && !e.shiftKey) this.active && void this.closeTab(this.active);
        else if (key === "n" && !e.shiftKey) void this.newTask();
        else if (key === "l" && e.shiftKey) this.toggleSolutions();
        else if (key === "v" && e.shiftKey) this.togglePreview();
        else if (key === "b" && !e.shiftKey) void this.buildPanel.run();
        else if (key === "g" && e.shiftKey) this.toggleGit();
        else if (key === "e" && e.shiftKey) this.toggleSidebar();
        else if (key === "d" && e.shiftKey && this.active) void this.diffFile(this.active.path, this.active.rel);
        else if (e.key === "Tab" && e.ctrlKey && this.tabs.length > 1 && this.active) {
          const i = this.tabs.indexOf(this.active);
          this.activate(this.tabs[(i + (e.shiftKey ? -1 : 1) + this.tabs.length) % this.tabs.length]);
        } else handled = false;
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  // ----- status bar

  private showLogs(tab: LogTab) {
    return openLogs(
      {
        read: () => backend.readLogs(),
        openDir: () => backend.openLogDir(),
        restartLt: async () => {
          this.ltStatus = { state: "starting", message: null };
          this.updateLtStatus();
          await backend.ltRestart();
        },
        ltStatus: () => this.ltStatus,
      },
      tab,
    );
  }

  private updateLtStatus() {
    if (!this.grammar) return;
    const st = this.ltStatus;
    this.statusLt.textContent = ltLabel(st, this.settings.grammarEnabled, this.grammar.client.pending);
    this.statusLt.className = `status-lt lt-${st.state}`;
    this.statusLt.title = [st.message?.split("\n")[0], ui.logs.statusHint].filter(Boolean).join("\n");
  }

  private lastProblemCount = -1;
  private updateProblems() {
    const n = this.active ? diagnosticCount(this.view.state) : 0;
    if (n === this.lastProblemCount) return;
    this.lastProblemCount = n;
    this.statusProblems.textContent = n ? ui.problems.count(n) : "";
    this.statusProblems.hidden = n === 0;
  }

  private updateCursor() {
    if (!this.active) {
      this.statusPos.textContent = "";
      return;
    }
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.head);
    this.statusPos.textContent = ui.status.position(line.number, sel.head - line.from + 1);
  }

  private updateStatus() {
    const t = this.active;
    // the path is cut at the start („…/Git/x.md“), the encoding info never
    this.statusPath.textContent = t ? t.rel : ui.status.noFile;
    this.statusLeft.title = t ? t.path : "";
    this.statusFile.textContent = t ? `·  ${t.eol === "\r\n" ? "CRLF" : "LF"}${t.bom ? " · BOM" : ""}  ·  UTF-8` : "";
    this.statusRight.textContent = this.index && !this.index.altdirAvailable ? ui.status.noAltdir : "";
    this.updateLtStatus();
    this.updateCursor();
  }
}

// German prose for measuring the average character width of the prose font
const WIDTH_SAMPLE = "Öffnen Sie ein Terminal und geben Sie das Kommando ein. Was bedeutet die Option, die Sie verwendet haben?";

/** Pixel width of `columns` characters (average over German prose) plus the line padding. */
function wrapWidth(font: string, sizePx: number, columns: number): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return columns * sizePx * 0.6;
  ctx.font = `${sizePx}px ${font}`;
  const avg = ctx.measureText(WIDTH_SAMPLE).width / WIDTH_SAMPLE.length;
  return avg * Math.max(20, columns) + 16;
}

function ltLabel(st: LtStatus, enabled: boolean, pending: number): string {
  if (!enabled) return ui.grammar.status.disabled;
  if (st.state === "ready") return pending ? `${ui.grammar.status.ready}, ${ui.grammar.checking(pending)}` : ui.grammar.status.ready;
  if (st.state === "starting") return st.message ? `${ui.grammar.status.starting} ${st.message}` : ui.grammar.status.starting;
  if (st.state === "error") return ui.grammar.status.error;
  return ui.grammar.status.stopped;
}

function modKey() {
  return navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Strg";
}

function emptyIndex(): CourseIndex {
  return {
    config: { root: "", chapterdir: "", altdir: null, itreedir: null, stages: [], blockMacros: [], sectionTypes: {}, chapters: [], topmatter: {}, baseresourcedir: null },
    chapters: [],
    glossary: null,
    glossaryTerms: [],
    topFiles: [],
    includeFiles: [],
    unconfigured: [],
    duplicateNames: [],
    altdirAvailable: false,
  };
}
