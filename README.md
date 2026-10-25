# ProPra Editor

A lean desktop editor (macOS, Windows) for writing German task files for the
[propra-inf](https://github.com/fubinf/propra-inf) course, built with
[sedrila](https://github.com/fubinf/sedrila).

Status: Phases 1 to 7 of `docs/PLAN.md`: file tree, tabs, ProPra highlighting, atomic
saving, file watching, offline grammar and spell checking with a bundled LanguageTool,
structural lints, top matter assistance, glossary panel, inline altdir solutions, preview,
sedrila build with problems linked to files.

## Use

1. Download the build for your platform from the latest CI run (artifacts
   `propra-editor-macos-latest` / `propra-editor-windows-latest`), or build it yourself
   (see `CLAUDE.md`).
2. The builds are unsigned. macOS: right-click the app, „Öffnen“, then confirm.
   Windows: SmartScreen „Weitere Informationen“, then „Trotzdem ausführen“.
3. On first start choose the course folder (the one containing `sedrila.yaml`).
4. For builds (Cmd/Strg+B), sedrila must be callable from your shell. If it lives in a venv
   or is run via `uv`, set the command in the settings (⚙, „sedrila-Befehl“) and use
   „sedrila testen“. The `SEDRILA_*` variables that propra-inf's `sedrila.yaml` needs are
   read from your shell configuration, as in a terminal.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Cmd/Strg+P | Schnell öffnen |
| Cmd/Strg+S | Speichern |
| Cmd/Strg+W | Tab schließen |
| Cmd/Strg+N | Neue Aufgabe |
| Strg+Tab | Nächster Tab |
| Cmd/Strg+F | Suchen/Ersetzen |
| Cmd/Strg+. | Schnellkorrektur an der Cursorposition |
| Cmd/Strg+Shift+M | Problemliste |
| F8 | Nächstes Problem |
| F12 / Cmd/Strg+Klick | Zur Definition (Part, Glossarbegriff, eingebundene Datei) |
| Cmd/Strg+Shift+L | Lösungen (altdir) ein-/ausblenden |
| Cmd/Strg+B | Kurs mit sedrila bauen |
| Cmd/Strg+Shift+V | Vorschau ein-/ausblenden (Doppelklick in der Vorschau springt zur Quelle) |
| Cmd/Strg+Alt+[ / ] | Block falten / entfalten |
