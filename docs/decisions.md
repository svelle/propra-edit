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

Consequences for Phase 2:
- Send a warm-up check right after start, so the first real check is not 15 s.
- The German speller dominates check time here. Must be re-measured on the target
  machines; if it stays above ~1 s, options are a client-side spell checker
  (Hunspell dictionary in the frontend or Rust) with LanguageTool for grammar only,
  or tuning the speller. Not decided yet.
- RAM is within the plan's 500 MB to 1 GB estimate; keep `-Xmx1g`.
- Still to do on macOS and Windows: jlink-trimmed JRE, startup time and RAM.
