# ProPra Editor

Desktop editor (Tauri 2 + TypeScript + CodeMirror 6) for sedrila/ProPra task files.
The full plan is in `docs/PLAN.md`; non-obvious choices are logged in `docs/decisions.md`.
sedrila's `docs/authors.md` is the authoritative spec for the file format.

## Commands

```sh
npm ci                      # install frontend deps (exact versions, legacy-peer-deps via .npmrc)
npm run dev                 # Vite only (browser, no Rust backend)
npx tauri dev               # full app with hot reload
npx tauri build             # release bundles (.app/.dmg, .msi/.exe)
npx tauri build --debug --no-bundle   # quick debug binary with embedded frontend

npm run typecheck           # tsc --noEmit
npm test                    # Vitest (parser, fuzzy matcher, ...)
PROPRA_INF_DIR=/path/to/propra-inf npm test   # + golden test over a real course checkout
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests (needs dist/ to exist: run npm run build once)
```

On Linux, building needs `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev`.

## Layout

- `src-tauri/src/`: Rust core. `course/` (sedrila.yaml, CourseIndex, top matter, glossary),
  `fs.rs` (atomic, encoding-preserving I/O), `watcher.rs`, `settings.rs`, `lib.rs` (commands).
- `src/editor/parser.ts`: the one ProPraDoc parser. Highlighting, lints, grammar masking,
  inline solutions and preview all consume it; nobody re-parses with their own regexes.
- `src/editor/macros.ts`: macro table (names, arities, block families).
- `src/editor/propra-language.ts`: CodeMirror language, decorations, folding.
- `src/app.ts`: tabs, saving, external changes. `src/panels/`: tree, quick open, dialogs.
- `src/i18n/de.ts`: all UI strings.
- `test-fixtures/course/`: fake course incl. altdir. Automated tests use only this.

## Conventions

- Never modify a real course repo during development; use `test-fixtures/` or a scratch copy.
- File safety: atomic writes; preserve UTF-8 BOM, line endings and the final newline.
  Multi-file changes are previewed and undoable.
- Paths: built in Rust with `PathBuf`; the frontend treats them as opaque strings.
  `rel` fields (always `/`-separated) are for display and matching only.
- UI strings only in `src/i18n/de.ts`; German typography („…“), no em dashes.
- Pin exact dependency versions, releases at least two weeks old. LanguageTool and the JRE
  are downloaded by `scripts/fetch-runtime`, never committed.
- Parser rules must match sedrila (macro regex, top matter split); note deviations in
  `docs/decisions.md`.
- Work phase by phase (see the plan); keep the app runnable after every step.
