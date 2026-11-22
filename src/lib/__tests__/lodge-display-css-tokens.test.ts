import { describe, expect, it } from "vitest";
import {
  DISPLAY_AUTHORED_ROOT_SELECTOR,
  MAX_AUTHORED_CSS_CHARS,
  listDisplayCssTokens,
  sanitiseDisplayCss,
  scopeDisplayCss,
} from "@/lib/lodge-display/css-tokens";

// LTV-029 (hoppers99/AlpineClubBookingsNZ#75): authored-CSS hardening for the unattended lobby wall. This is
// a client-safe, pure module — no server-only mock needed. The sanitiser
// neutralises the exfiltration/injection vectors ADR-003 names; the scoper
// prefixes every selector so a template can never restyle the page chrome.

describe("sanitiseDisplayCss — url() exfiltration vector", () => {
  it("blocks an external http(s) url() with a removed-marker comment", () => {
    for (const target of [
      "http://evil.example/steal.png",
      "https://evil.example/steal.png",
      "HTTPS://EVIL.EXAMPLE/x.png",
    ]) {
      const out = sanitiseDisplayCss(`.a{background:url(${target})}`);
      expect(out).toContain("/* blocked: external url */");
      expect(out).not.toContain("evil.example");
    }
  });

  it("blocks a protocol-relative //host url()", () => {
    const out = sanitiseDisplayCss(".a{background:url(//evil.example/x.png)}");
    expect(out).toContain("/* blocked: external url */");
    expect(out).not.toContain("evil.example");
  });

  it("blocks a non-http scheme (javascript:/file:) url()", () => {
    const out = sanitiseDisplayCss(".a{background:url(javascript:alert(1))}");
    expect(out).toContain("/* blocked: external url */");
    expect(out).not.toContain("javascript:");
  });

  it("keeps a relative or root-absolute url() untouched", () => {
    const relative = ".a{background:url(./local.png)}";
    expect(sanitiseDisplayCss(relative)).toBe(relative);
    const absolute = ".a{background:url(/assets/logo.svg)}";
    expect(sanitiseDisplayCss(absolute)).toBe(absolute);
    const quoted = '.a{background:url("images/bg.jpg")}';
    expect(sanitiseDisplayCss(quoted)).toBe(quoted);
  });

  it("keeps a self-contained data: url() untouched", () => {
    const data =
      ".a{background:url(data:image/png;base64,iVBORw0KGgoAAAAN)}";
    expect(sanitiseDisplayCss(data)).toBe(data);
  });
});

describe("sanitiseDisplayCss — at-rule + breakout vectors", () => {
  it("strips @import statements", () => {
    const out = sanitiseDisplayCss('@import url(https://evil.example/x.css);\n.a{color:red}');
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toContain("evil.example");
    expect(out).toContain(".a");
  });

  it("strips @charset statements", () => {
    const out = sanitiseDisplayCss('@charset "utf-8";\n.a{color:red}');
    expect(out).not.toMatch(/@charset/i);
    expect(out).toContain(".a");
  });

  it("strips the </style breakout token", () => {
    const out = sanitiseDisplayCss("a{color:red}</style><script>evil()</script>");
    expect(out).not.toMatch(/<\/style/i);
    expect(out).not.toContain("<script");
  });

  it("removes any stray < character", () => {
    const out = sanitiseDisplayCss('.a::before{content:"<b>"}');
    expect(out).not.toContain("<");
  });
});

