// Log viewer: the app log and the LanguageTool log, with copy, open-folder and LT restart.
// Reachable from the toolbar („Logs“) and by clicking the LanguageTool status.

import type { LtStatus } from "../backend";
import { ui } from "../i18n";
import { h, showDialog, toast } from "../ui/dom";

export type LogTab = "app" | "languagetool";

export interface LogsDeps {
  read(): Promise<{ dir: string; app: string; languagetool: string }>;
  openDir(): Promise<void>;
  restartLt(): Promise<void>;
  ltStatus(): LtStatus;
}

async function copyText(text: string, fallback: HTMLTextAreaElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallback.focus();
    fallback.select();
    document.execCommand("copy");
  }
}

export async function openLogs(deps: LogsDeps, initial: LogTab = "app") {
  let tab: LogTab = initial;
  let data = { dir: "", app: "", languagetool: "" };
  const status = h("div", { class: "logs-status" });
  const dir = h("code", { class: "logs-dir" });
  const text = h("textarea", { class: "logs-text", readonly: true, spellcheck: "false", wrap: "off" }) as HTMLTextAreaElement;
  const tabApp = h("button", { class: "bp-tab" }, ui.logs.appLog);
  const tabLt = h("button", { class: "bp-tab" }, ui.logs.ltLog);

  const renderStatus = () => {
    const st = deps.ltStatus();
    status.replaceChildren(
      h("strong", {}, `${ui.logs.ltState}: ${ui.logs.states[st.state as keyof typeof ui.logs.states] ?? st.state}`),
      st.message ? h("pre", { class: "logs-message" }, st.message) : "",
    );
    status.className = `logs-status lt-${st.state}`;
  };
  const render = () => {
    tabApp.classList.toggle("active", tab === "app");
    tabLt.classList.toggle("active", tab === "languagetool");
    const content = tab === "app" ? data.app : data.languagetool;
    text.value = content || ui.logs.empty;
    dir.textContent = data.dir;
    renderStatus();
    requestAnimationFrame(() => (text.scrollTop = text.scrollHeight));
  };
  const reload = async () => {
    try {
      data = await deps.read();
    } catch (e) {
      data = { dir: "", app: String(e), languagetool: String(e) };
    }
    render();
  };
  tabApp.addEventListener("click", () => {
    tab = "app";
    render();
  });
  tabLt.addEventListener("click", () => {
    tab = "languagetool";
    render();
  });

  const btn = (label: string, fn: () => void | Promise<void>) => h("button", { type: "button", onclick: () => void fn() }, label);
  const actions = h(
    "div",
    { class: "logs-actions" },
    btn(ui.logs.copy, async () => {
      const st = deps.ltStatus();
      // everything someone helping needs, in one paste
      const all = [
        `${ui.logs.ltState}: ${st.state}${st.message ? `\n${st.message}` : ""}`,
        `${ui.logs.folder}: ${data.dir}`,
        `----- ${ui.logs.appLog} -----`,
        data.app.slice(-20000),
        `----- ${ui.logs.ltLog} -----`,
        data.languagetool.slice(-20000),
      ].join("\n");
      await copyText(all, text);
      toast(ui.logs.copied);
    }),
    btn(ui.logs.openFolder, () => deps.openDir().catch((e) => toast(String(e), "error"))),
    btn(ui.logs.reload, reload),
    btn(ui.logs.restartLt, async () => {
      await deps.restartLt().catch((e) => toast(String(e), "error"));
      toast(ui.logs.restarting);
      window.setTimeout(() => void reload(), 1500);
    }),
  );
  const body = h(
    "div",
    { class: "logs" },
    status,
    h("div", { class: "logs-tabs" }, tabApp, tabLt, h("span", { class: "spacer" }), actions),
    text,
    h("div", { class: "form-hint" }, ui.logs.folder, ": ", dir),
  );
  const timer = window.setInterval(renderStatus, 1000);
  void reload();
  await showDialog({
    title: ui.logs.title,
    body,
    buttons: [{ label: ui.common.close, value: true, primary: true }],
    cancelValue: true,
    onOpen: (root) => root.classList.add("dialog-wide"),
  });
  window.clearInterval(timer);
}
