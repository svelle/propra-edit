# ProPra Editor: Implementation Plan for Claude Code

Oct 25, 2026 · @Sven

## Purpose and context

Build a lean desktop editor (Windows + macOS) for writing German-language task files for the [propra-inf](https://github.com/fubinf/propra-inf) course, which is built with [sedrila](https://github.com/fubinf/sedrila). It replaces PyCharm for this one job, mainly because PyCharm's German grammar checking (Grazie, built on LanguageTool) is the only reason it is used today.

The app has exactly one user, the author. That rules out installers with auto-update, user accounts, plugin systems and settings for other people's workflows. It does not rule out quality: the editor must feel fast and must never lose or corrupt a file.

Guiding principles:

- **Writing first.** Grammar checking, ProPra syntax awareness and the task/solution/glossary workflow are the product. Everything else is secondary.
- **Files are the source of truth.** The app reads and writes the plain Markdown files in the repo. No database, no hidden state that a `git diff` would not show.
- **Offline.** Grammar checking runs locally via bundled LanguageTool. No network calls in normal use.
- **Don't reimplement sedrila.** The real build is run by calling the user's installed sedrila. The app's own parsing is only for editing features and a fast approximate preview.
- **German UI** is fine but not required; strings live in one place so they can be changed later.

## Domain background: what the app must understand

Everything here was checked against sedrila's [authors.md](https://github.com/fubinf/sedrila/blob/main/docs/authors.md) and the propra-inf repo (sedrila 3.2.0, Python >= 3.11). Claude Code should re-read `docs/authors.md` before implementing parsers, because it is the authoritative spec.

### Repository layout

The course root contains `sedrila.yaml`. In propra-inf the relevant entries are `chapterdir: ch`, `altdir: altdir/ch`, `itreedir: altdir/itree.zip` and `stages: ['draft', 'alpha', 'beta']`. Never hard-code these paths; read them from `sedrila.yaml`.

- `ch/<chapter>/<taskgroup>/<task>.md`: three-level tree. Chapters and taskgroups have an `index.md`. The task file's basename is the task name; all part names share one global namespace.
- `ch/glossary.md`: the single glossary. `ch/_include/`: shared include blurbs (e.g. `Submission-Markdowndokument.md`). `ch/template.md`: the official task template.
- `altdir/`: a **separate private git repo**, mounted as a git submodule (`propra-inf-instructorparts`). It mirrors the chapter tree. The solution for `ch/X/Y/task.md` lives at `altdir/ch/X/Y/task.md`, plus `.prot` protocol files and other resources next to it.
- `.md` files in `*.zip` directories and non-`.md` files in taskgroup dirs are resources, not tasks.

### Task file format

YAML top matter, a `---` line, then Markdown with macros. Top matter keys: `title` (required), `timevalue` (float, required), `difficulty` (1 to 4, required), `stage` (first word must be one of `stages`), `explains` (comma-separated glossary terms), `assumes` and `requires` (comma-separated part names). Note the top matter has **no opening `---`**, only the closing one.

### Macros

Syntax is `[NAME]`, `[NAME::arg1]` or `[NAME::arg1::arg2]`. Names are uppercase; a call never spans lines. Block macros come in `X`/`ENDX` pairs, each alone on its line, mostly not nestable (exception: `[INNERSECTION]` one level inside `[SECTION]`). Frequencies in propra-inf, which tell us what to optimize for:

| Macro | Kind | Count in propra-inf | Notes |
| --- | --- | --- | --- |
| `[SECTION::type::subtype]` | block | 1361 | types: goal, background, instructions, submission; subtypes in `sedrila.yaml` |
| `[EQ]`, `[ER]`, `[EC]` | inline | 1210 / 1199 / 958 | three independent counters per task |
| `[INCLUDE::path]` | inline | 976 | relative, `/`-absolute (from chapterdir), `ALT:` and `ITREE:` prefixes; `[INCLUDE::ALT:]` = same-named altdir file |
| `[HINT::title]`, `[FOLDOUT::title]` | block | 515 / 106 |  |
| `[TERMREF::term]`, `[TERMREF2::term::shown]` | inline | 513 / 99 | `shown` starting with `-` is appended (`-s`, `-en`) |
| `[PARTREF::name]`, `[PARTREF2::name::text]` | inline | 508 / 40 |  |
| `[INSTRUCTOR::heading]` | block | 357 | heading may be empty: `[INSTRUCTOR::]` |
| `[TERM::a\|b\|c]`, `[TERM0::...]` | block | 235 | glossary only; `\|` separates synonyms |
| `[NOTICE]`, `[WARNING]` | block | 197 / 76 | user-defined in `sedrila.yaml` `blockmacro_topmatter` |
| `[HREF::url]` | inline | 138 |  |
| `[EREFR::n]`, `[EREFQ::n]`, `[EREFC::n]` | inline | 104 / 85 / 33 | references to the n-th EC/EQ/ER |
| `[PROT::path]`, `[SNIPPET::path::name]`, `[TREEREF::path]` | inline | 100 / 48 / 67 | same path rules as INCLUDE |
| `[DIFF::n]`, `[TOC]` | inline | 30 / 18 |  |

The valid block-macro set is builtins plus the uppercase keys under `blockmacro_topmatter` in `sedrila.yaml` (in propra-inf: `INSTRUCTOR`, `WARNING`, `NOTICE`). Load it from config.

Three special cases the highlighter and parser must respect: text between `<!-- sedrila: macros off -->` and `<!-- sedrila: macros off end -->` is not macro-expanded; `<replacement id="...">...</replacement>` pseudo-tags; and fenced ```` ```mermaid ```` blocks.

### Enumeration and the altdir link

`[EC]`, `[EQ]` and `[ER]` are written **unnumbered** in the task; sedrila numbers each kind separately in file order, starting at 1. The solution file in altdir refers back with explicit numbers, typically as list items such as `- [EREFQ::4] explanation…` or as headings. So the n-th `[EQ]` in `ch/X/Y/task.md` pairs with the `[EREFQ::n]` passages in `altdir/ch/X/Y/task.md`. The task file pulls the solution in through `[INCLUDE::ALT:]` or `[PROT::ALT:file.prot]` inside an `[INSTRUCTOR::…]` block.

Open question for the user: the exact shape of altdir solution files is private, so Phase 0 includes sampling real files (see Risks).

### Glossary

`ch/glossary.md` has top matter with only `title`, then blocks:

```
[TERM::Account|Konto|Benutzeraccount]
Markdown definition, may contain [TERMREF] calls.
[ENDTERM]
```

The first name is the display name; every `|`-separated name is a valid `[TERMREF]` target. propra-inf has 235 term blocks. `explains:` in task top matter also refers to glossary terms.

### sedrila's build output

The build is `sedrila author build <outputdir>` run from the course root, with `--include-stage draft` to include unfinished tasks. Errors and warnings are printed as `File '<path>':` followed by an indented message line, colored via `rich`, and usually **without line numbers**. The final line reports the error count. Use `sedrila --log WARNING author build …` to reduce noise. Builds are cached in `<outputdir>/instructor/.sedrila_cache`, so repeat builds are fast.

## Tech stack and architecture

Tauri 2 with a TypeScript frontend on CodeMirror 6, a Rust backend for files, processes and git, and LanguageTool as a local Java sidecar. Pin exact versions in the lockfiles; pick releases at least two weeks old.

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Tauri 2 | Small native binary, Windows (WebView2) + macOS (WKWebView) |
| Frontend | TypeScript, Vite, Svelte (or plain TS) | Lightweight; no heavy UI framework needed |
| Editor | CodeMirror 6 | Custom StreamLanguage/Lezer for macros, decorations and widgets for inline solutions, lint API for diagnostics, hover tooltips, autocomplete |
| Markdown preview | markdown-it + custom macro plugin | Fast, extensible, runs in the frontend |
| Grammar | LanguageTool standalone server (HTTP on 127.0.0.1, random port) | Same engine family as PyCharm's Grazie; offline |
| Java runtime | Temurin JRE trimmed with `jlink` | Bundled as a Tauri sidecar resource per platform |
| Git | `git2` crate (libgit2), fallback to the `git` CLI for commit/push | Must handle the altdir submodule as a second repo |
| sedrila | User's installed `sedrila` via a configurable command | No bundling; respects the user's venv/uv setup |
| File watching | `notify` crate | Reload files changed by git or other tools |
| Settings | One JSON file in the platform config dir | Course root, sedrila command, output dir, dictionary |

### Process model

- **Rust core** owns the file system, the course index, git, the sedrila subprocess and the LanguageTool process lifecycle. It exposes Tauri commands and emits events (`file-changed`, `build-output`, `lt-ready`).
- **LanguageTool sidecar** starts on app launch, binds to `127.0.0.1` on a free port, and is health-checked. The frontend never talks to it directly; requests go through a Rust command so the port and lifecycle stay private. Restart on crash with backoff.
- **Frontend** holds editor state, runs the ProPra parser incrementally for highlighting, lints and the preview, and asks Rust for anything touching disk.

### Suggested repo layout

```
propra-editor/
  src-tauri/
    src/
      main.rs            # app setup, sidecar spawn
      course/            # sedrila.yaml loading, part index, glossary index
      fs.rs              # read/write with atomic save, watcher
      lt.rs              # LanguageTool process + check proxy
      build.rs           # sedrila subprocess, output parsing
      git.rs             # status/diff/commit for main repo and altdir
    resources/           # jre-<platform>/, languagetool/ (fetched by script, not committed)
  src/
    editor/
      propra-language.ts # tokenizer/highlighter
      parser.ts          # ProPra document model (sections, enumerations, refs)
      altdir-inline.ts   # solution widgets
      grammar.ts         # LT lint source, masking, quick fixes
      glossary.ts        # hover, autocomplete, unknown-term lint
      frontmatter.ts     # YAML completion + validation
    preview/             # markdown-it + macro rendering
    panels/              # file tree, glossary panel, build panel, git panel
  scripts/
    fetch-runtime.(sh|ps1) # download + jlink JRE, download LanguageTool
  test-fixtures/         # small fake course incl. altdir
```

### Data model shared by features

One parser produces a `ProPraDoc` per open file: top matter (with ranges), a list of macro calls (name, args, range, block/inline), block pairs with nesting errors, the ordered `[EC]`/`[EQ]`/`[ER]` occurrences with computed numbers, and `[TERMREF]`/`[PARTREF]`/`[INCLUDE]` references. Highlighting, lints, grammar masking, inline solutions and the preview all consume this model; nobody re-parses with their own regexes.

The Rust `CourseIndex` holds every part name (task, taskgroup, chapter, zip dir) with its path and title, the glossary terms with synonyms and the source range of each `[TERM]` block, and the altdir path for each task. It is built at startup and updated by the file watcher.

## Feature specification

### F1. Project and file tree

- On first start, ask for the course root (folder containing `sedrila.yaml`); remember it. Load `chapterdir`, `altdir`, `itreedir`, `stages`, `blockmacro_topmatter`.
- Left sidebar tree: chapters > taskgroups > tasks, showing each part's `title` from top matter next to the file name. Badges for `stage` (draft/alpha/beta) and difficulty. A small marker shows whether an altdir file exists for a task.
- Separate collapsible nodes for `glossary.md`, `_include/` and non-part files. Filter box (fuzzy by name and title). Cmd/Ctrl+P quick open.
- New task from `ch/template.md` in the selected taskgroup, with name validation against the global part namespace. Optionally create the matching altdir file at the same time.
- Tabs for multiple open files, unsaved marker, autosave off by default, Cmd/Ctrl+S saves. Saves are atomic (write temp, rename) and preserve the file's existing line endings and trailing newline.

### F2. ProPra syntax highlighting

- Standard Markdown highlighting (headings, emphasis, lists, links, inline code, fenced code with language highlighting for common languages).
- Macros: name and `::` delimiters styled distinctly from arguments. Block macros get a distinct color per family: SECTION/INNERSECTION, INSTRUCTOR, HINT/FOLDOUT, NOTICE/WARNING, TERM.
- `[EC]`, `[EQ]`, `[ER]` rendered with a small inline badge showing the computed number ("EQ 3"), so the author sees the numbering the students will see.
- Faint background tint for the body of each block, so `[SECTION]`…`[ENDSECTION]` regions are visible at a glance. `[INSTRUCTOR]` blocks get a clearly different tint.
- Top matter highlighted as YAML. Regions inside `macros off` markers shown as plain code, no macro styling.
- Code folding for block macros and top matter.

### F3. Live structural lints (frontend, no sedrila)

Shown as squiggles plus a problems panel, instant:

- Unknown macro name; wrong argument count (each macro's arity is in the macro table).
- Unmatched or misnested `X`/`ENDX`; block macro not alone on its line; nesting beyond INNERSECTION.
- `[SECTION]` type/subtype not in `sedrila.yaml`.
- `[TERMREF]`/`[TERMREF2]` term not in glossary (see F6). `[PARTREF]` part not in index; `assumes`/`requires` names not in index.
- `[INCLUDE]`/`[PROT]`/`[SNIPPET]`/`[TREEREF]` path does not resolve (handle relative, `/`-absolute, `ALT:`, `ITREE:`, and empty `ALT:`).
- `[EREFx::n]` where n exceeds the number of matching enumerations in the task.
- Top matter: missing required keys, `difficulty` not 1 to 4, `timevalue` not a number, unknown `stage`.

Each lint has a stable id so it can be silenced per file if it ever misfires.

### F4. Grammar and spell checking (LanguageTool)

- Language `de-DE`; check prose only. Before sending text to LT, **mask** non-prose: top matter, fenced and inline code, macro calls, URLs, file paths, HTML comments, `[INSTRUCTOR]` lines that are only includes. Use LT's `data` annotation format (`{"annotation":[{"text":…},{"markup":…}]}`) so offsets map back exactly without manual bookkeeping.
- Inline arguments that are prose should be checked: `[HINT::title]`, `[FOLDOUT::title]`, `[INSTRUCTOR::heading]`, `[PARTREF2]`/`[TERMREF2]` link texts. For `[TERMREF::x]` send the term as text so the sentence still parses.
- Check incrementally: paragraph-level chunks, debounced \~500 ms after typing stops, only changed paragraphs re-sent, results cached by paragraph hash. Full-file check on open.
- Squiggles colored by category (spelling red, grammar blue, style/typography grey). Hover shows message and up to 5 replacements; click applies. Cmd/Ctrl+. opens quick fixes at cursor.
- Actions per finding: apply suggestion, ignore once (session), add to personal dictionary, disable this rule (global setting).
- Dictionary: personal word list (JSON in config dir) plus **all glossary terms and synonyms are accepted automatically**, plus part names. Words are passed to LT via its `disabledRules`/spelling ignore mechanism or filtered client-side, whichever LT version supports cleanly.
- Sensible defaults: disable rules that fight Markdown (e.g. whitespace and some typography rules), keep German quotation and dash rules configurable. Grazie-like behavior is the benchmark; a short comparison on 3 to 5 real task files is part of Phase 2 acceptance.
- LT status indicator in the status bar (starting / ready / error, with restart button).

### F5. Altdir solutions inline

The core idea: while editing `ch/X/Y/task.md`, each `[EQ]`/`[EC]`/`[ER]` shows its matching solution from `altdir/ch/X/Y/task.md` directly below it, editable in place.

- **Pairing.** Compute numbers for the task's enumerations in file order (three counters). Parse the altdir file into **solution segments**: a segment starts at a line whose first token is `[EREFQ::n]`, `[EREFC::n]` or `[EREFR::n]` (optionally after a list marker ` -  ` / ` 1.  ` or heading `#`s) and runs until the next such line or a heading of equal or higher level. Text before the first marker is the **preamble** segment.
- **Display.** Below the paragraph containing the n-th `[EQ]`, render a block widget with a header "Lösung EQ n" (collapsible) and a nested editable region containing the segment text. Unmatched altdir segments (no corresponding enumeration) appear in a "Verwaiste Lösungen" box at the end of the task. Enumerations with no segment get an "+ Lösung anlegen" button that inserts ` - [EREFQ::n]  ` at the right ordered position in the altdir file.
- **Editing.** Implement the inline editor as a nested CodeMirror view bound to a slice of the altdir document, with the same highlighting and LanguageTool checking. Edits are applied to the altdir in-memory document and written on save. Saving the task saves both files; the tab shows dirty state if either is dirty.
- **Toggle.** A toolbar switch and shortcut to show/hide all inline solutions; per-solution collapse state is remembered per file.
- **Renumbering.** On each parse, compare the task's enumeration sequence with the previous one. When an `[EQ]` is inserted or removed before existing ones, the pairing would shift. Detect this by keeping a stable identity per enumeration across edits (track positions through CodeMirror's change mapping). If identities and numbers diverge, show a warning bar: "Nummerierung geändert: EQ 3 bis 7 verschoben" with a button "Altdir umnummerieren". The button rewrites `[EREFx::n]` in the altdir file **and** in the task file itself (EREF references can appear in task and INSTRUCTOR text) in one undoable transaction, then shows a diff for confirmation before writing.
- **Robustness.** If the altdir file has a structure the parser cannot segment (no markers), show the whole file as a single collapsible block below the `[INSTRUCTOR]` that includes it instead of guessing. Never rewrite parts of the altdir file the user did not edit.
- If altdir is missing (submodule not checked out), disable the feature with a clear status message.