describe("sanitiseDisplayCss — legacy script-in-CSS vectors", () => {
  it("neutralises expression(...)", () => {
    const out = sanitiseDisplayCss(".a{width:expression(alert(1))}");
    expect(out).not.toMatch(/expression\s*\(/i);
    // Parens stay balanced (the inner call survives as an inert token).
    expect(out).toContain("(alert(1))");
  });

  it("neutralises -moz-binding", () => {
    const out = sanitiseDisplayCss(".a{-moz-binding:url(/xbl.xml#e)}");
    expect(out).not.toMatch(/-moz-binding/i);
  });
});

describe("sanitiseDisplayCss — cap + passthrough", () => {
  it("truncates over-cap input with a trailing marker", () => {
    const huge = `.a{color:red}${"/*x*/".repeat(MAX_AUTHORED_CSS_CHARS)}`;
    const out = sanitiseDisplayCss(huge);
    expect(out.length).toBeLessThanOrEqual(MAX_AUTHORED_CSS_CHARS + "\n/* truncated */".length);
    expect(out.endsWith("/* truncated */")).toBe(true);
  });

  it("passes benign CSS through byte-identical", () => {
    const benign =
      ".display-layout-body{gap:1rem;color:var(--display-ink)}\n" +
      "@media (min-width:100px){.a{color:var(--brand-gold)}}";
    expect(sanitiseDisplayCss(benign)).toBe(benign);
  });

  it("returns empty string for a non-string input", () => {
    // Defensive — stored JSON could be malformed.
    expect(sanitiseDisplayCss(undefined as unknown as string)).toBe("");
  });
});

describe("scopeDisplayCss — selector prefixing", () => {
  const S = DISPLAY_AUTHORED_ROOT_SELECTOR;

  it("prefixes a single selector", () => {
    expect(scopeDisplayCss(".a{color:red}")).toBe(`${S} .a {color:red}`);
  });

  it("prefixes every selector in a selector list", () => {
    const out = scopeDisplayCss(".a, .b .c{color:red}");
    expect(out).toBe(`${S} .a, ${S} .b .c {color:red}`);
  });

  it("does not split a comma nested inside :is()/:not()", () => {
    const out = scopeDisplayCss(":is(.a, .b){color:red}");
    expect(out).toBe(`${S} :is(.a, .b) {color:red}`);
  });

  it("prefixes the inner selectors of an @media block, keeping the prelude", () => {
    const out = scopeDisplayCss("@media (min-width:100px){.a{color:red}}");
    expect(out).toBe(`@media (min-width:100px){${S} .a {color:red}}`);
  });

  it("leaves @keyframes untouched (global names, no inner selectors to scope)", () => {
    const kf = "@keyframes spin{from{opacity:0}to{opacity:1}}";
    expect(scopeDisplayCss(kf)).toBe(kf);
  });

  it("strips other at-rules such as @font-face", () => {
    const out = scopeDisplayCss("@font-face{font-family:x;src:url(/f.woff2)}.a{color:red}");
    expect(out).not.toMatch(/@font-face/i);
    expect(out).toContain(`${S} .a {color:red}`);
  });

  it("neutralises a chrome-targeting selector into a non-matching descendant", () => {
    // `.display-header-clock` targets the fixed chrome; after scoping it becomes
    // a descendant of the authored root, which the chrome is never inside.
    const out = scopeDisplayCss(".display-header-clock{display:none}");
    expect(out).toBe(`${S} .display-header-clock {display:none}`);
  });

  it("returns empty string for blank input", () => {
    expect(scopeDisplayCss("   ")).toBe("");
  });
});

describe("listDisplayCssTokens", () => {
  it("exposes the display palette and the club-theme brand tokens", () => {
    const tokens = listDisplayCssTokens();
    const names = tokens.map((t) => t.name);
    // Display palette.
    expect(names).toContain("--display-accent");
    expect(names).toContain("--display-ink");
    // Club-theme brand colours + fonts (the "match the website" set).
    expect(names).toContain("--brand-gold");
    expect(names).toContain("--brand-charcoal");
    expect(names).toContain("--font-website-heading");
    // Every token carries a human description and a family.
    for (const token of tokens) {
      expect(token.description.length).toBeGreaterThan(0);
      expect(["display", "brand"]).toContain(token.family);
    }
  });
});
