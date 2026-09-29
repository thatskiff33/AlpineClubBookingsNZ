import { describe, expect, it } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";
import {
  resolveDisplayHtml,
  resolveDisplayText,
} from "@/lib/lodge-display/display-text";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

// LTV-028: the HTML value-token resolver (resolveDisplayHtml) shares one closed
// grammar with the existing text resolver (resolveDisplayText) but HTML-escapes
// each injected value, and — crucially — leaves any non-display token verbatim
// so a wall can never surface a site-catalogue token (ADR-003 §4).

function state(overrides: Partial<DisplayState> = {}): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [],
    chores: [],
    rules: null,
    notice: null,
    config: { "wifi-code": "alpine1234" },
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  } as DisplayState;
}

describe("resolveDisplayHtml — value tokens inside authored html", () => {
  it("resolves config/lodge-name/display-date the same as the text variant", () => {
    const s = state();
    expect(resolveDisplayHtml("<p>Wi-Fi {{config:wifi-code}}</p>", s, CLUB_FORMAT_TEST)).toBe(
      "<p>Wi-Fi alpine1234</p>"
    );
    expect(resolveDisplayHtml("<h1>{{lodge-name}}</h1>", s, CLUB_FORMAT_TEST)).toBe(
      "<h1>Silverpeak Lodge</h1>"
    );
    expect(resolveDisplayHtml("<time>{{display-date}}</time>", s, CLUB_FORMAT_TEST)).toMatch(
      /Monday.*13.*April/
    );
  });

  it("HTML-escapes an injected config value so it can never inject markup", () => {
    const s = state({ config: { note: "<img src=x onerror=alert(1)>" } });
    const html = resolveDisplayHtml("<p>{{config:note}}</p>", s, CLUB_FORMAT_TEST);
    // The value is rendered as escaped text, not a live element.
    expect(html).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(html).not.toContain("<img");
  });

  it("escapes a <script> config value to inert text", () => {
    const s = state({ config: { note: "<script>steal()</script>" } });
    expect(resolveDisplayHtml("{{config:note}}", s, CLUB_FORMAT_TEST)).toBe(
      "&lt;script&gt;steal()&lt;/script&gt;"
    );
  });

  it("neutralises braces in a value so it cannot form a second token", () => {
    // A config value that itself looks like a token must stay inert text — its
    // braces are escaped so no later splitter (config/area/module) acts on it.
    const s = state({ config: { note: "{{module:chores-board}}" } });
    const html = resolveDisplayHtml("<p>{{config:note}}</p>", s, CLUB_FORMAT_TEST);
    expect(html).toBe("<p>&#123;&#123;module:chores-board&#125;&#125;</p>");
    expect(html).not.toContain("{{module:");
  });

  it("keeps the VISIBLE unset marker for an unknown config key", () => {
    expect(resolveDisplayHtml("<p>{{config:door-pin}}</p>", state(), CLUB_FORMAT_TEST)).toBe(
      "<p>⟨config:door-pin?⟩</p>"
    );
  });

  it("leaves a site-catalogue token VERBATIM (token-scope boundary, ADR-003 §4)", () => {
    // {{club-name}} is a real site-catalogue token (src/lib/token-catalogue.ts)
    // and the club name IS in the payload — but it is NOT in the display token
    // set, so it must pass through unresolved rather than surface site data.
    const s = state();
    expect(resolveDisplayHtml("<p>{{club-name}}</p>", s, CLUB_FORMAT_TEST)).toBe("<p>{{club-name}}</p>");
    expect(resolveDisplayHtml("<p>{{lodge-capacity}}</p>", s, CLUB_FORMAT_TEST)).toBe(
      "<p>{{lodge-capacity}}</p>"
    );
    expect(resolveDisplayHtml("<p>{{facebook-url}}</p>", s, CLUB_FORMAT_TEST)).toBe(
      "<p>{{facebook-url}}</p>"
    );
  });

  it("leaves a {{module:…}} embed token untouched for the client splitter", () => {
    const s = state();
    expect(resolveDisplayHtml("<div>{{module:arrivals-board}}</div>", s, CLUB_FORMAT_TEST)).toBe(
      "<div>{{module:arrivals-board}}</div>"
    );
  });
});

