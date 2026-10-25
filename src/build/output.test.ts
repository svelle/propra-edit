import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ansiSegments, BuildOutputParser, isShellNoise, locateProblem, problemMessage, stripAnsi } from "./output";

const sample = readFileSync(new URL("../../test-fixtures/sedrila-output.txt", import.meta.url), "utf8").split("\n");

function parse(lines: string[]) {
  const p = new BuildOutputParser();
  for (const l of lines) p.push(l);
  return p.summary();
}

describe("ansiSegments", () => {
  it("splits colors and bold", () => {
    expect(ansiSegments("\x1b[31mFile \x1b[0m\x1b[1;31m[\x1b[0mx")).toEqual([
      { text: "File ", color: "red", bold: false },
      { text: "[", color: "red", bold: true },
      { text: "x", color: null, bold: false },
    ]);
  });
  it("merges equal neighbours and drops other escapes", () => {
    expect(ansiSegments("\x1b[32ma\x1b[0m\x1b[32mb\x1b[K")).toEqual([{ text: "ab", color: "green", bold: false }]);
    expect(stripAnsi("\x1b[1;33mWarn\x1b[0m")).toBe("Warn");
  });
});

describe("BuildOutputParser on real sedrila output", () => {
  const s = parse(sample);

  it("reads the final error count", () => {
    expect(s.errorCount).toBe(51);
    expect(s.seconds).toBe(26.9);
  });

  it("collects File blocks with severity and macro", () => {
    expect(s.problems.map((p) => [p.file, p.severity, p.macro])).toEqual([
      ["ch/Werkzeuge/Git/git-Branches.md", "error", "[INCLUDE::gibtsnicht.md]"],
      ["ch/Werkzeuge/Git/git-Branches.md", "error", "[UNBEKANNT::x]"],
      ["ch/Werkzeuge/Git/git-Branches.md", "error", null],
      ["ch/Basis/Repo/Kommandoprotokolle.md", "warning", "[PROT::ALT:Kommandoprotokolle.prot]"],
      ["ch/Werkzeuge/Git/git-Repository.md", "error", "[TERMREF::Submodules]"],
    ]);
    expect(problemMessage(s.problems[1])).toBe("Macro 'UNBEKANNT' is not defined");
    expect(problemMessage(s.problems[2])).toBe("part 'Nirgends' does not exist");
  });

  it("does not attach unrelated lines to a block", () => {
    expect(s.problems[4].lines).toHaveLength(1);
    expect(isShellNoise("bash: no job control in this shell")).toBe(true);
  });

  it("has no error count while the build is still running", () => {
    expect(parse(sample.slice(0, 6)).errorCount).toBeNull();
  });
});

describe("locateProblem", () => {
  const text = "title: x\n---\nEins\nDas ist [UNBEKANNT::x] und [INCLUDE::gibtsnicht.md]\nSiehe [PARTREF::Nirgends].\n";
  const s = parse(sample);

  it("finds the macro call", () => {
    expect(locateProblem(text, s.problems[0])).toMatchObject({ line: 3 });
    expect(locateProblem(text, s.problems[1])).toEqual({ line: 3, from: text.indexOf("[UNBEKANNT"), to: text.indexOf(" und") });
  });

  it("falls back to a quoted name from the message", () => {
    expect(locateProblem(text, s.problems[2])).toMatchObject({ line: 4, from: text.indexOf("::Nirgends]") });
  });

  it("returns null when nothing matches", () => {
    expect(locateProblem("leer", s.problems[0])).toBeNull();
  });
});
