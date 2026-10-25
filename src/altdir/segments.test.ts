import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyChanges, contentEnd, pairSegments, renumberChanges, segmentAltdir, solutionInsertion } from "./segments";

const ALT = join(__dirname, "../../test-fixtures/course/altdir/ch");
const read = (rel: string) => readFileSync(join(ALT, rel), "utf8").replace(/\r\n/g, "\n");

const summary = (text: string) =>
  segmentAltdir(text).segments.map((s) => `${s.kind === "solution" ? s.key : s.kind}: ${JSON.stringify(text.slice(s.from, contentEnd(text, s)).split("\n")[0])}`);

describe("altdir segmentation", () => {
  it("splits list-item solutions with unindented continuation lines", () => {
    const t = read("Basis/Shell/Shell-Einstieg.md");
    const seg = segmentAltdir(t);
    expect(seg.segments.map((s) => s.key)).toEqual(["EQ 1", "EQ 2", "EQ 3"]);
    const q2 = seg.segments[1];
    expect(t.slice(q2.from, q2.to)).toBe("- [EREFQ::2] **Knackpunkt:** `-a` zeigt auch versteckte Dateien an\n(solche, deren Name mit einem Punkt beginnt).\n");
    // segments cover the file without gaps
    expect(seg.segments[0].from).toBe(0);
    expect(seg.segments[seg.segments.length - 1].to).toBe(t.length);
    for (let i = 1; i < seg.segments.length; i++) expect(seg.segments[i].from).toBe(seg.segments[i - 1].to);
  });

  it("handles numbered lists, headings that end a segment, and plain markers", () => {
    expect(summary(read("Basis/Shell/Shell-Pipes.md"))).toEqual([
      'preamble: "### Fragen"',
      'EQ 1: "1. [EREFQ::1] Weil die Fehlermeldung auf `stderr` (Filedeskriptor 2) geschrieben wird,"',
      'EQ 2: "2. [EREFQ::2] [EREFC::2] lenkt `stderr` in die Datei `/tmp/err` um."',
      'other: "### Kommandos"',
      'EC 1: "[EREFC::1] und [EREFC::2] müssen im Protokoll vorkommen."',
    ]);
  });

  it("handles heading markers, a preamble and orphans", () => {
    const t = read("Basis/Git/Git-Einstieg.md");
    expect(summary(t)).toEqual(['preamble: "Lösungshinweise für das erste Repository."', 'EQ 1: "#### [EREFQ::1]"', 'EQ 2: "#### [EREFQ::2]"', 'EQ 5: "#### [EREFQ::5]"']);
    const pairing = pairSegments(segmentAltdir(t), new Set(["EC 1", "EC 2", "EQ 1", "EQ 2", "EQ 3"]));
    expect([...pairing.byKey.keys()]).toEqual(["EQ 1", "EQ 2"]);
    expect(pairing.orphans.map((s) => s.key)).toEqual(["EQ 5"]);
  });

  it("reports files without markers (whole-file fallback)", () => {
    const seg = segmentAltdir(read("Sprachen/Python/py-Einstieg.md"));
    expect(seg.hasMarkers).toBe(false);
    expect(seg.segments.map((s) => s.kind)).toEqual(["preamble"]);
  });

  it("ignores markers and headings inside fenced code", () => {
    const t = "- [EREFQ::1] So:\n```python\n# Kommentar\n[EREFQ::9]\n```\nfertig\n- [EREFQ::2] b\n";
    expect(segmentAltdir(t).segments.map((s) => s.key)).toEqual(["EQ 1", "EQ 2"]);
  });

  it("a heading of higher level ends a heading-style segment, a lower one does not", () => {
    const t = "### [EREFQ::1]\nText\n#### Detail\nmehr\n## Teil 2\nAnderes\n";
    expect(summary(t)).toEqual(['EQ 1: "### [EREFQ::1]"', 'other: "## Teil 2"']);
  });
});

describe("adding a solution", () => {
  const add = (t: string, kind: "EC" | "EQ" | "ER", n: number) => {
    const ins = solutionInsertion(t, segmentAltdir(t), kind, n);
    return { out: t.slice(0, ins.from) + ins.insert + t.slice(ins.from), ins };
  };

  it("inserts in number order, in the style of the neighbours", () => {
    const t = "- [EREFQ::1] a\n\n- [EREFQ::3] c\n";
    const { out, ins } = add(t, "EQ", 2);
    expect(out).toBe("- [EREFQ::1] a\n- [EREFQ::2] \n\n- [EREFQ::3] c\n");
    expect(out.slice(0, ins.cursor).endsWith("- [EREFQ::2] ")).toBe(true);
    expect(add(t, "EQ", 4).out).toBe("- [EREFQ::1] a\n\n- [EREFQ::3] c\n- [EREFQ::4] \n");
    expect(add(t, "EC", 1).out).toBe("- [EREFQ::1] a\n\n- [EREFQ::3] c\n- [EREFC::1] \n");
  });

  it("uses heading style and handles empty files and preambles", () => {
    expect(add(read("Basis/Git/Git-Einstieg.md"), "EQ", 3).out).toContain("Den ersten Commit mit Autor, Datum und Commit-Nachricht.\n#### [EREFQ::3]\n\n\n#### [EREFQ::5]");
    expect(add("", "EQ", 1).out).toBe("- [EREFQ::1] \n");
    expect(add("Vorspann ohne Zeilenende", "EQ", 1).out).toBe("Vorspann ohne Zeilenende\n\n- [EREFQ::1] \n");
  });
});

describe("renumbering", () => {
  it("rewrites EREF numbers simultaneously and per kind", () => {
    const t = "- [EREFQ::2] b\n- [EREFQ::3] c, siehe [EREFQ::2] und [EREFC::2]\n<!-- sedrila: macros off -->\n[EREFQ::2]\n<!-- sedrila: macros off end -->\n";
    const mapping = { EQ: new Map([[2, 3], [3, 4]]) };
    expect(applyChanges(t, renumberChanges(t, mapping))).toBe("- [EREFQ::3] b\n- [EREFQ::4] c, siehe [EREFQ::3] und [EREFC::2]\n<!-- sedrila: macros off -->\n[EREFQ::2]\n<!-- sedrila: macros off end -->\n");
  });

  it("leaves top matter alone in task files", () => {
    const t = "title: [EREFQ::1]\n---\n[EREFQ::1]\n";
    expect(applyChanges(t, renumberChanges(t, { EQ: new Map([[1, 2]]) }, undefined, true))).toBe("title: [EREFQ::1]\n---\n[EREFQ::2]\n");
  });
});
