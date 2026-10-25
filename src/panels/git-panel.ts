// Git panel: one section per repository (course repo, altdir repo) with branch, pull/push,
// staged and unstaged changes, commit message and commit. Committing altdir stages the moved
// submodule pointer in the course repo, so "altdir first, then course" leaves both clean.

import type { GitFile, RepoStatus } from "../backend";
import { de } from "../i18n/de";
import { h, showDialog, toast } from "../ui/dom";

export interface GitPanelDeps {
  status(): Promise<RepoStatus[]>;
  stage(root: string, rels: string[]): Promise<void>;
  unstage(root: string, rels: string[], hasCommits: boolean): Promise<void>;
  commit(root: string, message: string): Promise<string>;
  push(root: string, hasUpstream: boolean): Promise<string>;
  pull(root: string): Promise<string>;
  open(path: string): void;
  diff(file: GitFile): void;
  /** Save unsaved tabs before staging/committing (git works on files on disk). */
  saveAll(): Promise<void>;
  statusChanged(repos: RepoStatus[]): void;
  closed(): void;
}

export const isStaged = (f: GitFile) => !f.untracked && f.index !== "." && f.index !== "?";
export const isUnstaged = (f: GitFile) => f.untracked || f.worktree !== "." || f.conflict;

/** One letter for display: M, A, D, R, U (conflict), ? (new, untracked). */
export function statusLetter(f: GitFile, staged: boolean): string {
  if (f.conflict) return "U";
  if (f.untracked) return "?";
  return staged ? f.index : f.worktree;
}

export class GitPanel {
  readonly dom: HTMLElement;
  private body = h("div", { class: "gp-body" });
  private repos: RepoStatus[] = [];
  private messages = new Map<string, string>();
  private busy = new Set<string>();
  private error: string | null = null;
  private refreshing: Promise<void> | null = null;
  private again = false;
  visible = false;

  constructor(private deps: GitPanelDeps) {
    const close = h("button", { class: "rp-close", title: de.common.close, "aria-label": de.common.close }, "×");
    close.addEventListener("click", () => this.hide());
    const refresh = h("button", { class: "rp-close", title: de.git.refresh, "aria-label": de.git.refresh }, "↻");
    refresh.addEventListener("click", () => void this.refresh());
    this.dom = h("aside", { class: "rightpanel git-panel", hidden: true }, h("div", { class: "rp-header" }, h("span", { class: "rp-heading" }, de.git.title), refresh, close), this.body);
  }

  get status(): RepoStatus[] {
    return this.repos;
  }

  show() {
    this.visible = true;
    this.dom.hidden = false;
    void this.refresh();
  }

  hide() {
    this.visible = false;
    this.dom.hidden = true;
    this.deps.closed();
  }