// Issue #176: value resolution runs AFTER the CMS sanitiser, so a config value
// that OPENS a URL attribute brings its own scheme past the sanitiser's scheme
// allowlist. The scheme guard neutralises anything but http/https/mailto/tel and
// relative/anchor references — but ONLY when the resolved value determines the
// scheme (token at the start of an href/src), never for ordinary copy.
describe("resolveDisplayHtml — URL-scheme guard for resolved tokens (issue #176)", () => {
  it("neutralises a javascript: config value resolved at the start of an href", () => {
    const s = state({ config: { link: "javascript:alert(1)" } });
    const html = resolveDisplayHtml('<a href="{{config:link}}">x</a>', s, CLUB_FORMAT_TEST);
    expect(html).toBe('<a href="#">x</a>');
    expect(html).not.toContain("javascript:");
  });

  it("neutralises a data:text/html config value resolved into an href", () => {
    const s = state({ config: { link: "data:text/html,<script>alert(1)</script>" } });
    const html = resolveDisplayHtml('<a href="{{config:link}}">x</a>', s, CLUB_FORMAT_TEST);
    expect(html).toContain('href="#"');
    expect(html).not.toContain("data:");
  });

  it("neutralises a data: value resolved into an <img> src too", () => {
    const s = state({ config: { logo: "data:text/html,evil" } });
    const html = resolveDisplayHtml('<img src="{{config:logo}}" />', s, CLUB_FORMAT_TEST);
    expect(html).toContain('src="#"');
    expect(html).not.toContain("data:");
  });

  it("preserves benign http/https/mailto/tel and relative/anchor href values", () => {
    const href = (link: string) =>
      resolveDisplayHtml('<a href="{{config:link}}">x</a>', state({ config: { link } }), CLUB_FORMAT_TEST);
    expect(href("https://example.org/page")).toBe('<a href="https://example.org/page">x</a>');
    expect(href("http://example.org")).toBe('<a href="http://example.org">x</a>');
    expect(href("mailto:hut@club.nz")).toBe('<a href="mailto:hut@club.nz">x</a>');
    expect(href("tel:+64211234567")).toBe('<a href="tel:+64211234567">x</a>');
    expect(href("/lodge/info")).toBe('<a href="/lodge/info">x</a>');
    expect(href("#section")).toBe('<a href="#section">x</a>');
  });

  it("neutralises a protocol-relative //host value in an href", () => {
    const s = state({ config: { link: "//evil.example/x" } });
    expect(resolveDisplayHtml('<a href="{{config:link}}">x</a>', s, CLUB_FORMAT_TEST)).toBe(
      '<a href="#">x</a>'
    );
  });

  it("neutralises a scheme smuggled behind leading whitespace/control chars", () => {
    const s = state({ config: { link: "\t javascript:alert(1)" } });
    const html = resolveDisplayHtml('<a href="{{config:link}}">x</a>', s, CLUB_FORMAT_TEST);
    expect(html).not.toMatch(/javascript:/);
    expect(html).toContain('href="#"');
  });

  it("does NOT scheme-check a token that only forms a PATH after a literal scheme", () => {
    // The scheme is the literal https://; the token is a trailing segment, so a
    // colon in its value is not a scheme and the value is kept verbatim (escaped).
    const s = state({ config: { path: "a:b" } });
    expect(
      resolveDisplayHtml('<a href="https://x.test/{{config:path}}">x</a>', s, CLUB_FORMAT_TEST)
    ).toBe('<a href="https://x.test/a:b">x</a>');
  });

  it("does NOT scheme-check a token in ordinary body copy (only URL attributes)", () => {
    // A javascript: string in text is inert copy: rendered verbatim (escaped),
    // never rewritten to '#'.
    const s = state({ config: { note: "javascript:alert(1)" } });
    expect(resolveDisplayHtml("<p>{{config:note}}</p>", s, CLUB_FORMAT_TEST)).toBe(
      "<p>javascript:alert(1)</p>"
    );
  });
});