### F6. Glossary

- **Index.** Parse `glossary.md` into terms: display name, synonyms, definition body, source range, `TERM` vs `TERM0`.
- **Hover.** Over `[TERMREF::x]`, `[TERMREF2::x::…]` and terms in `explains:`, show the rendered definition (via the preview renderer) plus synonyms and a "Bearbeiten" link.
- **Go to definition.** Cmd/Ctrl+Click or F12 opens the glossary entry in a side panel scrolled to the term.
- **Glossary side panel.** A right-hand panel with its own small editor showing one `[TERM]` block at a time. It edits `glossary.md` directly (same document model, so changes appear in hovers immediately) without leaving the task. Includes LanguageTool checking.
- **Unknown terms.** A `[TERMREF]` whose term is missing is a lint with quick fix "Begriff im Glossar anlegen". This opens the panel with a new `[TERM::x]`/`[ENDTERM]` block inserted at the **alphabetically correct position** (case-insensitive, German collation; verify against how existing entries are ordered).
- **Autocomplete** after `[TERMREF::` and `[TERMREF2::` and in `explains:` with all names and synonyms (the user did not ask for this explicitly, but it falls out of the index cheaply; keep it).
- **Glossary view.** When `glossary.md` itself is open: outline of terms, duplicate-name lint, and "Wo verwendet?" listing tasks that reference a term.

