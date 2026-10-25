// Bottom panel for sedrila builds: status with elapsed time, cancel, problem list (linked to
// files) and the colored console output.

import { ansiSegments, BuildOutputParser, isShellNoise, problemMessage, stripAnsi, type BuildProblem, type BuildSummary } from "../build/output";
import { de } from "../i18n/de";
import { h } from "../ui/dom";

export interface BuildPanelDeps {
  /** Start a build; resolves with the command line, or rejects. */
  start(): Promise<string>;
  cancel(): void;
  openPage(): void;
  /** Can the built page of the active file be opened? */
  canOpenPage(): boolean;
  openProblem(p: BuildProblem): void;
  /** Path (relative, `/`-separated) of the active file, to filter problems. */
  activeRel(): string | null;
  problemsChanged(summary: BuildSummary): void;
  closed(): void;
  height: number;
  setHeight(px: number): void;
}

type Filter = "all" | "errors" | "file";
const MAX_LINES = 20000;

export class BuildPanel {
  readonly dom: HTMLElement;
  private status = h("span", { class: "bp-status" });
  private runBtn = h("button", { class: "tool" }, de.build.run);
  private cancelBtn = h("button", { class: "tool" }, de.build.cancel);
  private pageBtn = h("button", { class: "tool" }, de.build.openPage);
  private tabProblems = h("button", { class: "bp-tab active" });
  private tabOutput = h("button", { class: "bp-tab" }, de.build.output);
  private filter = h("select", { class: "bp-filter" }) as HTMLSelectElement;
  private problemsEl = h("div", { class: "bp-problems" });
  private outputEl = h("pre", { class: "bp-output", hidden: true });
  private parser = new BuildOutputParser();
  private pending: string[] = [];
  private flushScheduled = false;
  private lineCount = 0;
  private running = false;
  private startedAt = 0;
  private timer: number | undefined;
  private shownProblems = -1;
  visible = false;

