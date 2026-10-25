# Test fixtures

`course/` is a small fake sedrila course that mirrors the structure of
[propra-inf](https://github.com/fubinf/propra-inf):

- `sedrila.yaml` with `chapterdir`, `altdir`, `itreedir`, `stages`,
  `blockmacro_topmatter` and the `chapters:` list.
- 2 chapters (`Basis`, `Sprachen`), 3 taskgroups (`Shell`, `Git`, `Python`), 8 tasks.
- `ch/glossary.md` with 17 terms (one `TERM0`), `ch/_include/`, `ch/template.md`.
- `ch/Sprachen/Python/py-Daten.zip/`: a zip directory (a part, not a task).
- `altdir/ch/...`: solution files using `[EREFx::n]` markers:
  - `Shell-Einstieg.md`: list-item markers (`- [EREFQ::n]`) with unindented continuation
    lines. This is the real propra-inf format (confirmed with a sample solution file).
  - `Shell-Pipes.md`: numbered list markers plus a `.prot` file next to it.
  - `Git-Einstieg.md`: heading markers (`#### [EREFQ::n]`) and one **orphan** (`EREFQ::5`).
  - `py-Einstieg.md`: **no markers** (exercises the whole-file fallback).
  - `Git-Merge` and `py-Funktionen` have **no solution file**.
- `altdir/itree.zip/...`: files referenced via `[TREEREF]`.

The real altdir of propra-inf is private. The list-item format was confirmed with one
real sample (`git-Repository`); the numbered-list and heading variants are kept to make
the segment parser robust. See `docs/decisions.md`.

Never point automated tests at a real course checkout except through the
opt-in golden test (`PROPRA_INF_DIR`).
