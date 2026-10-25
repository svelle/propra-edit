import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { blockAtLine, parseProPra, type ProPraDoc } from "./parser";

const FIXTURES = join(__dirname, "../../test-fixtures/course");
const fixture = (rel: string) => readFileSync(join(FIXTURES, rel), "utf8");
const names = (doc: ProPraDoc) => doc.macros.map((m) => m.name);

describe("top matter", () => {
  it("splits at the first --- line without an opening ---", () => {
    const doc = parseProPra("title: Hallo\nstage: beta # Kommentar\ndifficulty: 2\n---\n[EQ] x\n");
    expect(doc.topMatter).toBeDefined();
    expect(doc.topMatter!.entries.map((e) => [e.key, e.value])).toEqual([
      ["title", "Hallo"],
      ["stage", "beta # Kommentar"],
      ["difficulty", "2"],
    ]);
    const e = doc.topMatter!.entries[0];
    expect(doc.text.slice(e.keyFrom, e.keyTo)).toBe("title");
    expect(doc.text.slice(e.valueFrom, e.valueTo)).toBe("Hallo");
    expect(doc.bodyFrom).toBe(doc.text.indexOf("[EQ]"));
  });

  it("ignores macros in the top matter", () => {
    const doc = parseProPra("title: [EQ] im Titel\n---\n[EQ]\n");
    expect(doc.enumerations).toHaveLength(1);
    expect(doc.enumerations[0].call.line).toBe(2);
  });

  it("handles empty top matter and files without top matter", () => {
    expect(parseProPra("---\nText\n").topMatter!.entries).toEqual([]);
    const inc = parseProPra("Text [EREFQ::1]\n", undefined, { topMatter: false });
    expect(inc.topMatter).toBeUndefined();
    expect(names(inc)).toEqual(["EREFQ"]);
  });
});

describe("macro calls", () => {
  const body = (s: string) => parseProPra(s, undefined, { topMatter: false });

  it("parses names, args and ranges", () => {
    const doc = body("Siehe [TERMREF2::Datei::-en] und [HREF::https://x.org/a?b=1].");
    const [t, h] = doc.macros;
    expect(t.name).toBe("TERMREF2");
    expect(t.args).toEqual(["Datei", "-en"]);
    expect(doc.text.slice(t.from, t.to)).toBe("[TERMREF2::Datei::-en]");
    expect(doc.text.slice(t.nameFrom, t.nameTo)).toBe("TERMREF2");
    expect(t.argRanges.map((r) => doc.text.slice(r.from, r.to))).toEqual(["Datei", "-en"]);
    expect(h.args).toEqual(["https://x.org/a?b=1"]);
  });

  it("follows sedrila's regex: no single-letter names, no Markdown links, lazy args", () => {
    expect(names(body("[A] [Link](http://x) [OK] [ok] [X1_Y]"))).toEqual(["OK", "X1_Y"]);
    // more than two '::' end up in arg2 (sedrila would then report a wrong arity elsewhere)
    expect(body("[SNIPPET::a::b::c]").macros[0].args).toEqual(["a", "b::c"]);
    expect(body("[INSTRUCTOR::]").macros[0].args).toEqual([""]);
    // a call never spans lines
    expect(body("[HINT::Titel\nweiter]").macros).toHaveLength(0);
  });

  it("knows the macro table including config-defined block macros", () => {
    const doc = parseProPra("[NOTICE]\n[ENDNOTICE]\n[MYBLOCK::x]\n[ENDMYBLOCK]\n[UNKNOWN]", { blockMacros: [{ name: "MYBLOCK", arity: 1 }] }, { topMatter: false });
    expect(doc.macros.map((m) => m.def?.kind ?? "unknown")).toEqual(["unknown", "unknown", "blockstart", "blockend", "unknown"]);
  });

  it("skips macros-off regions, also inside fences", () => {
    const doc = body("[EQ]\n<!-- sedrila: macros off -->\n```\na[INDEX] = [EQ]\n```\n<!--sedrila:macros off end-->\n[EQ]\n");
    expect(doc.enumerations.map((e) => e.number)).toEqual([1, 2]);
    expect(doc.macrosOff).toHaveLength(1);
    expect(doc.text.slice(doc.macrosOff[0].from, doc.macrosOff[0].to)).toContain("a[INDEX]");
    expect(doc.fences).toHaveLength(1);
  });

  it("expands macros inside fenced code (sedrila does too)", () => {
    const doc = body("```python\n[INCLUDE::demo.py]\n```\n");
    expect(names(doc)).toEqual(["INCLUDE"]);
    expect(doc.fences[0].lang).toBe("python");
  });

  it("records aloneOnLine", () => {
    const doc = body("  [HINT::x]  \ntext [ENDHINT]\n");
    expect(doc.macros.map((m) => m.aloneOnLine)).toEqual([true, false]);
  });

  it("finds replacement pseudo-tags", () => {
    const doc = body('a <replacement id="Kurs-URL">https://x</replacement> b');
    expect(doc.replacements).toEqual([{ from: 2, to: 52, id: "Kurs-URL" }]);
  });
});

