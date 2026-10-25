# Decisions log

Running log of non-obvious choices: versions, parser rules, deviations from the plan.
Newest entries at the end of each section.

## Versions (2026-10-25)

Pinned exactly; each release at least two weeks old on 2026-10-25 (cutoff 2026-10-11).

| Package | Version | Released |
| --- | --- | --- |
| tauri (crate) | 2.12.3 | 2026-10-10 |
| tauri-build | 2.7.2 | 2026-10-10 |
| tauri-plugin-dialog | 2.8.2 | 2026-10-10 |
| tauri-plugin-opener | 2.7.1 | 2026-10-10 |
| @tauri-apps/cli / api | 2.12.2 / 2.12.3 | 2026-10-10 |
| CodeMirror (@codemirror/view, state, language, …) | see package.json | ≤ 2026-10-07 |
| @lezer/markdown | 1.8.0 | 2026-10-07 |
| vite / vitest / typescript | 8.3.4 / 5.0.3 / 7.0.2 | ≤ 2026-10-08 |
| notify | 8.0.0 | 2025 |
| serde_yaml | 0.9.34 | 2024 (archived but stable; only used to read sedrila.yaml and top matter) |
| LanguageTool (spike only) | 6.8 | 2026-05-05 |

- Transitive Rust dependencies are fixed by `Cargo.lock`; their release dates were not checked
  individually (crates.io's API is not reachable from the build sandbox).
- npm needs `legacy-peer-deps=true` (in `.npmrc`): npm 10 crashes resolving vitest 5's
  optional peer set (`Cannot read properties of null (reading 'edgesOut')`).
- Frontend: plain TypeScript, no Svelte. The UI is small (tree, tabs, dialogs); CodeMirror
  does the heavy lifting.

## sedrila spec vs. plan (read: sedrila 3.2.0 `docs/authors.md` and source)

- **Chapters and taskgroups come from the `chapters:` list in `sedrila.yaml`**, not from
  directories (sedrila ignores unlisted directories). The index follows sedrila; unlisted
  directories appear under „Weitere Dateien > Nicht in sedrila.yaml“.
- **Zip-dir part names include `.zip`** (`[PARTREF::encoding.zip]`), and zip dirs exist at
  chapter and taskgroup level.
- **`[TERM0::…]` is an inline macro** (1 argument, no `[ENDTERM0]`); only `[TERM]` is a block.
- **`[PROT]` is a single call** (sedrila mode BLOCK, but no END macro).
- **User-defined block macro arity** follows sedrila: 2 if the `blockmacro_topmatter` template
  contains `{arg2}`, 1 if `{arg1}`, else 0. So in propra-inf `INSTRUCTOR` takes 1 argument,
  `NOTICE`/`WARNING` take 0.
- **Section subtypes may be comma lists** (`[SECTION::goal::idea,trial]`); relevant for the
  Phase 3 lint.
- **Macro regex** is copied from sedrila: `\[([A-Z][A-Z0-9_]+)(::(.*?))?(::(.*?))?\]` not
  followed by `(`. Consequences: names need at least two characters; more than two `::`
  end up in arg 2; a call never spans lines.
- **Macros are expanded inside fenced code too.** Only `macros off` regions are exempt.
  The parser therefore finds macros everywhere in the body except those regions.
- **Top matter split:** sedrila splits at the first occurrence of the substring `"---\n"`,
  which would also match e.g. `foo---`. The editor uses the first line that is exactly `---`
  (also with CRLF). Identical for all real files.
- `ch/index.md` (course start page) has empty top matter (first line is `---`).
- Enumeration numbers do not account for `[EC]/[EQ]/[ER]` coming from `[INCLUDE]`d files
  (sedrila expands INCLUDE early, so such enumerations would shift the numbering).
  No included file in propra-inf contains one today.

## Real-content findings

The golden test (`PROPRA_INF_DIR=… npm test`) found 15 problems in propra-inf itself:
13 unclosed `[SECTION]`/misnested blocks, an `[INSTRUCTOR::…]` call split over two lines
(`Werkzeuge/Git/git-Anpassen.md`), and `set[URL]` in unprotected Python code
(`Programmierpraxis/Python-linkcheck/linkcheck-core.md`). sedrila does not check X/ENDX
pairing, so the build does not report them. They are listed in
`test-fixtures/propra-inf-known-issues.txt`; the golden test fails only on new problems.

## altdir solution format

Confirmed with one real sample (`git-Repository`, task + solution file):

```
- [EREFQ::1] Antwort …
Fortsetzungszeile, nicht eingerückt.
- [EREFQ::2] **Knackpunkt:** …
```

One list item per enumeration, markers in order, continuation lines not indented, no
preamble. The F5 segment rule from the plan (segment = from a marker line to the next marker
line or heading) fits. Fixtures also keep a numbered-list variant, a heading variant and a
file without markers to exercise robustness and the fallback.

## Editor behavior

- Enumeration badge shows only the number („3“) right after `[EQ]`, with tooltip „EQ 3“.
  The plan says „EQ 3“; since the `[EQ]` text is directly in front, the kind is not
  repeated. Easy to change in `EnumBadge` if wanted.
- Line endings: files are edited with `\n`; the dominant ending (LF/CRLF) and a UTF-8 BOM
  are restored on save. Files that mix CRLF and LF get a notice; saving normalizes them to
  the dominant ending (CodeMirror cannot keep mixed endings).
- External changes: the frontend compares disk content with what it last loaded/saved.
  Equal: ignored (covers our own saves). Clean tab: reloaded as an undoable transaction.
  Dirty tab: prompt (reload or keep).
- All file commands are restricted to the open course root (checked in Rust).
- macOS menu: custom, without the default Close/Quit items, so Cmd+W closes a tab and
  Cmd+Q goes through the unsaved-changes prompt. Edit menu keeps Cut/Copy/Paste/Select All
  (needed for clipboard shortcuts in WKWebView) but not Undo/Redo (CodeMirror handles them).

## Phase 0 spike: LanguageTool (Linux sandbox, not yet macOS/Windows)

Setup: LanguageTool 6.8 server + `language-de` from Maven Central (172 jars, 252 MB),
system OpenJDK 21, `-Xmx1g`, 4 CPU cores. languagetool.org downloads are blocked in the
sandbox; Maven Central works and is a viable source for `scripts/fetch-runtime`.

| Measurement | Result |
| --- | --- |
| Server startup until HTTP answers | 2.0 to 2.7 s |
| First check (lazy rule loading) | 11 to 15 s |
| Following checks, one sentence | 1.2 to 1.5 s, stable after warm-up |
| Same paragraph without `GERMAN_SPELLER_RULE` | 0.15 s |
| RSS after a few checks | ~880 MB |
| Detects „Fehlerr“ (GERMAN_SPELLER_RULE) and „mit der Kommando“ (DE_AGREEMENT) | yes |

**Resolved in Phase 2:** the slowness was not the speller as such. LanguageTool's server
builds a new rule pipeline (including `GermanSpellerRule.init`) for every request unless
`pipelineCaching=true` is set (found with jstack). With

```
pipelineCaching=true
maxPipelinePoolSize=2
pipelineExpireTimeInSeconds=86400
```

the numbers become (same sandbox, jlink JRE, `-Xmx1g -XX:+UseSerialGC`):

| Measurement | Result |
| --- | --- |
| Startup until HTTP answers | ~2 s |
| Warm-up check (done by the app before reporting „bereit“) | 11 to 15 s |
| One sentence after warm-up | 25 to 45 ms |
| 40-line passage | ~0.7 s |
| Whole real task file (13 to 37 chunks, one batch) | 0.6 to 1.6 s |
| RSS | ~810 MB |

`pipelinePrewarming=true` was rejected: it warms all languages, startup 21 s, 1.3 GB.
Still to do: the same measurements on macOS and Windows (the user's machines).

## Phase 2: LanguageTool integration

- **Source:** Maven Central (`org.languagetool:languagetool-server` + `language-de`, 6.8),
  resolved by `scripts/fetch-runtime.*` with `mvn -C` (strict checksum verification).
  languagetool.org is not needed. Only German is bundled (252 MB of jars); English was in
  the plan but nothing in the course needs it.
- **JRE:** `jlink` from the JDK that runs the script (CI: Temurin 21 via setup-java, which
  verifies its download). Modules: java.base, java.compiler, java.desktop, java.instrument,
  java.logging, java.management, java.naming, java.net.http, java.scripting, java.sql,
  java.xml, jdk.crypto.ec, jdk.httpserver, jdk.localedata (de, en), jdk.unsupported,
  jdk.zipfs. 57 MB. The macOS build is arm64 only (macos-latest runners).
- **Bundling:** Tauri resources `resources/jre/` and `resources/languagetool/`. Placeholder
  `.gitkeep` files keep the directories present so builds work without the runtime; the app
  then shows „LanguageTool: Fehler“ with the hint to run the script. Settings `ltJava` and
  `ltLibDir` can point to another Java/jar directory.
- **Process:** Rust starts the server at launch on 127.0.0.1 and a free port, health-checks
  `/v2/languages`, sends a warm-up check, then reports „bereit“. Checks wait for that state.
  Crashes restart with backoff 1, 2, 4, 8, 16 s (at most 5 times; counter resets after 5
  minutes of uptime); the status bar button restarts manually. The process is killed on app
  exit. If the app itself crashes, the Java process stays until it is killed (no job object
  or parent watchdog yet).
- **HTTP client:** `ureq` 2.12.1 without TLS (localhost only).
- **Masking** (`src/grammar/mask.ts`): every character is prose or markup; markup can carry
  `interpretAs`. Priorities, low to high: line breaks (→ space), paragraph breaks before list
  items/headings/quotes/table rows (→ blank line), Markdown marks from the syntax tree,
  trailing whitespace, bare URLs and paths (→ „X“), fences/macros-off/replacement tags,
  top matter, macros. Macro rules: `[TERMREF::x]` → „x“, `[TERMREF2::x::-s]` → „xs“, other
  `TERMREF2`/`PARTREF2` texts and HINT/FOLDOUT/INSTRUCTOR titles are checked as prose,
  `[PARTREF::x]` → „x“, HREF and EREF → „X“, label macros at line start (`[EQ] …`,
  `- [EREFQ::1] …`) vanish with their space, block macro lines → blank line.
  Inline code is read as „X“ so sentences keep a word there.
- **Incremental checks:** chunks are runs of non-blank lines (fences and macros-off regions
  do not split). Results are cached by the chunk's exact segment content, so editing one
  paragraph re-checks only that paragraph. Uncached chunks are batched into one request
  (up to 20,000 characters). The linter runs 400 ms after typing stops; results arrive
  asynchronously and trigger a re-lint, so typing is never blocked.
- **Noise filters** (found on 5 real tasks, see below): matches that only cover markup or
  the whitespace next to it are dropped; `UPPERCASE_SENTENCE_START` at the very start of a
  chunk is dropped (a sentence often continues after a code block).
- **Speller acceptance:** personal dictionary (`dictionary.json` in the config dir), all
  glossary names and part names (also split at spaces, hyphens, underscores), and simple
  inflections of glossary/part names (+s, +es, +en, +n, +e). Filtering happens client-side,
  so changes apply immediately.
- **Default rule settings:** `WHITESPACE_RULE` disabled (tables and alignment). The German
  straight-quote rule `TYPOGRAFISCHE_ANFUEHRUNGSZEICHEN` is off in LanguageTool by default
  and can be enabled in the settings, as can `DE_DASH` etc.
- **Real-file check (5 propra-inf tasks):** no false positives on macros, code, URLs, paths
  or top matter after the fixes above. Remaining hits are English technical words (to be
  handled by glossary and dictionary) and real findings, for example a stray „)“ in
  `Werkzeuge/Git/git-Funktionsweise.md` line 50.

## Phase 3: structural lints and top matter assistance

- **Lints** (`src/lint/structural.ts`) are a pure function of the ProPraDoc and a course
  context; ids are stable and can be silenced per file (stored in settings by the file's
  path relative to the course root). Ids: unknown-macro, macro-arity, glossary-only-macro,
  block-unclosed, block-unmatched-end, block-misnested, block-not-alone, block-nesting,
  section-type, section-subtype, termref-unknown, partref-unknown, include-missing,
  snippet-missing, eref-range, topmatter-missing/-difficulty/-timevalue/-stage/-explains/
  -explains-chapter/-assumes/-requires.
- **Checked against real sedrila:** sedrila 3.2.0 (installed from source; the PyPI wheel
  lacks its `templates/` directory and fails at the end of a build) was run over a copy of
  propra-inf. Findings that shaped the rules:
  - sedrila's "empty line before and after" warning only concerns block *starts* in the
    middle of a Python-Markdown paragraph, and it fires zero times for propra-inf. Mirroring
    Python-Markdown's paragraph rules (HTML comments, includes) produced 93 false positives,
    so there is no such lint.
  - Nesting a block in a block of the same kind is used on purpose (58 times `[HINT]` in
    `[HINT]`) and renders fine. Only `[SECTION]` nesting and `[INNERSECTION]` outside a
    `[SECTION]` are reported. Nesting under an unclosed block is not reported again.
  - TERMREF targets must match a glossary name exactly (case-sensitive), PARTREF targets
    a part name exactly.
  - `[SNIPPET::ALT::name]`: for SNIPPET only, a bare `ALT`/`ITREE` means `ALT:`/`ITREE:`.
  - Include resolution (`src-tauri/src/course/includes.rs`) mirrors `includefile_path`;
    every non-altdir INCLUDE/PROT/SNIPPET/TREEREF in propra-inf resolves (Rust golden test).
    When altdir/itreedir is missing, references into it are not reported.
  - sedrila exits with code 0 even when it reports errors; Phase 7 must parse the final
    `==== N errors` line instead of trusting the exit code.
- **Golden result:** 20 findings over all of propra-inf, all real or deliberate:
  11 unclosed `[SECTION]`, 2 stray `[ENDINSTRUCTOR]` (the opening call is split over two
  lines), 2 × `set[URL]` in unprotected code, `[EREFQ::4]`/`[EREFQ::5]` in `apt101.md`
  where the task only has `[EC]` (should be `[EREFC::…]`), and 3 generic examples in the
  Feedback tasks. Listed in `test-fixtures/propra-inf-known-lints.txt`.
- **Glossary order (for Phase 4):** sedrila warns when main terms are not sorted by
  `term.replace('`', '').casefold()`, i.e. case-insensitive code-point order. Umlauts
  therefore sort after „z“ (as in `glossary.md`: „Ü“ comes last).
- **Top matter in the Rust index:** if serde_yaml rejects the top matter (e.g. a duplicate
  key, which PyYAML accepts), a line-based fallback reads title/stage/difficulty/timevalue.
- **Assistance:** completion for top matter keys and values (stage, difficulty, comma-aware
  part names for assumes/requires, glossary names for explains), macro names after `[`,
  PARTREF/TERMREF arguments, SECTION types and subtypes, EREF numbers, and paths inside
  INCLUDE/PROT/SNIPPET/TREEREF (including `ALT:`, `ITREE:`, `/`). Hover shows a part's title
  and path, a term's synonyms, or an include's resolved path; Cmd/Ctrl+click opens the part,
  the glossary at the term, or the included file. TERMREF hover/click are a small preview of
  Phase 4 (definition rendering and the side panel come there).
- **Problems panel:** CodeMirror's lint panel (Cmd/Ctrl+Shift+M, F8 for the next problem),
  plus a „⚠ N“ button in the status bar.

## Phase 4: glossary

- **Live model:** the term map (names, definition text, TERM/TERM0) is parsed in the frontend
  (`src/glossary/model.ts`) from the glossary tab if it is open, including unsaved edits,
  otherwise from disk. Hovers, TERMREF/explains lints, completion and the speller's accepted
  words all use it, so a new term takes effect without saving.
- **Side panel:** a second editor showing one `[TERM]` block of glossary.md ("slice editor",
  `src/editor/slice.ts`: the whole document is loaded, the rest is hidden and cannot be
  entered or edited). glossary.md is opened as a (background) tab and is the master document;
  edits sync both ways, the tab shows the unsaved state, Cmd/Ctrl+S in the panel saves it.
  The panel keeps its own undo history; panel edits are not added to the tab's history.
- **New term quick fix** („Begriff im Glossar anlegen“ on unknown TERMREF/explains, or F12 on
  an unknown term): inserted at sedrila's sort position (casefold, backquotes ignored,
  code-point order) inside the matching `## X` letter section; a missing letter heading is
  created. The insertion is a normal, undoable edit of the glossary tab and is shown in the
  panel right away instead of a separate diff dialog; nothing is written until saved.
