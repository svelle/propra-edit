// Parsing sedrila's console output (pure, tested).
//
// sedrila prints problems through rich as
//   File 'ch/Werkzeuge/Git/git-Branches.md':        <- red = error, yellow = warning
//      [UNBEKANNT::x]                              <- often the offending macro call
//      Macro 'UNBEKANNT' is not defined
// and ends with `==== 51 errors. 26.9 seconds. Exiting. ====`. The exit code is 0 even with
// errors, so the error count comes from that final line.

export interface AnsiSegment {
  text: string;
  /** Foreground color class: "red", "green", ... or null. */
  color: string | null;
  bold: boolean;
}

const COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Split a line with SGR color codes into styled segments (other escapes are dropped). */
export function ansiSegments(line: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let color: string | null = null;
  let bold = false;
  let last = 0;
  const push = (text: string) => {
    text = stripAnsi(text);
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.color === color && prev.bold === bold) prev.text += text;
    else out.push({ text, color, bold });
  };
  for (const m of line.matchAll(ANSI_RE)) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        color = null;
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) color = null;
      else if (c >= 30 && c <= 37) color = COLORS[c - 30];
      else if (c >= 90 && c <= 97) color = COLORS[c - 90];
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4; // 256/true color: skip
    }
  }
  push(line.slice(last));
  return out;
}

export interface BuildProblem {
  /** Path relative to the course root, as printed by sedrila (`/`-separated). */
  file: string;
  severity: "error" | "warning";
  /** Message lines without indentation. */
  lines: string[];
  /** The offending macro call, if the message names one (e.g. `[INCLUDE::x.md]`). */
  macro: string | null;
}

export interface BuildSummary {
  problems: BuildProblem[];
  /** From the final `==== N errors` line; null if sedrila did not get that far. */
  errorCount: number | null;
  seconds: number | null;
}

const HEADER_RE = /^File '(.+)':\s*$/;
const FINAL_RE = /^==== (\d+) errors?\.(?: ([\d.]+) seconds\.)?/;
// noise from running an interactive shell without a terminal
const SHELL_NOISE = [/^\S*sh: cannot set terminal process group/, /^\S*sh: no job control in this shell/];

export function isShellNoise(plain: string): boolean {
  return SHELL_NOISE.some((re) => re.test(plain));
}

export function headerSeverity(line: string): "error" | "warning" {
  const seg = ansiSegments(line).find((s) => s.text.trim());
  return seg?.color === "yellow" ? "warning" : "error";
}

/** Incremental parser: feed raw lines (with ANSI codes), read `summary()` at any time. */
export class BuildOutputParser {
  private problems: BuildProblem[] = [];
  private current: BuildProblem | null = null;
  private errorCount: number | null = null;
  private seconds: number | null = null;

  push(raw: string) {
    const plain = stripAnsi(raw).replace(/\r$/, "");
    const header = HEADER_RE.exec(plain);
    if (header) {
      this.current = { file: header[1], severity: headerSeverity(raw), lines: [], macro: null };
      this.problems.push(this.current);
      return;
    }
    const fin = FINAL_RE.exec(plain);
    if (fin) {
      this.current = null;
      this.errorCount = Number(fin[1]);
      this.seconds = fin[2] ? Number(fin[2]) : null;
      return;
    }
    if (this.current && /^\s+\S/.test(plain)) {
      const text = plain.trim();
      this.current.lines.push(text);
      if (!this.current.macro) {
        const m = /^(\[[A-Z][A-Z0-9_]+(?:::.*?)?\])/.exec(text);
        if (m) this.current.macro = m[1];
      }
      return;
    }
    this.current = null;
  }

  summary(): BuildSummary {
    return { problems: this.problems, errorCount: this.errorCount, seconds: this.seconds };
  }
}

/** The message shown for a problem: all lines except a line that is only the macro call. */
export function problemMessage(p: BuildProblem): string {
  const rest = p.lines.filter((l) => l !== p.macro);
  return (rest.length ? rest : p.lines).join(" ");
}

/**
 * 0-based line of a problem in the file text: the macro call if named, else the first quoted
 * name from the message that occurs in the file (e.g. part 'Nirgends'), else 0.
 */
export function locateProblem(text: string, p: BuildProblem): { line: number; from: number; to: number } | null {
  const at = (needle: string) => {
    const i = text.indexOf(needle);
    return i === -1 ? null : { line: text.slice(0, i).split("\n").length - 1, from: i, to: i + needle.length };
  };
  if (p.macro) {
    const hit = at(p.macro);
    if (hit) return hit;
  }
  for (const m of problemMessage(p).matchAll(/'([^'\n]{2,})'/g)) {
    if (m[1].includes("/") || m[1] === p.file) continue; // file paths are not in the text
    const hit = at(`::${m[1]}]`) ?? at(m[1]);
    if (hit) return hit;
  }
  return null;
}
