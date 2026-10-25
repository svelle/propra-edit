import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseProPra, type ParserConfig } from "../editor/parser";
import { includeKey, structuralLints, type FileKind, type IncludeStatus, type LintContext, type LintId } from "./structural";

const FIXTURES = join(__dirname, "../../test-fixtures/course");
const CFG: ParserConfig = { blockMacros: [{ name: "INSTRUCTOR", arity: 1 }, { name: "NOTICE", arity: 0 }, { name: "WARNING", arity: 0 }] };

/** Course context read from disk the simple way (good enough for tests). */
export function contextFromDisk(root: string) {
  const yaml = readFileSync(join(root, "sedrila.yaml"), "utf8");
  const stages = (/^stages:\s*\[(.*)\]/m.exec(yaml)?.[1] ?? "").split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  const sectionTypes: Record<string, string[]> = {};
  for (const m of yaml.matchAll(/^\s+section_([a-z]+)(?:_([a-z]+))?:/gm)) {
    sectionTypes[m[1]] ??= [];
    if (m[2]) sectionTypes[m[1]].push(m[2]);
  }
  const chdir = join(root, "ch");
  const partNames = new Set<string>();
  for (const ch of readdirSync(chdir)) {
    const chp = join(chdir, ch);
    if (!statSync(chp).isDirectory() || ch.startsWith("_")) continue;
    partNames.add(ch);
    for (const tg of readdirSync(chp)) {
      const tgp = join(chp, tg);
      if (!statSync(tgp).isDirectory()) continue;
      partNames.add(tg); // taskgroup or zip dir
      for (const f of readdirSync(tgp)) {
        if (f.endsWith(".md") && f !== "index.md") partNames.add(f.slice(0, -3));
        if (f.endsWith(".zip") && statSync(join(tgp, f)).isDirectory()) partNames.add(f);
      }
    }
  }
  const glossaryNames = new Set<string>();
  const g = parseProPra(readFileSync(join(chdir, "glossary.md"), "utf8"), CFG);
  for (const c of g.macros) if ((c.name === "TERM" || c.name === "TERM0") && c.args[0]) for (const n of c.args[0].split("|")) glossaryNames.add(n.trim());
  return { stages, sectionTypes, partNames, glossaryNames };
}

const course = contextFromDisk(FIXTURES);

function lint(text: string, kind: FileKind = "task", includes: Map<string, IncludeStatus> = new Map()) {
  const doc = parseProPra(text, CFG, { topMatter: kind !== "include" && kind !== "other" });
  const ctx: LintContext = { fileKind: kind, ...course, includes };
  return structuralLints(doc, ctx);
}
const ids = (text: string, kind?: FileKind, inc?: Map<string, IncludeStatus>) => lint(text, kind, inc).map((f) => f.id);
const TM = "title: T\ntimevalue: 1\ndifficulty: 2\nstage: alpha\n---\n";

