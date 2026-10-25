import { describe, expect, it } from "vitest";
import { scopeCss } from "./preview";

describe("scopeCss", () => {
  it("maps page-level selectors to the preview root", () => {
    expect(scopeCss(":root {\n  --x: 1;\n}\nhtml { a: b }\nbody, p { c: d }\n@media (x) {\n    body,\n    main { e: f }\n}")).toBe(
      ".pv-root {\n  --x: 1;\n}\n.pv-root { a: b }\n.pv-root, p { c: d }\n@media (x) {\n    .pv-root,\n    main { e: f }\n}",
    );
  });
  it("leaves other selectors alone", () => {
    expect(scopeCss(".body-text { } #htmlish { } tbody { }")).toBe(".body-text { } #htmlish { } tbody { }");
  });
});