describe("enumerations", () => {
  it("numbers EC, EQ and ER independently in file order", () => {
    const doc = parseProPra("[EC] [EQ]\n[EQ] [ER] [EC]\n[EQ]", undefined, { topMatter: false });
    expect(doc.enumerations.map((e) => `${e.kind}${e.number}`)).toEqual(["EC1", "EQ1", "EQ2", "ER1", "EC2", "EQ3"]);
  });

  it("numbers the fixture task", () => {
    const doc = parseProPra(fixture("ch/Basis/Shell/Shell-Einstieg.md"));
    expect(doc.enumerations.map((e) => `${e.kind}${e.number}`)).toEqual(["EC1", "EQ1", "EC2", "EQ2", "EQ3"]);
  });
});

describe("blocks", () => {
  const body = (s: string) => parseProPra(s, undefined, { topMatter: false });

  it("pairs blocks with nesting depth and body lines", () => {
    const doc = body("[SECTION::background::default]\n[INNERSECTION::goal::idea]\nx\n[ENDINNERSECTION]\ny\n[ENDSECTION]\n");
    expect(doc.blockErrors).toEqual([]);
    expect(doc.blocks.map((b) => [b.name, b.depth, b.bodyStartLine, b.bodyEndLine])).toEqual([
      ["SECTION", 0, 1, 4],
      ["INNERSECTION", 1, 2, 2],
    ]);
    expect(blockAtLine(doc, 2)!.name).toBe("INNERSECTION");
    expect(blockAtLine(doc, 4)!.name).toBe("SECTION");
    expect(blockAtLine(doc, 5)).toBeUndefined();
  });

  it("reports unclosed, unmatched and misnested blocks", () => {
    expect(body("[HINT::x]\ntext").blockErrors.map((e) => e.code)).toEqual(["unclosed"]);
    expect(body("[ENDHINT]").blockErrors.map((e) => e.code)).toEqual(["unmatched-end"]);
    const mis = body("[SECTION::a::b]\n[HINT::x]\n[ENDSECTION]\n[ENDHINT]\n");
    expect(mis.blockErrors.map((e) => `${e.code}:${e.call.name}`)).toEqual(["misnested:HINT", "unmatched-end:ENDHINT"]);
    expect(mis.blocks.find((b) => b.name === "SECTION")!.close).toBeDefined();
  });

  it("parses every fixture file without block errors", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".md")) files.push(p);
      }
    };
    walk(join(FIXTURES, "ch"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const isPart = !f.includes("_include");
      const doc = parseProPra(readFileSync(f, "utf8"), undefined, { topMatter: isPart });
      expect(doc.blockErrors, f).toEqual([]);
      if (isPart) expect(doc.topMatter, f).toBeDefined();
    }
  });
});

// Golden test against a real propra-inf checkout: set PROPRA_INF_DIR to run it.
const PROPRA = process.env.PROPRA_INF_DIR;
describe.skipIf(!PROPRA || !existsSync(join(PROPRA ?? "", "sedrila.yaml")))("golden: propra-inf", () => {
  it("parses every .md without crash, unknown macros or block errors", () => {
    const chdir = join(PROPRA!, "ch");
    const problems: string[] = [];
    let count = 0;
    const walk = (d: string, depth: number) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p, depth + 1);
        else if (f.endsWith(".md") && !p.includes(".zip")) {
          count++;
          const rel = p.slice(chdir.length + 1);
          // part files: tasks/index.md in chapter/taskgroup dirs and glossary.md
          const isPart = (depth === 2 || f === "index.md" || f === "glossary.md") && !rel.startsWith("_include");
          const doc = parseProPra(readFileSync(p, "utf8"), undefined, { topMatter: isPart });
          for (const m of doc.macros) if (!m.def) problems.push(`${rel}:${m.line + 1}: unknown macro [${m.name}]`);
          for (const e of doc.blockErrors) problems.push(`${rel}:${e.call.line + 1}: ${e.message}`);
          if (isPart && !doc.topMatter) problems.push(`${rel}: no top matter`);
        }
      }
    };
    walk(chdir, 0);
    expect(count).toBeGreaterThan(100);
    // Content problems that exist in propra-inf itself (sedrila does not check block pairing).
    // Only problems not listed in the known-issues file fail the test.
    const knownFile = join(__dirname, "../../test-fixtures/propra-inf-known-issues.txt");
    const known = new Set(readFileSync(knownFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
    const fresh = problems.filter((p) => !known.has(p));
    if (problems.length) console.log(`propra-inf: ${problems.length} known content problems, ${fresh.length} new`);
    expect(fresh).toEqual([]);
  });
});

describe("performance", () => {
  it("parses a 1000-line task well within the keystroke budget", () => {
    const chunk = readFileSync(join(FIXTURES, "ch/Basis/Shell/Shell-Einstieg.md"), "utf8").split("---\n")[1];
    let text = "title: Groß\ntimevalue: 1\ndifficulty: 2\n---\n";
    while (text.split("\n").length < 1000) text += chunk;
    parseProPra(text); // warm up
    const runs = 20;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) parseProPra(text);
    const ms = (performance.now() - t0) / runs;
    console.log(`parse 1000 lines: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(8);
  });
});