  constructor(private deps: BuildPanelDeps) {
    for (const [v, label] of [
      ["all", de.build.filterAll],
      ["errors", de.build.filterErrors],
      ["file", de.build.filterFile],
    ] as [Filter, string][])
      this.filter.append(h("option", { value: v }, label));
    this.filter.addEventListener("change", () => this.renderProblems());
    this.runBtn.addEventListener("click", () => void this.run());
    this.cancelBtn.addEventListener("click", () => deps.cancel());
    this.pageBtn.addEventListener("click", () => deps.openPage());
    this.tabProblems.addEventListener("click", () => this.showTab("problems"));
    this.tabOutput.addEventListener("click", () => this.showTab("output"));
    const close = h("button", { class: "rp-close", title: de.common.close, "aria-label": de.common.close }, "×");
    close.addEventListener("click", () => this.hide());
    const grip = h("div", { class: "bp-grip" });
    grip.addEventListener("pointerdown", (e) => {
      grip.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = this.dom.offsetHeight;
      const move = (ev: PointerEvent) => (this.dom.style.height = `${Math.max(120, Math.min(window.innerHeight - 200, startH - (ev.clientY - startY)))}px`);
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", () => {
        grip.removeEventListener("pointermove", move);
        deps.setHeight(this.dom.offsetHeight);
      }, { once: true });
    });
    this.dom = h(
      "section",
      { class: "build-panel", hidden: true },
      grip,
      h("div", { class: "bp-header" }, h("span", { class: "rp-heading" }, de.build.title), this.tabProblems, this.tabOutput, this.filter, this.status, h("span", { class: "spacer" }), this.runBtn, this.cancelBtn, this.pageBtn, close),
      this.problemsEl,
      this.outputEl,
    );
    this.dom.style.height = `${deps.height}px`;
    this.updateButtons();
    this.renderProblems();
  }

  get isRunning() {
    return this.running;
  }

  show() {
    this.visible = true;
    this.dom.hidden = false;
  }

  hide() {
    this.visible = false;
    this.dom.hidden = true;
    this.deps.closed();
  }

  /** Start a build (also shows the panel). */
  async run() {
    if (this.running) return;
    this.show();
    this.parser = new BuildOutputParser();
    this.outputEl.replaceChildren();
    this.lineCount = 0;
    this.pending = [];
    this.running = true;
    this.startedAt = Date.now();
    this.updateButtons();
    this.renderProblems();
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 1000);
    try {
      const cmd = await this.deps.start();
      this.appendRaw(`\x1b[2m$ ${cmd}\x1b[0m`);
    } catch (e) {
      this.finish({ code: null, elapsedMs: 0, cancelled: false, error: String(e) });
    }
  }

  /** Called for every `build-line` event of the current build. */
  line(raw: string) {
    if (!this.running) return;
    const plain = stripAnsi(raw);
    if (isShellNoise(plain)) return;
    this.parser.push(raw);
    this.appendRaw(raw);
  }

  /** Called for the `build-done` event. */
  finish(d: { code: number | null; elapsedMs: number; cancelled: boolean; error: string | null }) {
    this.flush();
    this.running = false;
    clearInterval(this.timer);
    const s = this.parser.summary();
    const errors = s.problems.filter((p) => p.severity === "error").length;
    const warnings = s.problems.length - errors;
    let text: string;
    let cls = "";
    if (d.error) {
      text = de.build.startFailed(d.error);
      cls = "bp-bad";
    } else if (d.cancelled) text = de.build.cancelled;
    else if (s.errorCount === null) {
      text = de.build.noSummary(d.code);
      cls = "bp-bad";
    } else {
      text = de.build.done(s.errorCount, warnings, (d.elapsedMs / 1000).toFixed(1).replace(".", ","));
      cls = s.errorCount > 0 || errors > 0 ? "bp-bad" : "bp-good";
    }
    this.status.textContent = text;
    this.status.className = `bp-status ${cls}`;
    this.updateButtons();
    this.renderProblems();
    this.deps.problemsChanged(s);
    if (!s.problems.length && (d.error || s.errorCount === null)) this.showTab("output");
  }

  /** Re-filter when the active file changes. */
  activeChanged() {
    if (this.filter.value === "file") this.renderProblems();
    this.updateButtons();
  }

  private tick() {
    const secs = Math.round((Date.now() - this.startedAt) / 1000);
    this.status.textContent = de.build.running(secs);
    this.status.className = "bp-status";
  }

  private updateButtons() {
    this.runBtn.hidden = this.running;
    this.cancelBtn.hidden = !this.running;
    (this.pageBtn as HTMLButtonElement).disabled = this.running || !this.deps.canOpenPage();
  }

  private showTab(tab: "problems" | "output") {
    this.tabProblems.classList.toggle("active", tab === "problems");
    this.tabOutput.classList.toggle("active", tab === "output");
    this.problemsEl.hidden = tab !== "problems";
    this.filter.hidden = tab !== "problems";
    this.outputEl.hidden = tab !== "output";
    if (tab === "output") this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private appendRaw(raw: string) {
    this.pending.push(raw);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  private flush() {
    this.flushScheduled = false;
    if (!this.pending.length) return;
    const atBottom = this.outputEl.scrollTop + this.outputEl.clientHeight >= this.outputEl.scrollHeight - 4;
    const frag = document.createDocumentFragment();
    for (const raw of this.pending) {
      const row = document.createElement("div");
      for (const seg of ansiSegments(raw)) {
        if (!seg.color && !seg.bold) row.append(seg.text);
        else {
          const span = document.createElement("span");
          span.className = `ansi-${seg.color ?? "default"}${seg.bold ? " ansi-bold" : ""}`;
          span.textContent = seg.text;
          row.append(span);
        }
      }
      if (/^\x1b\[2m/.test(raw)) row.className = "ansi-dim";
      frag.append(row);
    }
    this.lineCount += this.pending.length;
    this.pending = [];
    this.outputEl.append(frag);
    while (this.lineCount > MAX_LINES && this.outputEl.firstChild) {
      this.outputEl.firstChild.remove();
      this.lineCount--;
    }
    if (atBottom) this.outputEl.scrollTop = this.outputEl.scrollHeight;
    if (this.running && this.parser.summary().problems.length !== this.shownProblems) this.renderProblems();
  }

  private renderProblems() {
    const all = this.parser.summary().problems;
    this.shownProblems = all.length;
    const f = this.filter.value as Filter;
    const rel = this.deps.activeRel();
    const shown = all.filter((p) => (f === "errors" ? p.severity === "error" : f === "file" ? p.file === rel : true));
    const errors = all.filter((p) => p.severity === "error").length;
    this.tabProblems.textContent = de.build.problems(errors, all.length - errors);
    if (!shown.length) {
      this.problemsEl.replaceChildren(h("div", { class: "bp-empty" }, this.running ? de.build.waiting : all.length ? de.build.noneFiltered : de.build.none));
      return;
    }
    // errors first, then warnings; files in output order
    const sorted = [...shown].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
    this.problemsEl.replaceChildren(
      ...sorted.slice(0, 2000).map((p) => {
        const row = h(
          "div",
          { class: `bp-problem ${p.severity}`, title: p.lines.join("\n") },
          h("span", { class: "bp-sev" }, p.severity === "error" ? "●" : "▲"),
          h("span", { class: "bp-file" }, p.file),
          h("span", { class: "bp-msg" }, problemMessage(p)),
        );
        row.addEventListener("click", () => this.deps.openProblem(p));
        return row;
      }),
    );
  }
}
