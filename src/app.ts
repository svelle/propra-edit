// Main application controller: course, tabs, the single EditorView, saving and
// reacting to external file changes.

import { EditorView, type ViewUpdate } from "@codemirror/view";
import { EditorState, type Text } from "@codemirror/state";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { backend, events, type CourseIndex, type LtStatus, type TextFile } from "./backend";
import { findPartByPath, hasTopMatter, openableItems, parserConfigFor, partNames } from "./course";
import { GrammarService } from "./grammar/grammar";
import { createState, languageCompartment, loadOtherLanguage, wrapCompartment } from "./editor/setup";
import { de } from "./i18n/de";
import { FileTree } from "./panels/filetree";
import { newTaskDialog } from "./panels/newtask";
import { quickOpen } from "./panels/quickopen";
import { settingsDialog } from "./panels/settingsdialog";
import { loadSettings, saveSettings, type Settings } from "./settings";
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
  private statusLeft = h("span", { class: "status-left" });
  private statusPos = h("span", { class: "status-pos" });
  private statusRight = h("span", { class: "status-right" });
  private statusLt = h("button", { class: "status-lt", title: de.grammar.restartHint });
  private grammar!: GrammarService;
  private ltStatus: LtStatus = { state: "starting", message: null };

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
    this.statusLt.addEventListener("click", () => {
      this.ltStatus = { state: "starting", message: null };
      this.updateLtStatus();
      void backend.ltRestart().catch((e) => toast(String(e), "error"));
    });
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
    } else {
      this.showWelcome();
    }
  }

  // ----- layout

  private buildLayout(root: HTMLElement) {
    const btn = (label: string, title: string, onclick: () => void) => h("button", { class: "tool", title, onclick }, label);
    const toolbar = h(
      "header",
      { class: "toolbar" },
      btn(de.toolbar.openCourse, de.toolbar.openCourse, () => void this.chooseCourse()),
      btn(de.toolbar.newTask, `${de.toolbar.newTask} (${modKey()}+N)`, () => void this.newTask()),
      btn(de.toolbar.save, `${de.toolbar.save} (${modKey()}+S)`, () => void this.saveActive()),
      btn(de.toolbar.quickOpen, `${de.toolbar.quickOpen} (${modKey()}+P)`, () => this.quickOpen()),
      h("span", { class: "spacer" }),
      btn("⚙", de.toolbar.settings, () => void this.openSettings()),
    );
    const sidebar = h("aside", { class: "sidebar" }, this.tree.dom);
    sidebar.style.width = `${this.settings.sidebarWidth}px`;
    const resizer = h("div", { class: "resizer" });
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
    const main = h("main", { class: "main" }, this.tabBar, this.editorHost, this.welcome);
    const status = h("footer", { class: "statusbar" }, this.statusLeft, this.statusPos, h("span", { class: "spacer" }), this.statusRight, this.statusLt);
    root.replaceChildren(toolbar, h("div", { class: "workspace" }, sidebar, resizer, main), status);
  }

  private applyFontSettings() {
    document.documentElement.style.setProperty("--editor-font", this.settings.fontFamily);
    document.documentElement.style.setProperty("--editor-font-size", `${this.settings.fontSize}px`);
  }

  private showWelcome(message?: string) {
    this.welcome.replaceChildren(
      h("h1", {}, de.welcome.title),
      h("p", {}, de.welcome.text),
      message ? h("p", { class: "form-error" }, message) : "",
      h("button", { class: "primary", onclick: () => void this.chooseCourse() }, de.welcome.choose),
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
    const dir = await openDialog({ directory: true, multiple: false, title: de.welcome.choose }).catch(() => null);
    if (typeof dir !== "string") return;
    if (!(await backend.isCourseRoot(dir))) {
      toast(de.welcome.notACourse(dir), "error");
      if (!this.index) this.showWelcome(de.welcome.notACourse(dir));
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
      this.showWelcome(de.welcome.loadFailed(String(e)));
      return false;
    }
  }

  private grammarSettings() {
    return { enabled: this.settings.grammarEnabled, disabledRules: this.settings.ltDisabledRules, enabledRules: this.settings.ltEnabledRules };
  }

  private setIndex(index: CourseIndex) {
    this.index = index;
    this.grammar.setAcceptedNames([...partNames(index), ...index.glossaryTerms.flatMap((t) => t.names)]);
    this.tree.setIndex(index);
    this.tree.setActive(this.active?.path ?? null);
    this.updateStatus();
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
    return !tab.state.doc.eq(tab.savedDoc) || tab.deleted;
  }

  private makeState(tab: { path: string }, text: string): EditorState {
    const isMarkdown = tab.path.toLowerCase().endsWith(".md");
    return createState(text, {
      path: tab.path,
      isMarkdown,
      topMatter: isMarkdown && hasTopMatter(this.index, tab.path, text),
      parserConfig: parserConfigFor(this.index),
      softWrap: this.settings.softWrap,
      extra: EditorView.updateListener.of((u: ViewUpdate) => this.onEditorUpdate(u)),
      markdownExtra: [this.grammar.extension()],
    });
  }

  async openFile(path: string, opts: { activate?: boolean; quiet?: boolean } = {}) {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      if (opts.activate !== false) this.activate(existing);
      return existing;
    }
    let file: TextFile;
    try {
      file = await backend.readTextFile(path);
    } catch (e) {
      if (!opts.quiet) toast(de.file.openFailed(String(e)), "error");
      return null;
    }
    const part = this.index ? findPartByPath(this.index, path) : undefined;
    const rel = part?.rel ?? openableItems(this.index ?? emptyIndex()).find((i) => i.path === path)?.rel ?? path;
    const tab: Tab = {
      path,
      name: baseName(path),
      rel,
      state: this.makeState({ path }, file.text),
      savedDoc: null as unknown as Text,
      diskText: file.text,
      eol: file.eol,
      bom: file.bom,
      scrollTop: 0,
      deleted: false,
      wrap: this.settings.softWrap,
    };
    tab.savedDoc = tab.state.doc;
    if (file.mixedEol && !opts.quiet) toast(de.file.mixedEol(tab.name));
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
    if (tab.wrap !== this.settings.softWrap) {
      tab.state = tab.state.update({ effects: wrapCompartment.reconfigure(this.settings.softWrap ? EditorView.lineWrapping : []) }).state;
      tab.wrap = this.settings.softWrap;
    }
    this.view.setState(tab.state);
    requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = tab.scrollTop));
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
        title: de.tabs.closeUnsavedTitle,
        body: de.tabs.closeUnsaved(tab.name),
        buttons: [
          { label: de.common.cancel, value: "cancel" },
          { label: de.common.discard, value: "discard" },
          { label: de.common.save, value: "save", primary: true },
        ],
        cancelValue: "cancel",
      });
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this.saveTab(tab))) return false;
    }
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else {
        this.view.setState(EditorState.create({ doc: "" }));
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
        const close = h("button", { class: "tab-close", title: de.common.close, "aria-label": de.common.close }, "×");
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.closeTab(t);
        });
        const el = h(
          "div",
          { class: `tab${t === this.active ? " active" : ""}${dirty ? " dirty" : ""}`, role: "tab", title: t.rel },
          h("span", { class: "tab-name" }, t.name),
          h("span", { class: "tab-dirty", title: de.tabs.unsaved }, "●"),
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
    void getCurrentWindow()
      .setTitle(act ? `${act.name}${this.isDirty(act) ? " ●" : ""} · ${de.appName}` : de.appName)
      .catch(() => {});
  }

  private lastDirty = new WeakMap<Tab, boolean>();
  private onEditorUpdate(u: ViewUpdate) {
    const tab = this.active;
    if (!tab || u.state !== this.view.state) return;
    if (u.docChanged) {
      const dirty = this.isDirty(tab);
      if (this.lastDirty.get(tab) !== dirty) {
        this.lastDirty.set(tab, dirty);
        this.renderTabs();
      }
    }
    if (u.selectionSet || u.docChanged) this.updateCursor();
  }

  // ----- saving

  private async saveActive() {
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
      toast(de.file.saveFailed(String(e)), "error");
      return false;
    }
    tab.savedDoc = doc;
    tab.diskText = text;
    tab.deleted = false;
    this.lastDirty.set(tab, this.isDirty(tab));
    this.renderTabs();
    toast(de.file.saved(tab.name));
    return true;
  }

  // ----- external changes

  private async bindBackendEvents() {
    try {
      await events.onFileChanged((paths) => void this.onFilesChanged(paths));
      await events.onIndexChanged((index) => this.setIndex(index));
      await events.onIndexError((msg) => toast(msg, "error"));
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
          title: de.tabs.closeUnsavedTitle,
          body: de.tabs.quitUnsaved(dirty.length),
          buttons: [
            { label: de.common.cancel, value: false },
            { label: de.tabs.quit, value: true, primary: true },
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
    for (const tab of this.tabs) {
      if (!changed.has(tab.path)) continue;
      if (tab === this.active) tab.state = this.view.state;
      let file: TextFile;
      try {
        file = await backend.readTextFile(tab.path);
      } catch {
        if (!(await backend.pathExists(tab.path).catch(() => true))) {
          tab.deleted = true;
          toast(de.file.deleted(tab.name), "error");
          this.renderTabs();
        }
        continue;
      }
      tab.deleted = false;
      if (file.text === tab.diskText) continue; // our own save, or no real change
      const dirty = !tab.state.doc.eq(tab.savedDoc);
      if (dirty) {
        const reload = await showDialog({
          title: de.file.externalChangeTitle,
          body: de.file.externalChange(tab.name),
          buttons: [
            { label: de.file.keepMine, value: false },
            { label: de.file.reload, value: true, primary: true },
          ],
          cancelValue: false,
        });
        tab.diskText = file.text;
        if (!reload) continue;
      } else {
        toast(de.file.reloaded(tab.name));
      }
      this.replaceContent(tab, file);
    }
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
        toast(de.newTask.noTemplate);
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
    const result = await settingsDialog(this.settings);
    if (!result) return;
    if (result.changeCourse) return void this.chooseCourse();
    Object.assign(this.settings, result.values);
    this.applyFontSettings();
    this.grammar.updateSettings(this.grammarSettings());
    if (this.active && this.active.wrap !== this.settings.softWrap) this.activate(this.active);
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

  private updateLtStatus() {
    if (!this.grammar) return;
    const st = this.ltStatus;
    this.statusLt.textContent = ltLabel(st, this.settings.grammarEnabled, this.grammar.client.pending);
    this.statusLt.className = `status-lt lt-${st.state}`;
    this.statusLt.title = [st.message, de.grammar.restartHint].filter(Boolean).join("\n");
  }

  private updateCursor() {
    if (!this.active) {
      this.statusPos.textContent = "";
      return;
    }
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.head);
    this.statusPos.textContent = de.status.position(line.number, sel.head - line.from + 1);
  }

  private updateStatus() {
    const t = this.active;
    this.statusLeft.textContent = t ? `${t.rel}  ·  ${t.eol === "\r\n" ? "CRLF" : "LF"}${t.bom ? " · BOM" : ""}  ·  UTF-8` : de.status.noFile;
    this.statusRight.textContent = this.index && !this.index.altdirAvailable ? de.status.noAltdir : "";
    this.updateLtStatus();
    this.updateCursor();
  }
}

function ltLabel(st: LtStatus, enabled: boolean, pending: number): string {
  if (!enabled) return de.grammar.status.disabled;
  if (st.state === "ready") return pending ? `${de.grammar.status.ready}, ${de.grammar.checking(pending)}` : de.grammar.status.ready;
  if (st.state === "starting") return st.message ? `${de.grammar.status.starting} ${st.message}` : de.grammar.status.starting;
  if (st.state === "error") return de.grammar.status.error;
  return de.grammar.status.stopped;
}

function modKey() {
  return navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Strg";
}

function emptyIndex(): CourseIndex {
  return {
    config: { root: "", chapterdir: "", altdir: null, itreedir: null, stages: [], blockMacros: [], sectionTypes: {}, chapters: [] },
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
