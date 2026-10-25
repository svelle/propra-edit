import "./styles.css";
import { App } from "./app";
import { toast } from "./ui/dom";

// Make unexpected errors visible (the webview console is not available in release builds).
window.addEventListener("error", (e) => toast(`Fehler: ${e.message}`, "error"));
window.addEventListener("unhandledrejection", (e) => toast(`Fehler: ${e.reason instanceof Error ? `${e.reason.message} ${e.reason.stack ?? ""}` : String(e.reason)}`, "error"));

const root = document.getElementById("app")!;
void new App().start(root);