// Phase 2 — composition-closing attribute scheme pass (issue #186). The phase-1
// guard above only inspects the token that OPENS a URL attribute, so a scheme
// split across adjacent tokens reconstitutes past it. The attribute-level pass
// re-checks the COMPLETE resolved value of every token-bearing href/src
// attribute, while leaving literal (no-token) attributes untouched so the
// display's allowed `data:` <img> srcs (issue #161) survive.
describe("resolveDisplayHtml — split-token scheme composition (issue #186)", () => {
  it("neutralises a javascript: scheme reconstituted across two adjacent tokens in an href", () => {
    // Neither half is a scheme on its own: 'javascript' has no colon, ':alert(1)'
    // is not at the attribute start. Only the concatenation forms javascript:.
    const s = state({ config: { a: "javascript", b: ":alert(1)" } });
    const html = resolveDisplayHtml('<a href="{{config:a}}{{config:b}}">x</a>', s, CLUB_FORMAT_TEST);
    expect(html).toBe('<a href="#">x</a>');
    expect(html).not.toMatch(/javascript:/);
  });

  it("neutralises a data: scheme split across tokens in an <img> src", () => {
    const s = state({ config: { a: "data", b: ":text/html,evil" } });
    const html = resolveDisplayHtml('<img src="{{config:a}}{{config:b}}" />', s, CLUB_FORMAT_TEST);
    expect(html).toContain('src="#"');
    expect(html).not.toContain("data:");
  });

  it("neutralises a scheme composed of a literal prefix plus a token tail", () => {
    // The literal 'javascr' opens the attribute (no scheme yet); the token
    // completes 'javascript:'. Phase 1 never sees the token as the opener, so
    // only the phase-2 complete-value check catches it.
    const s = state({ config: { rest: "ipt:alert(1)" } });
    const html = resolveDisplayHtml('<a href="javascr{{config:rest}}">x</a>', s, CLUB_FORMAT_TEST);
    expect(html).toBe('<a href="#">x</a>');
    expect(html).not.toMatch(/javascript:/);
  });

  it("preserves a benign https URL whose path segment comes from a token", () => {
    const s = state({ config: { path: "wing/lodge-3" } });
    expect(
      resolveDisplayHtml('<a href="https://x.nz/{{config:path}}">x</a>', s, CLUB_FORMAT_TEST)
    ).toBe('<a href="https://x.nz/wing/lodge-3">x</a>');
  });

  it("leaves a literal data: <img> src (no token) untouched — no #161 regression", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const s = state({ config: { wifi: "alpine1234" } });
    const html = resolveDisplayHtml(
      `<img src="${dataUri}" /><p>Wi-Fi {{config:wifi}}</p>`,
      s,
      CLUB_FORMAT_TEST,
    );
    // The literal src carried no token, so phase 2 skips it: the data: URI is
    // preserved verbatim while the token-bearing copy still resolves.
    expect(html).toContain(`src="${dataUri}"`);
    expect(html).toContain("Wi-Fi alpine1234");
  });

  it("still neutralises a single-token whole-scheme attack (phase-1 path intact)", () => {
    const s = state({ config: { link: "javascript:alert(1)" } });
    expect(resolveDisplayHtml('<a href="{{config:link}}">x</a>', s, CLUB_FORMAT_TEST)).toBe(
      '<a href="#">x</a>'
    );
  });
});

describe("resolveDisplayText — unchanged text-path behaviour", () => {
  it("still returns raw (unescaped) text for React text nodes", () => {
    const s = state({ config: { note: "<img onerror=x>" } });
    // The text variant does NOT escape — React escapes at the text node.
    expect(resolveDisplayText("{{config:note}}", s, CLUB_FORMAT_TEST)).toBe("<img onerror=x>");
    expect(resolveDisplayText("{{club-name}}", s, CLUB_FORMAT_TEST)).toBe("{{club-name}}");
  });
});
