import { beforeEach, describe, expect, it } from "vitest";

// authoring-validation imports `server-only`, which throws outside an RSC
// context; stub it (mirrors lodge-display-layout-render.test).
import { vi } from "vitest";
vi.mock("server-only", () => ({}));

import { MAX_AUTHORED_CSS_CHARS } from "@/lib/lodge-display/css-tokens";

// Imported after the server-only mock is registered so the module does not throw
// at eval time.
let validateLayoutForSave: (typeof import("@/lib/lodge-display/authoring-validation"))["validateLayoutForSave"];
let validateTemplateForSave: (typeof import("@/lib/lodge-display/authoring-validation"))["validateTemplateForSave"];

beforeEach(async () => {
  ({ validateLayoutForSave, validateTemplateForSave } = await import(
    "@/lib/lodge-display/authoring-validation"
  ));
});

// A minimal well-formed Layout: one static area, its placeholder present.
const CLEAN_LAYOUT = {
  bodyHtml: "<h1>Board</h1>{{area:main}}",
  defaultCss: ".display-authored-root .card { color: var(--display-ink); }",
  areas: [{ key: "main", description: "Main", kind: "static" }],
};

describe("validateLayoutForSave (LTV-030 save contract)", () => {
  it("accepts a clean layout with no warnings", () => {
    const result = validateLayoutForSave(CLEAN_LAYOUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it("REFUSES a structurally invalid layout (areas disagree with bodyHtml)", () => {
    // A placeholder with no matching areas entry — the fail-fast validator throws.
    const result = validateLayoutForSave({ ...CLEAN_LAYOUT, areas: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].path).toBe("layout");
      expect(result.errors[0].message).toMatch(/area "main"|no matching/i);
    }
  });

  it("WARNS (but still saves) when defaultCss carries an external url()", () => {
    const result = validateLayoutForSave({
      ...CLEAN_LAYOUT,
      defaultCss: ".x { background: url(https://evil.example/x.png); }",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toEqual({
        path: "defaultCss",
        message: expect.stringContaining("external url()"),
      });
    }
  });

  it("warns on @import, </style breakout, and over-length CSS", () => {
    const atImport = validateLayoutForSave({
      ...CLEAN_LAYOUT,
      defaultCss: '@import url("https://evil.example/a.css"); .x{color:red}',
    });
    expect(atImport.ok).toBe(true);
    if (atImport.ok) {
      expect(atImport.warnings.some((w) => /@import/.test(w.message))).toBe(true);
    }

    const breakout = validateLayoutForSave({
      ...CLEAN_LAYOUT,
      defaultCss: ".x{color:red}</style><script>x()</script>",
    });
    expect(breakout.ok).toBe(true);
    if (breakout.ok) {
      expect(breakout.warnings.some((w) => /<\/style/.test(w.message))).toBe(true);
    }

    const tooLong = validateLayoutForSave({
      ...CLEAN_LAYOUT,
      defaultCss: `.x{color:red}\n${"/* pad */".repeat(MAX_AUTHORED_CSS_CHARS)}`,
    });
    expect(tooLong.ok).toBe(true);
    if (tooLong.ok) {
      expect(tooLong.warnings.some((w) => /truncated/.test(w.message))).toBe(true);
    }
  });

  it("WARNS (but still saves) when bodyHtml carries an external <img> src (issue hoppers99/AlpineClubBookingsNZ#161)", () => {
    const result = validateLayoutForSave({
      ...CLEAN_LAYOUT,
      bodyHtml: `${CLEAN_LAYOUT.bodyHtml}<img src="https://evil.example/beacon.gif" />`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([
        {
          path: "bodyHtml",
          message: expect.stringContaining("external <img> src blocked"),
        },
      ]);
    }
  });

  it("WARNS when an area's defaultContent html carries an external <img> src", () => {
    const result = validateLayoutForSave({
      ...CLEAN_LAYOUT,
      areas: [
        {
          key: "main",
          description: "Main",
          kind: "static",
          defaultContent: {
            html: '<img src="https://evil.example/x.png" />',
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([
        {
          path: "areas.main.defaultContent",
          message: expect.stringContaining("external <img> src blocked"),
        },
      ]);
    }
  });

  it("does NOT warn on a relative, protocol-relative, or data: <img> src", () => {
    // Protocol-relative is already stripped by the CMS default sanitiser
    // (nothing display-specific about it); relative/data: are allowed outright.
    const result = validateLayoutForSave({
      ...CLEAN_LAYOUT,
      bodyHtml:
        `${CLEAN_LAYOUT.bodyHtml}<img src="/branding/lodge.jpg" />` +
        '<img src="data:image/png;base64,aGVsbG8=" />' +
        '<img src="//evil.example/x.png" />',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it("reports BOTH a structural error and a CSS warning together", () => {
    const result = validateLayoutForSave({
      bodyHtml: "{{area:missing}}",
      areas: [],
      defaultCss: ".x { background: url(https://evil.example/x.png); }",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("layout");
      // Warnings ride along even on a refused save so the author sees everything.
      expect(result.warnings.some((w) => w.path === "defaultCss")).toBe(true);
    }
  });
});

const CLEAN_TEMPLATE = {
  layout: { bodyHtml: CLEAN_LAYOUT.bodyHtml, areas: CLEAN_LAYOUT.areas },
  slotContent: { main: { html: "<p>Hello</p>" } },
  cssOverrides: ".display-authored-root .card { color: red; }",
  footerHtml: "<span>Wi-Fi info</span>",
};

describe("validateTemplateForSave (LTV-030 save contract)", () => {
  it("accepts a clean template with no warnings", () => {
    const result = validateTemplateForSave(CLEAN_TEMPLATE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it("REFUSES slotContent naming an unknown slot key", () => {
    const result = validateTemplateForSave({
      ...CLEAN_TEMPLATE,
      slotContent: { nope: { html: "<p>x</p>" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("slotContent");
      expect(result.errors[0].message).toMatch(/unknown slot key/i);
    }
  });

  it("REFUSES a malformed module embed in the footer html", () => {
    const result = validateTemplateForSave({
      ...CLEAN_TEMPLATE,
      footerHtml: "<span>{{module: arrivals-board}}</span>",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("footerHtml");
      expect(result.errors[0].message).toMatch(/malformed module embed/i);
    }
  });

  it("attributes a broken bound layout to the layout path", () => {
    const result = validateTemplateForSave({
      ...CLEAN_TEMPLATE,
      layout: { bodyHtml: "{{area:main}}", areas: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("layout");
    }
  });

  it("WARNS (but still saves) when cssOverrides carries an external url()", () => {
    const result = validateTemplateForSave({
      ...CLEAN_TEMPLATE,
      cssOverrides: ".x { background: url(//evil.example/x.png); }",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([
        { path: "cssOverrides", message: expect.stringContaining("external url()") },
      ]);
    }
  });
});
