import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { propraDoc, propraLanguage } from "../editor/propra-language";
import { buildMask, chunksOf, joinSegments, plainText, TEXT, type Chunk } from "./mask";
import { buildBatch, distribute, textRanges, type LtMatch } from "./client";

const FIXTURES = join(__dirname, "../../test-fixtures/course");

function analyze(text: string, topMatter = false) {
  const state = EditorState.create({ doc: text, extensions: propraLanguage({ topMatter, cfg: { blockMacros: [{ name: "INSTRUCTOR", arity: 1 }, { name: "NOTICE", arity: 0 }, { name: "WARNING", arity: 0 }] } }) });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  const doc = state.field(propraDoc);
  const mask = buildMask(text, doc, tree);
  return { doc, mask, chunks: chunksOf(mask, doc) };
}

const plain = (text: string, topMatter = false) =>
  analyze(text, topMatter)
    .chunks.map((c) => plainText(c.segments))
    .join("\n\n");

/** A fake LanguageTool response with one match per prose segment (and a word inside it). */
function fakeMatchesFor(chunks: Chunk[]) {
  const batch = buildBatch(chunks);
  const matches: LtMatch[] = [];
  const expected: string[] = [];
  chunks.forEach((c, i) => {
    const text = joinSegments(c.segments);
    for (const [a, b] of textRanges(c.segments)) {
      const word = /\p{L}+/u.exec(text.slice(a, b));
      if (!word) continue;
      const off = a + word.index;
      matches.push({ offset: batch.bases[i] + off, length: word[0].length, message: "m", replacements: [], rule: { id: "R", description: "d", category: { id: "TYPOS", name: "" } } });
      expected.push(word[0]);
    }
  });
  return { batch, matches, expected };
}

function assertRoundTrip(text: string, topMatter: boolean, label: string) {
  const { chunks, mask } = analyze(text, topMatter);
  expect(mask.owner.length, label).toBe(text.length);
  for (const c of chunks) {
    // segments concatenate to the exact original slice
    expect(joinSegments(c.segments), label).toBe(text.slice(c.from, c.to));
  }
  // every match offset maps back to the exact original characters
  const { batch, matches, expected } = fakeMatchesFor(chunks);
  const got = distribute(chunks, batch, matches);
  const flat = got.flatMap((ms, i) => ms.map((m) => ({ m, c: chunks[i] })));
  expect(flat.map((x) => x.m.word), label).toEqual(expected);
  for (const { m, c } of flat) expect(text.slice(c.from + m.rel, c.from + m.rel + m.len), label).toBe(m.word);
}

describe("masking", () => {
  it("removes enumeration macros and keeps the sentence", () => {
    expect(plain("[EQ] Was gibt `pwd` aus?")).toBe("Was gibt X aus?");
  });

  it("reads TERMREF as the term and TERMREF2 suffixes as appended", () => {
    expect(plain("Die [TERMREF::Shell] ist toll.")).toBe("Die Shell ist toll.");
    expect(plain("Viele [TERMREF2::Branch::-es] und [TERMREF2::JSON::--Objekten].")).toBe("Viele Branches und JSON-Objekten.");
    expect(plain("Die [TERMREF2::Shell::Kommandozeile] hilft.")).toBe("Die Kommandozeile hilft.");
  });

  it("checks prose macro arguments: HINT/FOLDOUT titles, INSTRUCTOR headings, PARTREF2 texts", () => {
    expect(plain("[HINT::Wo steht das?]\nSchauen Sie nach.\n[ENDHINT]")).toBe("Wo steht das?\n\n Schauen Sie nach. \n\n");
    expect(plain("Siehe [PARTREF2::Shell-Einstieg::die erste Aufgabe].")).toBe("Siehe die erste Aufgabe.");
    expect(plain("Siehe [PARTREF::Shell-Einstieg].")).toBe("Siehe Shell-Einstieg.");
  });

  it("masks code, URLs, paths, comments and HTML", () => {
    expect(plain("Text\n\n```bash\nls -la\n```\n\nMehr")).toBe("Text\n\nMehr");
    expect(plain("Lesen Sie [die Doku](https://x.org/a) und https://y.org/b genau.")).toBe("Lesen Sie die Doku und X genau.");
    expect(plain("Öffnen Sie /etc/hosts und ~/.bashrc sowie ch/Basis/index.md, aber und/oder bleibt.")).toBe("Öffnen Sie X und X sowie X, aber und/oder bleibt.");
    expect(plain("Ein <!-- Kommentar --> Satz mit <b>fett</b>.")).toBe("Ein  Satz mit fett.");
    expect(plain("Siehe [HREF::https://x.org].")).toBe("Siehe X.");
  });

  it("separates list items and headings into paragraphs; strips Markdown marks", () => {
    expect(plain("### Kopf\nText *betont* hier.\n- eins\n- zwei")).toBe("Kopf\n\nText betont hier.\n\neins\n\nzwei");
  });

  it("does not check top matter, macros-off regions or block macro lines", () => {
    expect(plain("title: Tippfehlerr\n---\n[SECTION::goal::idea]\nIch lerne.\n[ENDSECTION]\n", true)).toBe("\n\n Ich lerne. \n\n");
    expect(plain("<!-- sedrila: macros off -->\narr[X] = 1\n<!-- sedrila: macros off end -->\nText")).toBe("\n\n Text");
  });

  it("drops trailing whitespace (Markdown hard breaks)", () => {
    expect(plain("Zeile eins.  \nZeile zwei.")).toBe("Zeile eins. Zeile zwei.");
  });

  it("drops matches that only touch markup", () => {
    const { chunks } = analyze("Die [TERMREF::Shelll] ist gut.");
    const batch = buildBatch(chunks);
    const off = "Die [TERMREF::".length;
    const res = distribute(chunks, batch, [{ offset: off, length: 6, message: "", replacements: [], rule: { id: "X", description: "", category: { id: "TYPOS", name: "" } } }]);
    expect(res[0]).toEqual([]);
  });

  it("maps matches of batched chunks back to the right chunk", () => {
    const text = "Erster Absatz mit Fehlerr.\n\nZweiter Absatz mit Fehlerr.";
    const { chunks } = analyze(text);
    expect(chunks).toHaveLength(2);
    const batch = buildBatch(chunks);
    const second = batch.bases[1] + "Zweiter Absatz mit ".length;
    const res = distribute(chunks, batch, [{ offset: second, length: 7, message: "", replacements: [{ value: "Fehler" }], rule: { id: "S", description: "", category: { id: "TYPOS", name: "" } } }]);
    expect(res[0]).toEqual([]);
    expect(res[1][0].word).toBe("Fehlerr");
    expect(chunks[1].from + res[1][0].rel).toBe(text.lastIndexOf("Fehlerr"));
  });

  it("splits chunks at blank lines but not inside fences", () => {
    const { chunks } = analyze("Absatz eins.\n\nAbsatz zwei\nweiter.\n\n```\ncode\n\nnoch code\n```\nNach dem Code.");
    expect(chunks.map((c) => plainText(c.segments))).toEqual(["Absatz eins.", "Absatz zwei weiter.", "\n\n Nach dem Code."]);
  });

  it("round-trips every fixture file exactly", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".md") ? [join(d, f)] : []));
    const files = walk(FIXTURES);
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) assertRoundTrip(readFileSync(f, "utf8"), !f.includes("_include") && !f.includes("altdir"), f);
  });

  it("marks every character exactly once", () => {
    const { mask } = analyze("title: x\n---\n[EQ] Text `c` [TERMREF::a]\n", true);
    for (let i = 0; i < mask.owner.length; i++) expect(mask.owner[i] >= TEXT).toBe(true);
  });
});