### F7. Top matter assistance

- Autocomplete for keys; for `stage` with values from `stages`; for `difficulty` 1 to 4; for `assumes`/`requires` with part names (tasks, taskgroups, chapters) showing their titles, comma-aware; for `explains` with glossary terms.
- Hover on a part name in `assumes`/`requires` shows its title and path; Cmd/Ctrl+Click opens it.
- Same completion inside `[PARTREF::` and path completion inside `[INCLUDE::`, `[PROT::`, `[SNIPPET::`, `[TREEREF::` (including `ALT:` and `ITREE:` trees).

### F8. Preview

- Right-hand split, toggleable, scroll-synced to the editor by source line.
- markdown-it plus a macro plugin that approximates sedrila: sections as boxes with the headings from `blockmacro_topmatter`, HINT/FOLDOUT as `<details>`, EQ/EC/ER as numbered labels, TERMREF/PARTREF as styled links, INCLUDE inlined (one level, guarded against cycles), PROT shown as preformatted, INSTRUCTOR shown with a toggle "Tutor-Ansicht".
- Mermaid blocks rendered if cheap (mermaid.js), otherwise shown as code. Reuse sedrila's CSS from `baseresources` where it helps.
- Explicitly approximate: a footer note says the real output comes from the sedrila build.

### F9. sedrila build

