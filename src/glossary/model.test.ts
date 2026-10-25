import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseProPra, type ParserConfig } from "../editor/parser";
import { duplicateNames, glossaryTerms, outOfOrder, sortKey, termInsertion } from "./model";

const CFG: ParserConfig = { blockMacros: [{ name: "INSTRUCTOR", arity: 1 }, { name: "NOTICE", arity: 0 }, { name: "WARNING", arity: 0 }] };
const GLOSSARY = readFileSync(join(__dirname, "../../test-fixtures/course/ch/glossary.md"), "utf8").replace(/\r\n/g, "\n");
const parse = (t: string) => parseProPra(t, CFG);

function insert(text: string, name: string) {
  const ins = termInsertion(parse(text), name);
  const out = text.slice(0, ins.from) + ins.insert + text.slice(ins.from);
  return { out, ins };
}

/** The heading and term lines of a glossary, in order. */
const outline = (t: string) => t.split("\n").filter((l) => /^(## |\[TERM0?::)/.test(l));

describe("glossary model", () => {
  it("parses TERM blocks and TERM0 entries with their ranges", () => {
    const doc = parse(GLOSSARY);
    const terms = glossaryTerms(doc);
    expect(terms).toHaveLength(17);
    const acc = terms[0];
    expect(acc.names).toEqual(["Account", "Konto", "Benutzerkonto"]);
    expect(GLOSSARY.slice(acc.from, acc.to)).toMatch(/^\[TERM::Account.*\[ENDTERM\]$/s);
    expect(GLOSSARY.slice(acc.bodyFrom, acc.bodyTo)).toBe("Die Identität eines Benutzers in einem Betriebssystem.\nSiehe auch [TERMREF::Shell].\n");
    const datei = terms.find((t) => t.names[0] === "Datei")!;
    expect(datei.term0).toBe(true);
    expect(datei.bodyFrom).toBe(datei.bodyTo);
  });

  it("sorts like sedrila (casefold, backquotes ignored, code-point order)", () => {
    expect(sortKey("`ls`")).toBe("ls");
    expect(sortKey("Straße")).toBe("strasse");
    expect(sortKey("Übersetzer") > sortKey("Zweig")).toBe(true); // ü > z in code points
    expect(outOfOrder(glossaryTerms(parse(GLOSSARY)))).toEqual([]);
    const bad = "title: G\n---\n[TERM0::Beta]\n[TERM0::Alpha]\n";
    expect(outOfOrder(glossaryTerms(parse(bad))).map((t) => t.names[0])).toEqual(["Alpha"]);
  });

  it("finds duplicate names across entries", () => {
    const t = "title: G\n---\n[TERM0::Shell|Bash]\n[TERM::Bash]\nx\n[ENDTERM]\n";
    expect([...duplicateNames(glossaryTerms(parse(t))).keys()]).toEqual(["Bash"]);
  });

  it("inserts a new term inside its letter section, in order", () => {
    const { out, ins } = insert(GLOSSARY, "Azure");
    expect(outline(out).slice(0, 5)).toEqual(["## A", "[TERM::Account|Konto|Benutzerkonto]", "[TERM::API|Web-API]", "[TERM::Argument]", "[TERM::Azure]"]);
    expect(out.slice(ins.cursor - "[TERM::Azure]\n".length, ins.cursor + "[ENDTERM]".length + 1)).toBe("[TERM::Azure]\n\n[ENDTERM]");
    // still parses and stays sorted
    expect(outOfOrder(glossaryTerms(parse(out)))).toEqual([]);
  });

  it("inserts before the first larger term of the section", () => {
    const { out } = insert(GLOSSARY, "Bibliothek");
    const o = outline(out);
    expect(o.slice(o.indexOf("## B"), o.indexOf("## B") + 4)).toEqual(["## B", "[TERM::Bash|.bashrc]", "[TERM::Bibliothek]", "[TERM::Branch|Zweig]"]);
  });

  it("creates a missing letter heading at the right place", () => {
    const e = outline(insert(GLOSSARY, "Ende").out);
    expect(e.slice(e.indexOf("## D"), e.indexOf("## D") + 4)).toEqual(["## D", "[TERM0::Datei]", "## E", "[TERM::Ende]"]);
    // "Z" sorts before "Ü" in code points, so ## Z goes before ## Ü
    const z = outline(insert(GLOSSARY, "Zebra").out);
    expect(z.slice(-4)).toEqual(["## Z", "[TERM::Zebra]", "## Ü", "[TERM::Übersetzer|Compiler]"]);
    const u = outline(insert(GLOSSARY, "Übung").out);
    expect(u.slice(-3)).toEqual(["## Ü", "[TERM::Übersetzer|Compiler]", "[TERM::Übung]"]);
  });

  it("works for glossaries without letter headings", () => {
    const t = "title: G\n---\n[TERM::Alpha]\na\n[ENDTERM]\n\n[TERM::Gamma]\ng\n[ENDTERM]\n";
    expect(outline(insert(t, "Beta").out)).toEqual(["[TERM::Alpha]", "[TERM::Beta]", "[TERM::Gamma]"]);
    expect(outline(insert(t, "Zeta").out)).toEqual(["[TERM::Alpha]", "[TERM::Gamma]", "[TERM::Zeta]"]);
    expect(outline(insert("title: G\n---\nText\n", "Erster").out)).toEqual(["[TERM::Erster]"]);
  });

  const PROPRA = process.env.PROPRA_INF_DIR;
  it.skipIf(!PROPRA || !existsSync(join(PROPRA ?? "", "ch/glossary.md")))("golden: propra-inf glossary parses, is ordered, and insertion keeps order", () => {
    const text = readFileSync(join(PROPRA!, "ch/glossary.md"), "utf8");
    const terms = glossaryTerms(parse(text));
    expect(terms.length).toBeGreaterThan(200);
    expect(outOfOrder(terms).map((t) => t.names[0])).toEqual([]);
    for (const name of ["Aaa-Test", "Mittelwort", "Zzz", "Ölwechsel"]) {
      const { out } = insert(text, name);
      expect(outOfOrder(glossaryTerms(parse(out))).map((t) => t.names[0]), name).toEqual([]);
    }
  });

  it.skipIf(!PROPRA || !existsSync(join(PROPRA ?? "", "ch/glossary.md")))("golden: 20 TERMREFs spread over propra-inf resolve to a definition", () => {
    const text = readFileSync(join(PROPRA!, "ch/glossary.md"), "utf8");
    const byName = new Map<string, { names: string[]; body: string; term0: boolean }>();
    for (const t of glossaryTerms(parse(text))) for (const n of t.names) byName.set(n, { names: t.names, body: text.slice(t.bodyFrom, t.bodyTo), term0: t.term0 });
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f.endsWith(".zip") ? [] : walk(join(d, f))) : f.endsWith(".md") && f !== "glossary.md" ? [join(d, f)] : []));
    const refs: string[] = [];
    for (const f of walk(join(PROPRA!, "ch"))) for (const c of parse(readFileSync(f, "utf8")).termrefs) refs.push(c.args[0]);
    expect(refs.length).toBeGreaterThan(400);
    const sample = Array.from({ length: 20 }, (_, i) => refs[Math.floor((i * refs.length) / 20)]);
    for (const term of sample) {
      const t = byName.get(term);
      expect(t, term).toBeDefined();
      expect(t!.term0 || t!.body.trim().length > 0, term).toBe(true);
    }
  });
});