const PROPRA = process.env.PROPRA_INF_DIR;
describe.skipIf(!PROPRA || !existsSync(join(PROPRA ?? "", "ch")))("golden: masking propra-inf", () => {
  it("round-trips every task file exactly", () => {
    const chdir = join(PROPRA!, "ch");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".md") && !d.includes(".zip") ? [join(d, f)] : []));
    const files = walk(chdir);
    for (const f of files) assertRoundTrip(readFileSync(f, "utf8"), !f.includes("_include"), f);
  });
});

describe("masking: label macros", () => {
  it("drops line-leading EREF labels with their space", () => {
    expect(plain("- [EREFQ::4] `&&` heißt und.")).toBe("X heißt und.");
    expect(plain("Siehe [EREFQ::2] oben.")).toBe("Siehe X oben.");
  });
});

describe("distribute: noise filters", () => {
  const rule = (id: string) => ({ id, description: "", category: { id: "CASING", name: "" } });
  it("drops UPPERCASE_SENTENCE_START at the start of a chunk", () => {
    const { chunks } = analyze("```\ncode\n```\n\naus diesem Grund.");
    const batch = buildBatch(chunks);
    const at = batch.bases[chunks.length - 1] + joinSegments(chunks[chunks.length - 1].segments).indexOf("aus");
    const res = distribute(chunks, batch, [{ offset: at, length: 3, message: "", replacements: [], rule: rule("UPPERCASE_SENTENCE_START") }]);
    expect(res.flat()).toEqual([]);
  });
  it("drops matches whose prose part is only whitespace", () => {
    const { chunks } = analyze("Siehe [EREFQ::1] [EREFQ::2] oben.");
    const batch = buildBatch(chunks);
    const text = joinSegments(chunks[0].segments);
    const from = text.indexOf("[EREFQ::1]");
    const res = distribute(chunks, batch, [{ offset: from, length: text.indexOf("oben") - 1 - from, message: "", replacements: [], rule: rule("GERMAN_WORD_REPEAT_RULE") }]);
    expect(res.flat()).toEqual([]);
  });
});

describe("masking performance", () => {
  it("masks and chunks a 1000-line task quickly", () => {
    const body = readFileSync(join(FIXTURES, "ch/Basis/Shell/Shell-Pipes.md"), "utf8").replace(/\r\n/g, "\n").split("---\n")[1];
    expect(body?.includes("\n")).toBe(true);
    let text = "title: Groß\n---\n";
    while (text.split("\n").length < 1000) text += body;
    const state = EditorState.create({ doc: text, extensions: propraLanguage({ topMatter: true, cfg: { blockMacros: [{ name: "INSTRUCTOR", arity: 1 }, { name: "NOTICE", arity: 0 }] } }) });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    const doc = state.field(propraDoc);
    chunksOf(buildMask(text, doc, tree), doc);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) chunksOf(buildMask(text, doc, tree), doc);
    const ms = (performance.now() - t0) / 10;
    console.log(`mask+chunk 1000 lines: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(40);
  });
});