- Shortcut (Cmd/Ctrl+B) and toolbar button. Runs the configured command, default `sedrila author build --include-stage draft <outputdir>`, from the course root. Output dir is configurable, default a temp dir outside the repo.
- Stream output to a bottom panel (strip ANSI, keep colors). Parse `File '<path>':` + indented message blocks into problems linked to files; when no line number is given, try to locate the offending macro text in the file and fall back to line 1. Show the error count from the final line.
- Cancel button kills the process tree. Show elapsed time. Button to open the built task page in the system browser (path derived from the task name; verify the actual output layout).
- Settings allow overriding the command (e.g. `uv run sedrila …` or a venv path).

### F10. Git

- Status for **two repos**: the course repo and the altdir submodule. File tree shows modified/new markers from both.
- Side-by-side or inline diff of the current file against HEAD.
- Commit panel per repo: staged/unstaged lists, stage/unstage file, commit message, commit. If both repos changed, offer to commit altdir first, then the course repo including the updated submodule pointer.
- Push and pull through the `git` CLI so existing SSH/credential setup works. No branch management in v1 beyond showing the current branch.

### F11. General editor quality

- Find/replace in file, find in project (ripgrep-like via Rust), multi-cursor, soft wrap on by default, configurable font and size, light/dark theme following the OS.
- Undo history per file survives switching tabs. Restore open tabs on restart.
- Never block the UI on LT, sedrila or git; all are async with visible status.

