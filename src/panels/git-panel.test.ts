import { describe, expect, it } from "vitest";
import type { GitFile } from "../backend";
import { isStaged, isUnstaged, statusLetter } from "./git-panel";

const file = (p: Partial<GitFile>): GitFile => ({ path: "/r/a.md", rel: "a.md", index: ".", worktree: ".", untracked: false, conflict: false, submodule: false, origRel: null, taskPath: null, ...p });

describe("git file classification", () => {
  it("splits staged and unstaged parts of one file", () => {
    const f = file({ index: "M", worktree: "M" });
    expect(isStaged(f) && isUnstaged(f)).toBe(true);
    expect(statusLetter(f, true)).toBe("M");
  });
  it("treats untracked files as unstaged only", () => {
    const f = file({ index: "?", worktree: "?", untracked: true });
    expect(isStaged(f)).toBe(false);
    expect(isUnstaged(f)).toBe(true);
    expect(statusLetter(f, false)).toBe("?");
  });
  it("marks conflicts", () => {
    const f = file({ index: "U", worktree: "U", conflict: true });
    expect(statusLetter(f, true)).toBe("U");
    expect(isUnstaged(f)).toBe(true);
  });
  it("new staged file", () => {
    const f = file({ index: "A" });
    expect(isStaged(f)).toBe(true);
    expect(isUnstaged(f)).toBe(false);
    expect(statusLetter(f, true)).toBe("A");
  });
});
