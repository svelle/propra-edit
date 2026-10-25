import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_MACROS } from "../editor/macros";
import { extractSnippet, includeKeyOf, protHtml, renderDocument, type IncludeContent, type RenderContext } from "./render";
import { parseProPra } from "../editor/parser";

const templates: Record<string, string> = {
  section_goal: "<h2>Ziel</h2>",
  section_goal_idea: "Idea",
  section_instructions: "<h2>Arbeitsschritte</h2>",
  section_instructions_detailed: "Detailed",
  hint: "<strong>Hinweis (nur bei Bedarf):</strong> {arg1}",
  INSTRUCTOR: "<h2>Kontrolle Tutor_in: {arg1}</h2>",
  NOTICE: "<strong>Bemerkung:</strong>",
};

function ctx(includes: Record<string, IncludeContent> = {}, topMatter = true): RenderContext {
  return { cfg: { blockMacros: DEFAULT_BLOCK_MACROS }, templates, topMatter, includes: new Map(Object.entries(includes)) };
}

const render = (text: string, c = ctx()) => renderDocument(text, c).html;

describe("renderDocument", () => {
  it("reads the top matter and renders sections like sedrila", () => {
    const r = renderDocument('title: "Hallo Welt"\ndifficulty: 2\n---\n[SECTION::goal::idea]\nText\n[ENDSECTION]\n', ctx());
    expect(r.topMatter).toEqual({ title: "Hallo Welt", difficulty: "2" });
    expect(r.html).toContain("<section data-line=\"3\" class='section section-goal'>");
    expect(r.html).toContain("<div class='section-subtype section-goal-idea'>Idea</div>");
    expect(r.html).toContain("<h2>Ziel</h2><p data-line=\"3\">\nText\n</p></section>");
  });

  it("drops <p> around block macros on their own paragraph", () => {
    const html = render("x\n---\n[SECTION::goal::idea]\n\nText\n\n[ENDSECTION]\n");
    expect(html).not.toMatch(/<p[^>]*><section/);
    expect(html).not.toMatch(/<\/section><\/p>/);
    expect(html).toMatch(/<p data-line="4">Text<\/p>\n<\/section>/);
  });

  it("numbers enumerations per kind in order", () => {
    const html = render("x\n---\n[EC] a\n\n[EQ] b\n\n[EC] c\n\n[EREFC::1]\n");
    expect(html.match(/enumeration-ec'>\d/g)).toEqual(["enumeration-ec'>1", "enumeration-ec'>2"]);
    expect(html).toContain("<span class='enumeration-eq'>1</span>");
    expect(html).toContain("<span class='enumeration-erefc'>1</span>");
  });

  it("renders hints, foldouts and user block macros with their templates", () => {
    const html = render("x\n---\n[HINT::Wie geht das?]\nSo.\n[ENDHINT]\n\n[INSTRUCTOR::Lösung]\nA\n[ENDINSTRUCTOR]\n[FOLDOUT::Mehr]\nB\n[ENDFOLDOUT]\n");
    expect(html).toContain("<details data-line=\"2\" class='blockmacro blockmacro-hint'><summary>\n<strong>Hinweis (nur bei Bedarf):</strong> Wie geht das?\n</summary>");
    expect(html).toContain("<div data-line=\"6\" class='blockmacro blockmacro-instructor'>\n<h2>Kontrolle Tutor_in: Lösung</h2>");
    expect(html).toContain("blockmacro-foldout'><summary>\nMehr\n</summary>");
    expect((html.match(/<details/g) ?? []).length).toBe((html.match(/<\/details>/g) ?? []).length);
  });

  it("links parts and terms with data attributes", () => {
    const html = render("x\n---\nSiehe [PARTREF::Git-Einstieg], [PARTREF2::Git-Merge::hier] und [TERMREF2::Commit::-s].\n");
    expect(html).toContain("data-part='Git-Einstieg'>Git-Einstieg</a>");
    expect(html).toContain("data-part='Git-Merge'>hier</a>");
    expect(html).toContain("data-term='Commit'>Commits<span");
  });

  it("inlines includes before Markdown and expands their macros", () => {
    const c = ctx({ "INCLUDE|inc.md|": { text: "**fett** [EQ]\n", path: "/c/inc.md" } });
    const html = render("x\n---\n[EQ] a\n\n[INCLUDE::inc.md]\n", c);
    expect(html).toContain("<strong>fett</strong> <span class='enumeration-eq'>2</span>");
  });

  it("inserts snippets and reports missing files", () => {
    const file = "vorher\n[SNIPPET::Teil]\n```\ncode\n```\n[ENDSNIPPET]\nnachher\n";
    expect(extractSnippet(file, "Teil")).toBe("```\ncode\n```");
    const c = ctx({ "SNIPPET|ALT|Teil": { text: file, path: "/a.md" }, "INCLUDE|weg.md|": { text: null, path: "/c/weg.md" } });
    const html = render("x\n---\n[SNIPPET::ALT::Teil]\n\n[INCLUDE::weg.md]\n", c);
    expect(html).toContain("<pre><code data-line=\"2\">code\n</code></pre>");
    expect(html).toContain("((INCLUDE ‘/c/weg.md’ not found))");
  });

  it("keys includes like the call", () => {
    const call = parseProPra("[SNIPPET::ALT::x]", { blockMacros: [] }, { topMatter: false }).macros[0];
    expect(includeKeyOf(call)).toBe("SNIPPET|ALT|x");
  });

  it("marks block-level elements with their source line", () => {
    const html = render("t\n---\n# Kopf\n\nAbsatz\n\n- a\n- b\n");
    expect(html).toContain('<h1 data-line="2">Kopf</h1>');
    expect(html).toContain('<p data-line="4">Absatz</p>');
    expect(html).toContain('<ul data-line="6">');
  });

  it("renders mermaid fences for lazy rendering", () => {
    expect(render("t\n---\n```mermaid\ngraph TD; A-->B\n```\n")).toContain('<pre class="mermaid" data-line="2">graph TD; A--&gt;B\n</pre>');
  });

  it("builds a table of contents for [TOC]", () => {
    const html = render("t\n---\n[TOC]\n\n## Eins\n\n### Zwei\n");
    expect(html).toContain("<div class='toc'><ul><li class='toc-level2'>Eins</li><li class='toc-level3'>Zwei</li></ul></div>");
  });

  it("leaves macros in macros-off regions alone", () => {
    const html = render("t\n---\n<!-- sedrila: macros off -->\n[EQ]\n<!-- sedrila: macros off end -->\n");
    expect(html).toContain("[EQ]");
  });

  it("renders the fixture task without unbalanced blocks", () => {
    const text = readFileSync(new URL("../../test-fixtures/course/ch/Basis/Git/Git-Einstieg.md", import.meta.url), "utf8");
    const html = render(text);
    expect((html.match(/<section/g) ?? []).length).toBe(3);
    expect((html.match(/<\/section>/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
  });
});

describe("protHtml", () => {
  it("splits prompts, commands and output", () => {
    const html = protHtml("user@host /tmp 12:00:01 1\n$ ls\na.txt\n");
    expect(html).toContain("<span class='vwr-userhost'>user@host</span>");
    expect(html).toContain("<span class='vwr-cmd'>$ ls</span>");
    expect(html).toContain("<span class='vwr-output'>a.txt</span>");
  });
});

describe("sedrila preprocessing", () => {
  it("keeps replacement content and drops LINK_SPEC comments", () => {
    const html = renderDocument('t\n---\nText\n<!-- @LINK_SPEC: x -->\nweiter\n\n<replacement id="r1">\n- a\n- b\n</replacement>\n\nEnde\n', ctx()).html;
    expect(html).toContain('<p data-line="2">Text\nweiter</p>');
    expect(html).toContain('<ul data-line="7">');
    expect(html).toContain('<p data-line="11">Ende</p>');
    expect(html).not.toContain("replacement");
  });
});