## Implementation phases

Eight phases, each ending in a usable app. Phase 2 (LanguageTool) comes early because it is both the main reason for the app and the biggest technical risk. Do not start a phase before the previous one's acceptance criteria pass on both Windows and macOS (CI builds on both from Phase 1).

### Phase 0: Spike and fixtures (half a day)

- [ ] Ask the user for 3 to 5 real altdir solution files (anonymized if needed) and copy their structure into `test-fixtures/`. Confirm the `[EREFx::n]` segment format; adjust F5 pairing rules if reality differs.
- [ ] Build a small fake course in `test-fixtures/course/` with `sedrila.yaml`, 2 chapters, 3 taskgroups, \~8 tasks, `glossary.md` with \~15 terms, `_include/`, and an `altdir/ch` mirror with solutions using EREF markers, one `.prot` file, one orphan solution and one task with no solution.
- [ ] Spike: start LanguageTool from a `jlink`ed JRE on macOS and Windows, send one German paragraph via HTTP, measure startup time and RAM. Record numbers in `docs/decisions.md`.

### Phase 1: Shell, file tree, editor, highlighting

F1, F2, F11 basics. Course root selection, `sedrila.yaml` loading, `CourseIndex`, file tree with titles, tabs, atomic save, file watcher, CodeMirror with the ProPra language and EQ badges.

