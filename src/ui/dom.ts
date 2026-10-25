// Tiny DOM helpers and a promise-based modal dialog (native dialogs differ per platform).

type Attrs = Record<string, string | boolean | number | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
}

/** Show a modal; resolves with the clicked button's value, or `cancelValue` on Escape. */
export function showDialog<T>(opts: { title: string; body: Node | string; buttons: DialogButton<T>[]; cancelValue: T; onOpen?: (root: HTMLElement) => void }): Promise<T> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const close = (v: T) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      prevFocus?.focus();
      resolve(v);
    };
    const buttons = opts.buttons.map((b) => h("button", { class: b.primary ? "primary" : "", onclick: () => close(b.value) }, b.label));
    const dialog = h(
      "div",
      { class: "dialog", role: "dialog", "aria-modal": "true" },
      h("h2", {}, opts.title),
      h("div", { class: "dialog-body" }, typeof opts.body === "string" ? h("p", {}, opts.body) : opts.body),
      h("div", { class: "dialog-buttons" }, ...buttons),
    );
    const overlay = h("div", { class: "overlay" }, dialog);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(opts.cancelValue);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        const primary = opts.buttons.findIndex((b) => b.primary);
        if (primary !== -1 && !(buttons[primary] as HTMLButtonElement).disabled) {
          e.preventDefault();
          close(opts.buttons[primary].value);
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    opts.onOpen?.(dialog);
    if (!dialog.querySelector("input, select, textarea")) (buttons.find((_, i) => opts.buttons[i].primary) ?? buttons[0])?.focus();
  });
}

let toastTimer: number | undefined;
let errorSink: ((msg: string) => void) | null = null;

/** Error toasts are also written to the app log (set up in main.ts). */
export function setErrorSink(fn: (msg: string) => void) {
  errorSink = fn;
}

export function toast(msg: string, kind: "info" | "error" = "info") {
  if (kind === "error") errorSink?.(msg);
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast" });
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = `visible ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("visible"), kind === "error" ? 6000 : 2500);
}
