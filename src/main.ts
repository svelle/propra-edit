import "./styles.css";
import { App } from "./app";
import { backend } from "./backend";
import { setLanguage } from "./i18n";
import { loadSettings } from "./settings";
import { setErrorSink, toast } from "./ui/dom";

setErrorSink((msg) => void backend.logFrontend("error", msg).catch(() => {}));

// Make unexpected errors visible (the webview console is not available in release builds).
window.addEventListener("error", (e) => toast(`Fehler: ${e.message}`, "error"));
window.addEventListener("unhandledrejection", (e) => toast(`Fehler: ${e.reason instanceof Error ? `${e.reason.message} ${e.reason.stack ?? ""}` : String(e.reason)}`, "error"));

// the UI language must be set before any UI is built
const root = document.getElementById("app")!;
void loadSettings().then(
  (s) => {
    setLanguage(s.uiLanguage);
    void backend.setUiLanguage(s.uiLanguage).catch(() => {});
    void new App().start(root);
  },
  () => void new App().start(root),
);