Acceptance: open propra-inf, browse to any task, edit and save; `git diff` shows only the intended change (no line-ending or trailing-newline churn). All macros from the table in "Domain background" highlight correctly on 10 sampled real tasks. Opening a 500-line task is instant. CI produces a `.dmg`/`.app` and an `.msi`/`.exe`.

### Phase 2: LanguageTool

F4 complete. `scripts/fetch-runtime` downloads LT and builds the trimmed JRE per platform; sidecar lifecycle; masking via the annotation format; incremental paragraph checks; squiggles, hovers, quick fixes; personal dictionary; glossary terms auto-accepted; status indicator.

Acceptance: no false positives on macros, code, paths or top matter in 5 real tasks. Typing stays fluid (no keystroke latency added). A deliberately misspelled word and a wrong case agreement ("mit der Kommando") are flagged within \~1 s. The user compares results with PyCharm on the same 3 files and is satisfied; record rule tweaks in settings defaults.

### Phase 3: Live structural lints and top matter

F3 and F7. Problems panel, all listed lints, completion and hovers for top matter, PARTREF and include paths.

Acceptance: each lint has a fixture test that triggers it and one that does not. Running the lints over all of propra-inf's `ch/` produces no false positives the user considers wrong (sedrila builds it cleanly, so remaining hits are either real or bugs).

### Phase 4: Glossary

F6. Glossary index, hover, go-to-definition, side panel editor, unknown-term quick fix with alphabetical insertion, autocomplete, "Wo verwendet?".

Acceptance: hover over any of 20 random TERMREFs in propra-inf shows the correct definition including synonyms resolution and `TERMREF2` `-s` forms. Creating a term from a task inserts it at the right position and the lint disappears without a reload.

### Phase 5: Altdir inline

F5. Segment parser with tests, pairing, block widgets with nested editors, create-solution button, orphan box, dual-file save, renumber detection and the umnummerieren transaction with diff preview.

Acceptance (all on fixtures, then on a real task): solutions appear under the right enumeration; editing a solution changes only that slice of the altdir file; inserting a new `[EQ]` before EQ 2 triggers the warning; clicking renumber updates every affected `[EREFQ::n]` in both files, and undo reverts it in one step. Unparseable altdir files fall back to whole-file display.

### Phase 6: Preview

F8 with scroll sync.

Acceptance: preview of 5 real tasks is recognizably close to the sedrila output (structure, sections, hints, numbering). Typing does not lag with the preview open.

### Phase 7: sedrila build

F9.

Acceptance: build runs from the shortcut, streams output, can be cancelled, and an injected error (unknown macro, missing include) appears in the problems panel linked to the right file.

### Phase 8: Git

F10 including submodule handling.

Acceptance: after editing a task and its solution, the git panel shows changes in both repos; committing altdir then the course repo leaves both clean and the submodule pointer updated. Push uses the user's existing SSH setup.

## Risks and open questions

The two largest risks are LanguageTool quality versus Grazie and the unknown real structure of altdir files; both are tackled in Phase 0 to 2 before heavy investment.

