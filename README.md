# ProPra Editor

A lean desktop editor (macOS, Windows) for writing German task files for the
[propra-inf](https://github.com/fubinf/propra-inf) course, built with
[sedrila](https://github.com/fubinf/sedrila).

Status: Phases 1 to 3 of `docs/PLAN.md`: file tree, tabs, ProPra highlighting, atomic
saving, file watching, offline grammar and spell checking with a bundled LanguageTool,
structural lints and top matter assistance.

## Use

1. Download the build for your platform from the latest CI run (artifacts
   `propra-editor-macos-latest` / `propra-editor-windows-latest`), or build it yourself
   (see `CLAUDE.md`).
2. The builds are unsigned. macOS: right-click the app, „Öffnen“, then confirm.
   Windows: SmartScreen „Weitere Informationen“, then „Trotzdem ausführen“.
3. On first start choose the course folder (the one containing `sedrila.yaml`).

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
| Cmd/Strg+Alt+[ / ] | Block falten / entfalten |
