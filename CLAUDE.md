# ProPra Editor

Desktop editor (Tauri 2 + TypeScript + CodeMirror 6) for sedrila/ProPra task files.
The full plan is in `docs/PLAN.md`; non-obvious choices are logged in `docs/decisions.md`.
sedrila's `docs/authors.md` is the authoritative spec for the file format.

## Commands

```sh
npm ci                      # install frontend deps (exact versions, legacy-peer-deps via .npmrc)
npm run dev                 # Vite only (browser, no Rust backend)
npx tauri dev               # full app with hot reload
npx tauri build             # release bundles (.dmg on macOS, NSIS setup .exe on Windows)
npx tauri build --debug --no-bundle   # quick debug binary with embedded frontend

npm run typecheck           # tsc --noEmit
npm test                    # Vitest (parser, fuzzy matcher, ...)
PROPRA_INF_DIR=/path/to/propra-inf npm test   # + golden test over a real course checkout
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests (needs dist/ to exist: run npm run build once)
./scripts/fetch-runtime.sh   # LanguageTool jars + trimmed JRE into src-tauri/resources (Maven + JDK 21)
PROPRA_LT_LIB=src-tauri/resources/languagetool/lib PROPRA_LT_JAVA=src-tauri/resources/jre/bin/java \
  cargo test --manifest-path src-tauri/Cargo.toml real_server_check   # end-to-end LanguageTool test
```

On Linux, building needs `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev`.

## Layout

- `src-tauri/src/`: Rust core. `course/` (sedrila.yaml, CourseIndex, top matter, glossary),
  `fs.rs` (atomic, encoding-preserving I/O), `watcher.rs`, `settings.rs`, `lib.rs` (commands).
- `src/editor/parser.ts`: the one ProPraDoc parser. Highlighting, lints, grammar masking,
  inline solutions and preview all consume it; nobody re-parses with their own regexes.
- `src/editor/macros.ts`: macro table (names, arities, block families).
- `src/editor/propra-language.ts`: CodeMirror language, decorations, folding.
- `src-tauri/src/build.rs`: sedrila build process (shell, streaming, cancel). `src/build/output.ts`: output parser (pure). `src/panels/build-panel.ts`: build panel.
- `src-tauri/src/git.rs`: git via the CLI (course repo + altdir submodule). `src/panels/git-panel.ts`, `src/panels/diff.ts`.
- `src-tauri/src/applog.rs`: app log; `src/panels/logs.ts`: log viewer.
- `src-tauri/src/lt.rs`: LanguageTool process (start, health check, warm-up, restart) and check proxy.
- `src/grammar/`: masking (`mask.ts`), batching/caching client (`client.ts`), CodeMirror integration (`grammar.ts`).
- `src/lint/`: structural lints (`structural.ts`, pure), lint source, completion/hover/click (`assist.ts`), per-file environment facet (`env.ts`). Include paths are resolved in Rust (`course/includes.rs`).
- `src/glossary/model.ts`: glossary terms, sedrila's sort order, insertion position. `src/panels/glossary-panel.ts`: side panel.
- `src/editor/slice.ts`: slice editors (show and edit one range of a document, synced with a master).
- `src/altdir/`: solution segments and renumbering (`segments.ts`, pure), solution document and enumeration tracking in the task state (`state.ts`), inline widgets and warning bar (`widgets.ts`).
- `src/preview/render.ts`: preview renderer (markdown-it + sedrila macro expansion, pure). `src/panels/preview.ts`: preview panel.
- `src/app.ts`: tabs, saving, external changes. `src/panels/`: tree, quick open, dialogs.
- `src/i18n/`: UI strings. `de.ts` is the reference table, `en.ts` has the same shape; code reads
  them through `ui` from `src/i18n/index.ts` (filled at start-up for the chosen language).
  Rust messages shown to the user use `i18n::tr(de, en)` (`src-tauri/src/i18n.rs`).
- `test-fixtures/course/`: fake course incl. altdir. Automated tests use only this.

## Conventions

- Never modify a real course repo during development; use `test-fixtures/` or a scratch copy.
- File safety: atomic writes; preserve UTF-8 BOM, line endings and the final newline.
  Multi-file changes are previewed and undoable.
- Paths: built in Rust with `PathBuf`; the frontend treats them as opaque strings.
  `rel` fields (always `/`-separated) are for display and matching only.
- UI strings only in `src/i18n/de.ts` and `src/i18n/en.ts` (both, same keys); German
  typography („…“) in German, no em dashes.
- Pin exact dependency versions, releases at least two weeks old. LanguageTool and the JRE
  are downloaded by `scripts/fetch-runtime`, never committed.
- Parser rules must match sedrila (macro regex, top matter split); note deviations in
  `docs/decisions.md`.
- Work phase by phase (see the plan); keep the app runnable after every step.