| Risk / question | Impact | Mitigation |
| --- | --- | --- |
| LT open-source rules may be weaker than Grazie (Grazie adds its own rules on top of LT) | Core value of the app | Compare in Phase 2; tune rule set; optionally allow LT n-gram data (\~8 GB for German) as an opt-in download for better confusion-pair detection |
| Altdir solution format differs from the assumed `[EREFx::n]` line markers | F5 pairing breaks | Phase 0 sampling; fallback whole-file display; keep the segment rules in one tested module |
| App size with JRE + LT (\~150 to 250 MB) | Acceptable for one user | `jlink` with only needed modules; LT data for German and English only |
| LT startup (several seconds) and RAM (\~500 MB to 1 GB) | First check delayed | Start at launch, show status, queue requests until ready; cap heap via `-Xmx` |
| macOS Gatekeeper / Windows SmartScreen on unsigned builds | Annoying first launch | Fine for personal use; document the "Open anyway" step; ad-hoc sign on macOS |
| sedrila errors lack line numbers | Coarse error locations | Heuristic search for the macro text; otherwise file-level problem |
| Nested CodeMirror editors inside widgets (F5) are fiddly (focus, undo, selection) | Phase 5 slips | Prototype with one widget first; if it fails, use a split pane showing the paired segment next to the cursor's enumeration |
| Python/sedrila environment differs between Windows and macOS | Build fails on one machine | Configurable command; a "Test sedrila" button that runs `sedrila --version` |
| Concurrent edits from PyCharm or git while files are open | Lost work | Watcher detects external change; if the buffer is clean reload, if dirty show a merge prompt |

Open points to confirm with the user during implementation:

- [ ] Exact altdir solution file structure (Phase 0).
- [ ] Alphabetical order rule used in `glossary.md` (umlauts, case).
- [ ] Default `--include-stage` value and output directory for builds.
- [ ] Whether the inline solutions should also appear for `[EREFx]` references in `[INSTRUCTOR]` text, or only below the enumerations themselves.
- [ ] UI language: German labels assumed.

## Instructions for Claude Code

Work phase by phase, keep the app runnable after every step, and stop at each phase boundary for the user to test.

1. **Start of project.** Create the repo, copy this plan to `docs/PLAN.md`, and write a short `CLAUDE.md` with build/test commands and the conventions below. Keep `docs/decisions.md` as a running log of non-obvious choices (versions, LT rules disabled, parser rules).
2. **Read the spec first.** Before writing the parser or lints, clone sedrila and read `docs/authors.md` sections 1.3 to 2.10. Treat it as authoritative over this plan where they disagree, and note the disagreement in `decisions.md`.
3. **Never modify the user's course repo during development.** Use `test-fixtures/course/` for automated tests. When testing against the real propra-inf checkout, open it read-only or work on a scratch copy.
4. **Tests.**
   - Parser, enumeration numbering, altdir segmentation, renumbering, glossary parsing, LT masking/offset mapping, sedrila output parsing: unit tests with fixtures (Vitest for TS, `cargo test` for Rust).
   - A golden test that runs the parser over every `.md` in a propra-inf checkout (path via env var, skipped in CI if absent) and asserts no crash and no unknown-macro lints.
   - Masking tests must assert that every LT match offset maps back to the exact original characters.
5. **Performance budgets.** Keystroke-to-render under 16 ms on a 1000-line file with all features on. Parsing is incremental or debounced; LT and lints never run on the main thread's critical path.
6. **File safety.** Atomic writes, preserve encoding (UTF-8), line endings and final newline. Every multi-file change (renumbering, new task + altdir file, new glossary term) is previewed as a diff and undoable.
7. **Dependencies.** Pin exact versions; prefer few, well-maintained packages. LT and JRE are downloaded by `scripts/fetch-runtime` with checksums, never committed.
8. **Platform parity.** Paths through Rust `PathBuf`, never string concatenation; test path handling with Windows separators. CI matrix: `macos-latest`, `windows-latest`.
9. **Communication.** At the end of each phase, summarize what was built, how to try it, what was deferred, and any open question from the Risks list that now needs an answer. Ask before deviating from this plan in user-visible behavior.
10. **German UI strings** live in one module (`src/i18n/de.ts`). Use proper German typography in UI text (typographic quotes „…“, no em dashes).