- **Glossary lints:** `glossary-duplicate` (a name defined twice) and `glossary-order`
  (sedrila's "not in alphabetical order" warning). The propra-inf glossary has neither.
- **Hover rendering:** markdown-it with a small macro approximation (`src/preview/render.ts`),
  the start of the Phase 6 preview.
- **markdown-it 15.0.3** is only 9 days old (rule: two weeks). 15.0.2 has two published
  denial-of-service advisories (GHSA-vfgh-jcmw-g37q, GHSA-gfr2-rv44-r23c) fixed in 15.0.3,
  so the security patch release wins.
- **„Wo verwendet?“** scans all Markdown files in chapterdir for TERMREF/TERMREF2 and
  `explains:` (Rust, `course/usages.rs`); cached until the next file change.
- A global error handler shows unexpected JavaScript errors as a toast (the webview console
  is not reachable in release builds).

## Phase 5: inline altdir solutions

- **Segments** (`src/altdir/segments.ts`): a solution starts at a line whose first token is
  `[EREFx::n]` (after an optional list marker or heading #s) and runs to the next marker line;
  a heading ends a list-item segment, and a heading of equal or higher level ends a
  heading-style segment. Fenced code is skipped. Text before the first marker is the preamble;
  text after a closing heading is an "other" segment. Verified with the real `git-Repository`
  solution file (list items, unindented continuation lines) and the fixture variants.
- **Document model:** the solution file is a state field inside the task's EditorState,
  changed only via an effect that `invertedEffects` makes undoable. Edits in the inline
  editors are applied with `addToHistory: false` (each inline editor has its own undo);
  renumbering and „+ Lösung anlegen“ are undoable in the task editor. Renumbering changes both
  documents in one transaction, so one undo reverts both, and also restores the "accepted
  numbering" so the warning comes back.
- **Inline editors** are slice editors (as in the glossary panel) on the solution document,
  mounted inside block widgets after the paragraph of each enumeration. Widgets keep their
  DOM while only ranges change. Spacing uses padding, not margins: CodeMirror measures block
  widgets with offsetHeight, and margins shifted the line numbers.
- **Enumeration identity:** positions of `[EC]/[EQ]/[ER]` are mapped through every change; the
  numbering at load (or after renumbering/„Ignorieren“) is the baseline. A warning bar appears
  when an existing enumeration's number differs from the baseline. Renumbering rewrites
  `[EREFx::old]` → `[EREFx::new]` simultaneously in the solution file and in the task (e.g.
  INSTRUCTOR text), after a diff preview. Deleted enumerations keep their solutions' numbers
  (they then show up as orphans or doubles); `_include` files are never rewritten.
- **Display:** every enumeration gets a box, also those without a solution („+ Lösung
  anlegen“ inserts `- [EREFx::n] ` in number order, in the style of the neighbouring markers).
  Orphaned solutions, the preamble and "other" parts are in one box at the end of the task.
  A file without markers is shown once, below the `[INSTRUCTOR]` that includes `ALT:`.
- **Saving:** Cmd/Ctrl+S saves the task and, if changed, the solution file (created, including
  missing directories, if it did not exist). The tab's unsaved marker covers both. External
  changes to the solution file reload silently when it is clean, otherwise ask.
- **Toggle:** toolbar „Lösungen“ or Cmd/Ctrl+Shift+L; collapsed boxes are remembered per file.
- **Open question decided by default:** solutions are shown only below the enumerations, not
  next to `[EREFx]` references in `[INSTRUCTOR]` text.

## Phase 6: preview

- **Renderer** (`src/preview/render.ts`) follows sedrila's two stages: `[INCLUDE]`/`[SNIPPET]`
  insert raw text before Markdown (one level, so no cycles), every other macro becomes a
  placeholder that is expanded in the rendered HTML with sedrila's markup (class names from
  `framework/macroexpanders.py` and `course/glossary.py`) and sedrila's `<p>` fix-up for
  block macros. Like sedrila's preprocessor, `<!-- @LINK_SPEC -->` comments are dropped and
  `<replacement>` tags are removed (their content stays, as in author builds).
- **Markdown dialect:** markdown-it (CommonMark) with `typographer` minus smart quotes
  (≈ sedrila's `smarty` with `smart_quotes: False`). sedrila uses Python-Markdown, whose list
  rules differ (indentation, lists directly after a paragraph). Checked against a real sedrila
  build of propra-inf (instructor pages, structural signature: sections, enumerations, block
  macros, term references, headings, list items): 292 of 351 files match; all 59 differences
  are list-item counts. Emulating Python-Markdown's list rules made it worse, so it stays
  CommonMark.
- **Not reproduced:** code highlighting (codehilite), the assumes/requires box, glossary link
  blocks ("explained by"), PROT specification checks, images with relative paths.
- **Panel** (`src/panels/preview.ts`): shadow root with the course's `sedrila.css`,
  `local.css` and `codehilite.css` (`:root`/`html`/`body` rewritten to the preview root).
  Rendering is debounced (250 ms); the full propra-inf glossary (118 KB) renders in about
  19 ms. Includes are resolved by the Rust core (same rules as the lints) and read from open
  tabs and the inline solution document first, so unsaved text shows up. Scroll sync is
  one-way (editor → preview) via `data-line` on block elements, interpolated between them;
  double-click in the preview jumps the editor to that line. Links: PARTREF opens the part,
  TERMREF the glossary panel, http(s) the browser.
- **Tutor-Ansicht** only hides `[INSTRUCTOR]` blocks with CSS; sedrila's student build removes
  them before numbering, so `[EQ]` inside an `[INSTRUCTOR]` would shift numbers there. Rare.
- **mermaid 12.1.0**, loaded lazily on the first diagram; SVGs are cached by source text. Its
  dependency KaTeX 0.16.x has a low-severity advisory (GHSA-238p-pmpm-9mq7, prototype
  pollution); KaTeX is pinned to the patched 0.18.11 (2026-10-01) via `overrides` in
  package.json, although mermaid declares `^0.16.47`.
- Shortcut Cmd/Ctrl+Shift+V (as in VS Code's Markdown preview); F8 stays „Nächstes Problem“.
