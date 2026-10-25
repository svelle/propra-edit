import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_MACROS } from "./macros";
import { parseProPra } from "./parser";
import { headerAt, headerLabel } from "./section-header";

const text = [
  "title: x", // 0
  "---", // 1
  "[SECTION::instructions::detailed]", // 2
  "Text", // 3
  "### Git initialisieren", // 4
  "```", // 5
  "# kein Kopf", // 6
  "```", // 7
  "mehr", // 8
  "[ENDSECTION]", // 9
  "[INSTRUCTOR::Lösungen]", // 10
  "Prüfen", // 11
  "[ENDINSTRUCTOR]", // 12
].join("\n");
const doc = parseProPra(text, { blockMacros: DEFAULT_BLOCK_MACROS }, { topMatter: true });

describe("section header", () => {
  it("names section and last heading, ignoring code", () => {
    const h = headerAt(doc, 8)!;
    expect(h).toMatchObject({ section: "instructions", line: 2, heading: "Git initialisieren", block: null });
    expect(headerLabel(h)).toBe("Arbeitsschritte  ·  Git initialisieren");
    expect(headerAt(doc, 3)).toMatchObject({ heading: null });
  });
  it("shows blocks outside sections", () => {
    expect(headerLabel(headerAt(doc, 11)!)).toBe("INSTRUCTOR: Lösungen");
  });
  it("is empty in the top matter", () => {
    expect(headerAt(doc, 0)).toBeNull();
  });
});