  /** Re-read the status of both repos (coalesces overlapping calls). */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        try {
          this.repos = await this.deps.status();
          this.error = null;
        } catch (e) {
          this.repos = [];
          this.error = String(e);
        }
      } while (this.again);
      this.deps.statusChanged(this.repos);
      if (this.visible) this.render();
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private repoLabel(r: RepoStatus) {
    return r.kind === "altdir" ? de.git.altdirRepo : de.git.courseRepo;
  }

  private async act(root: string, fn: () => Promise<unknown>) {
    if (this.busy.has(root)) return;
    this.busy.add(root);
    this.render();
    try {
      await fn();
    } catch (e) {
      await showDialog({ title: de.git.failed, body: h("pre", { class: "gp-output" }, String(e)), buttons: [{ label: de.common.ok, value: true, primary: true }], cancelValue: true });
    } finally {
      this.busy.delete(root);
      await this.refresh();
    }
  }

  private async doCommit(r: RepoStatus) {
    const msg = (this.messages.get(r.root) ?? "").trim();
    if (!msg) return toast(de.git.emptyMessage, "error");
    const alt = this.repos.find((x) => x.kind === "altdir");
    if (r.kind === "course" && alt && alt.files.some(isStaged)) {
      const choice = await showDialog<"alt" | "course" | "cancel">({
        title: de.git.altFirstTitle,
        body: de.git.altFirst,
        buttons: [
          { label: de.common.cancel, value: "cancel" },
          { label: de.git.courseOnly, value: "course" },
          { label: de.git.altThenCourse, value: "alt", primary: true },
        ],
        cancelValue: "cancel",
      });
      if (choice === "cancel") return;
      if (choice === "alt") {
        const altMsg = (this.messages.get(alt.root) ?? "").trim() || msg;
        await this.act(alt.root, async () => {
          await this.deps.saveAll();
          await this.deps.commit(alt.root, altMsg);
          this.messages.delete(alt.root);
          await this.stagePointer();
        });
      }
    }
    await this.act(r.root, async () => {
      await this.deps.saveAll();
      await this.deps.commit(r.root, msg);
      this.messages.delete(r.root);
      toast(de.git.committed(this.repoLabel(r)));
    });
  }

  /** After an altdir commit: stage the course repo's submodule pointer. */
  private async stagePointer() {
    const st = await this.deps.status();
    const course = st.find((x) => x.kind === "course");
    const ptr = course?.submoduleRel && course.files.find((f) => f.rel === course.submoduleRel && f.submodule);
    if (course && ptr) {
      await this.deps.stage(course.root, [ptr.rel]);
      toast(de.git.pointerStaged);
    }
  }

  private fileRow(r: RepoStatus, f: GitFile, staged: boolean) {
    const letter = statusLetter(f, staged);
    const name = f.submodule ? de.git.submodulePointer(f.rel) : f.rel;
    const btn = h("button", { class: "gp-btn", title: staged ? de.git.unstage : de.git.stage }, staged ? "−" : "+");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.act(r.root, async () => {
        await this.deps.saveAll();
        if (staged) await this.deps.unstage(r.root, [f.rel], r.hasCommits);
        else await this.deps.stage(r.root, [f.rel]);
      });
    });
    const open = h("button", { class: "gp-btn", title: de.git.openFile }, "↗");
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deps.open(f.path);
    });
    const row = h(
      "div",
      { class: `gp-file gp-${letter === "?" ? "new" : letter}`, title: `${f.rel}${f.origRel ? ` (${de.git.renamedFrom} ${f.origRel})` : ""}\n${de.git.clickDiff}` },
      h("span", { class: "gp-letter" }, letter),
      h("span", { class: "gp-name" }, name),
      f.submodule ? null : open,
      btn,
    );
    row.addEventListener("click", () => (f.submodule ? undefined : this.deps.diff(f)));
    return row;
  }

  private section(title: string, files: HTMLElement[], action?: HTMLElement) {
    return h("div", { class: "gp-section" }, h("div", { class: "gp-section-head" }, h("span", {}, title), action ?? null), ...files);
  }

  private repoView(r: RepoStatus) {
    const busy = this.busy.has(r.root);
    const staged = r.files.filter(isStaged);
    const unstaged = r.files.filter(isUnstaged);
    const branch = r.branch ?? de.git.detached;
    const sync = r.upstream ? `${r.ahead ? ` ↑${r.ahead}` : ""}${r.behind ? ` ↓${r.behind}` : ""}` : ` (${de.git.noUpstream})`;
    const pull = h("button", { class: "tool", disabled: busy || !r.upstream, title: de.git.pullTitle }, de.git.pull);
    pull.addEventListener("click", () =>
      void this.act(r.root, async () => {
        const out = await this.deps.pull(r.root);
        toast(/already up.to.date|bereits aktuell/i.test(out) ? de.git.upToDate : de.git.pulled);
      }),
    );
    const push = h("button", { class: "tool", disabled: busy || !r.hasCommits || (!!r.upstream && r.ahead === 0), title: de.git.pushTitle }, de.git.push);
    push.addEventListener("click", () =>
      void this.act(r.root, async () => {
        await this.deps.push(r.root, !!r.upstream);
        toast(de.git.pushed(this.repoLabel(r)));
      }),
    );
    const stageAll = h("button", { class: "gp-link", disabled: busy }, de.git.stageAll);
    stageAll.addEventListener("click", () =>
      void this.act(r.root, async () => {
        await this.deps.saveAll();
        await this.deps.stage(r.root, unstaged.map((f) => f.rel));
      }),
    );
    const msg = h("textarea", { class: "gp-message", rows: 3, placeholder: de.git.messagePlaceholder(this.repoLabel(r)), spellcheck: "true", lang: "de" }) as HTMLTextAreaElement;
    msg.value = this.messages.get(r.root) ?? "";
    const commit = h("button", { class: "primary", disabled: busy || !staged.length }, de.git.commit(staged.length));
    msg.addEventListener("input", () => this.messages.set(r.root, msg.value));
    msg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit.click();
      }
    });
    commit.addEventListener("click", () => void this.doCommit(r));
    return h(
      "div",
      { class: `gp-repo${busy ? " busy" : ""}` },
      h("div", { class: "gp-repo-head" }, h("strong", {}, this.repoLabel(r)), h("span", { class: "gp-branch", title: r.root }, `⎇ ${branch}${sync}`), h("span", { class: "spacer" }), pull, push),
      staged.length ? this.section(de.git.staged(staged.length), staged.map((f) => this.fileRow(r, f, true))) : null,
      unstaged.length ? this.section(de.git.changes(unstaged.length), unstaged.map((f) => this.fileRow(r, f, false)), stageAll) : null,
      !staged.length && !unstaged.length ? h("div", { class: "gp-clean" }, de.git.clean) : null,
      msg,
      h("div", { class: "gp-commit-row" }, commit),
    );
  }

  private render() {
    if (this.error) {
      this.body.replaceChildren(h("div", { class: "gp-error" }, this.error));
      return;
    }
    if (!this.repos.length) {
      this.body.replaceChildren(h("div", { class: "gp-clean" }, de.git.noRepo));
      return;
    }
    // keep focus and caret in a message box across re-renders
    const active = document.activeElement;
    const focusRoot = active instanceof HTMLTextAreaElement && this.body.contains(active) ? active.closest(".gp-repo")?.getAttribute("data-root") : null;
    const caret = active instanceof HTMLTextAreaElement ? active.selectionStart : 0;
    // altdir first: that is the order to commit in
    const ordered = [...this.repos].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "altdir" ? -1 : 1));
    this.body.replaceChildren(
      ...ordered.map((r) => {
        const v = this.repoView(r);
        v.setAttribute("data-root", r.root);
        return v;
      }),
    );
    if (focusRoot) {
      const ta = [...this.body.querySelectorAll<HTMLElement>(".gp-repo")].find((e) => e.getAttribute("data-root") === focusRoot)?.querySelector("textarea");
      ta?.focus();
      ta?.setSelectionRange(caret, caret);
    }
  }
}
