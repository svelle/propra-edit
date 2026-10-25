import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("fuzzy", () => {
  it("matches subsequences case-insensitively, umlauts included", () => {
    expect(fuzzyScore("shpi", "Shell-Pipes")).not.toBeNull();
    expect(fuzzyScore("ÜBER", "übersetzer")).not.toBeNull();
    expect(fuzzyScore("xyz", "Shell-Pipes")).toBeNull();
  });

  it("ranks tight matches first", () => {
    const items = ["Git-Merge Branches zusammenführen", "Git-Branches Arbeiten mit Branches"];
    expect(fuzzyFilter("gitbr", items, (s) => s)[0]).toBe(items[1]);
    expect(fuzzyFilter("pipes", ["py-Pipeline-Extras", "Shell-Pipes"], (s) => s)[0]).toBe("Shell-Pipes");
  });
});