describe("structural lints: every lint triggers and stays quiet", () => {
  const cases: [LintId, string, string, FileKind?][] = [
    ["unknown-macro", TM + "a[FOO] b\n", TM + "a [EQ] b\n"],
    ["macro-arity", TM + "[HREF]\n", TM + "[HREF::x]\n"],
    ["glossary-only-macro", TM + "[TERM0::x]\n", TM + "[TERMREF::Shell]\n"],
    ["block-unclosed", TM + "\n[HINT::x]\ny\n", TM + "\n[HINT::x]\ny\n[ENDHINT]\n"],
    ["block-unmatched-end", TM + "\n[ENDHINT]\n", TM + "\n[HINT::x]\n[ENDHINT]\n"],
    ["block-misnested", TM + "\n[NOTICE]\n\n[HINT::x]\n\n[ENDNOTICE]\n\n[ENDHINT]\n", TM + "\n[NOTICE]\n\n[HINT::x]\n\n[ENDHINT]\n\n[ENDNOTICE]\n"],
    ["block-not-alone", TM + "\nText [NOTICE]\n[ENDNOTICE]\n", TM + "\n[NOTICE]\nText\n[ENDNOTICE]\n"],
    ["block-nesting", TM + "[SECTION::goal::idea]\n[SECTION::goal::idea]\n[ENDSECTION]\n[ENDSECTION]\n", TM + "[SECTION::background::default]\n[INNERSECTION::goal::idea]\nx\n[HINT::a]\n[HINT::b]\n[ENDHINT]\n[ENDHINT]\n[ENDINNERSECTION]\n[ENDSECTION]\n"],
    ["section-type", TM + "[SECTION::ziel::idea]\n[ENDSECTION]\n", TM + "[SECTION::goal::idea]\n[ENDSECTION]\n"],
    ["section-subtype", TM + "[SECTION::goal::idee]\n[ENDSECTION]\n", TM + "[SECTION::goal::idea,trial]\n[ENDSECTION]\n"],
    ["termref-unknown", TM + "[TERMREF::Schell]\n", TM + "[TERMREF::Kommandozeile] [TERMREF2::Branch::-es]\n"],
    ["partref-unknown", TM + "[PARTREF::Shell-Anfang]\n", TM + "[PARTREF::Shell-Einstieg] [PARTREF2::py-Daten.zip::Daten]\n"],
    ["eref-range", TM + "[EQ] a\n[EREFQ::2]\n", TM + "[EQ] a\n[EQ] b\n[EREFQ::2] [EREFC::x]".replace(" [EREFC::x]", "")],
    ["topmatter-missing", "title: T\ndifficulty: 2\n---\n", TM],
    ["topmatter-difficulty", "title: T\ntimevalue: 1\ndifficulty: 5\n---\n", TM],
    ["topmatter-timevalue", "title: T\ntimevalue: viel\ndifficulty: 2\n---\n", "title: T\ntimevalue: 0.5 # Stunden\ndifficulty: 2\n---\n"],
    ["topmatter-stage", TM.replace("alpha", "gamma"), TM.replace("alpha", "beta (bitte prüfen)")],
    ["topmatter-explains", TM.replace("---", "explains: Shell, Schell\n---"), TM.replace("---", "explains: Shell, Commit (git)\n---")],
    ["topmatter-explains-chapter", "title: K\nexplains: Shell\n---\n", "title: K\n---\n", "chapter"],
    ["topmatter-assumes", TM.replace("---", "assumes: Shell-Einstieg, Gibtsnicht\n---"), TM.replace("---", "assumes: Shell-Einstieg, Git\n---")],
    ["topmatter-requires", TM.replace("---", "requires: Gibtsnicht\n---"), TM.replace("---", "requires: Shell-Pipes\n---")],
  ];
  for (const [id, bad, good, kind] of cases) {
    it(id, () => {
      expect(ids(bad, kind ?? "task"), "should trigger").toContain(id);
      expect(ids(good, kind ?? "task"), "should not trigger").not.toContain(id);
    });
  }

  it("include-missing and snippet-missing use the resolved include status", () => {
    const text = TM + "[INCLUDE::/_include/x.md]\n[SNIPPET::demo.py::quadrat]\n";
    const doc = parseProPra(text, CFG);
    const [inc, snip] = doc.includes;
    const status = (exists: boolean, snippetFound: boolean | null = null): IncludeStatus => ({ exists, snippetFound, treeMissing: false, path: "/p" });
    expect(ids(text, "task", new Map([[includeKey(inc), status(false)], [includeKey(snip), status(true, false)]]))).toEqual(["include-missing", "snippet-missing"]);
    expect(ids(text, "task", new Map([[includeKey(inc), status(true)], [includeKey(snip), status(true, true)]]))).toEqual([]);
    // altdir not checked out: no complaint
    expect(ids(text, "task", new Map([[includeKey(inc), { ...status(false), treeMissing: true }]]))).toEqual([]);
  });

  it("does not check references and top matter in include files", () => {
    expect(ids("[EREFQ::1] [TERMREF::Gibtsnicht] [PARTREF::Nix]", "include")).toEqual([]);
  });

  it("reports precise ranges", () => {
    const text = TM.replace("---", "assumes: Shell-Einstieg, Gibtsnicht\n---");
    const f = lint(text).find((x) => x.id === "topmatter-assumes")!;
    expect(text.slice(f.from, f.to)).toBe("Gibtsnicht");
    const t2 = TM + "Siehe [TERMREF::Schell].\n";
    const f2 = lint(t2).find((x) => x.id === "termref-unknown")!;
    expect(t2.slice(f2.from, f2.to)).toBe("Schell");
  });

  it("finds nothing in the fixture course", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f.endsWith(".zip") ? [] : walk(join(d, f))) : f.endsWith(".md") ? [join(d, f)] : []));
    for (const f of walk(join(FIXTURES, "ch"))) {
      const rel = f.slice(join(FIXTURES, "ch").length + 1);
      const kind = kindOf(rel);
      expect(lint(readFileSync(f, "utf8"), kind).map((x) => `${x.id}: ${x.message}`), rel).toEqual([]);
    }
  });
});

export function kindOf(rel: string): FileKind {
  const parts = rel.split("/");
  if (parts[0] === "_include") return "include";
  if (rel === "glossary.md") return "glossary";
  if (parts.length === 1) return "other";
  if (parts.length === 2) return parts[1] === "index.md" ? "chapter" : "other";
  if (parts.length === 3) return parts[2] === "index.md" ? "taskgroup" : "task";
  return "other";
}

const PROPRA = process.env.PROPRA_INF_DIR;
describe.skipIf(!PROPRA || !existsSync(join(PROPRA ?? "", "ch")))("golden: lints over propra-inf", () => {
  it("reports only known content problems", () => {
    const ctx = contextFromDisk(PROPRA!);
    const chdir = join(PROPRA!, "ch");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f.endsWith(".zip") ? [] : walk(join(d, f))) : f.endsWith(".md") ? [join(d, f)] : []));
    const found: string[] = [];
    for (const f of walk(chdir)) {
      const rel = f.slice(chdir.length + 1);
      const kind = kindOf(rel);
      const doc = parseProPra(readFileSync(f, "utf8"), CFG, { topMatter: kind !== "include" && kind !== "other" });
      for (const x of structuralLints(doc, { fileKind: kind, ...ctx, includes: new Map() })) {
        const line = doc.text.slice(0, x.from).split("\n").length;
        found.push(`${rel}:${line}: ${x.id}: ${x.message}`);
      }
    }
    const knownFile = join(__dirname, "../../test-fixtures/propra-inf-known-lints.txt");
    const known = new Set(existsSync(knownFile) ? readFileSync(knownFile, "utf8").split("\n").filter((l) => l && !l.startsWith("#")) : []);
    const fresh = found.filter((l) => !known.has(l));
    if (process.env.PRINT_LINTS) console.log(found.join("\n"));
    expect(fresh).toEqual([]);
  });
});
