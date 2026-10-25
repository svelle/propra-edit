// The sedrila macro table: names, arities and kinds, as registered by
// sedrila/framework/macroexpanders.py and sedrila/course/glossary.py (sedrila 3.2.0).
// User-defined block macros (uppercase keys of `blockmacro_topmatter`) are added from config.

export type MacroKind = "inline" | "blockstart" | "blockend";

/** Visual family of a block macro, used for colors and tints. */
export type BlockFamily = "section" | "instructor" | "hint" | "notice" | "term" | "other";

export interface MacroDef {
  name: string;
  arity: number;
  kind: MacroKind;
  /** For blockstart/blockend: the family of the block. */
  family?: BlockFamily;
  /** For blockend: the name of the matching start macro (e.g. ENDHINT -> HINT). */
  startName?: string;
}

export interface BlockMacroConfig {
  name: string;
  arity: number;
}

const INLINE: [string, number][] = [
  ["INCLUDE", 1],
  ["SNIPPET", 2],
  ["HREF", 1],
  ["PARTREF", 1],
  ["PARTREF2", 2],
  ["TREEREF", 1],
  ["EC", 0],
  ["EQ", 0],
  ["ER", 0],
  ["EREFC", 1],
  ["EREFQ", 1],
  ["EREFR", 1],
  ["DIFF", 1],
  ["PROT", 1], // a BLOCK-mode macro in sedrila, but a single call with no END
  ["TOC", 0],
  ["TERMREF", 1],
  ["TERMREF2", 2],
  ["TERM0", 1], // glossary only; no ENDTERM0
];

const BUILTIN_BLOCKS: [string, number, BlockFamily][] = [
  ["SECTION", 2, "section"],
  ["INNERSECTION", 2, "section"],
  ["HINT", 1, "hint"],
  ["FOLDOUT", 1, "hint"],
  ["TERM", 1, "term"],
];

export function familyOf(blockName: string): BlockFamily {
  switch (blockName) {
    case "SECTION":
    case "INNERSECTION":
      return "section";
    case "INSTRUCTOR":
      return "instructor";
    case "HINT":
    case "FOLDOUT":
      return "hint";
    case "NOTICE":
    case "WARNING":
      return "notice";
    case "TERM":
      return "term";
    default:
      return "other";
  }
}

/** The fallback used when no course is open: propra-inf's user-defined block macros. */
export const DEFAULT_BLOCK_MACROS: BlockMacroConfig[] = [
  { name: "INSTRUCTOR", arity: 1 },
  { name: "WARNING", arity: 0 },
  { name: "NOTICE", arity: 0 },
];

export function buildMacroTable(userBlocks: BlockMacroConfig[]): Map<string, MacroDef> {
  const table = new Map<string, MacroDef>();
  for (const [name, arity] of INLINE) table.set(name, { name, arity, kind: "inline" });
  const blocks: [string, number][] = [
    ...BUILTIN_BLOCKS.map(([n, a]) => [n, a] as [string, number]),
    ...userBlocks.map((b) => [b.name, b.arity] as [string, number]),
  ];
  for (const [name, arity] of blocks) {
    const family = familyOf(name);
    table.set(name, { name, arity, kind: "blockstart", family });
    table.set("END" + name, { name: "END" + name, arity: 0, kind: "blockend", family, startName: name });
  }
  return table;
}

export const ENUMERATION_NAMES = ["EC", "EQ", "ER"] as const;
export type EnumKind = (typeof ENUMERATION_NAMES)[number];
export const EREF_TO_ENUM: Record<string, EnumKind> = { EREFC: "EC", EREFQ: "EQ", EREFR: "ER" };
