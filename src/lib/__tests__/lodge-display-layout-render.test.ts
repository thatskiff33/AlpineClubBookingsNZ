import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

// buildLayoutRender pulls in page-content-html which imports `server-only`,
// throwing outside an RSC context; stub it (mirrors display-state-route.test).
vi.mock("server-only", () => ({}));

// Imported after the server-only mock is registered (below), so buildLayoutRender
// does not throw at module-eval time.
let buildLayoutRender: (typeof import("@/lib/lodge-display/layout-render"))["buildLayoutRender"];

beforeEach(async () => {
  ({ buildLayoutRender } = await import("@/lib/lodge-display/layout-render"));
});

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
    config: {
      "wifi-code": "alpine1234",
      xss: "<img src=x onerror=alert(1)>",
    },
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  } as DisplayState;
}

// A layout+template that exercises every authored html surface: bodyHtml,
// slot html, defaultContent html, and footerHtml.
function input(overrides: Record<string, unknown> = {}) {
  return {
    bodyHtml:
      "<h1>{{lodge-name}}</h1><p>{{config:wifi-code}} {{club-name}}</p>" +
      "{{area:main}}{{area:withdefault}}",
    defaultCss: "",
    cssOverrides: "",
    areas: [
      { key: "main", description: "Main", kind: "static" },
      {
        key: "withdefault",
        description: "Has a default",
        kind: "static",
        defaultContent: { html: "<p>Default {{config:door-pin}}</p>" },
      },
    ],
    slotContent: {
      main: { html: "<p>{{config:xss}}</p>{{module:arrivals-board}}" },
    },
    footerHtml: "<span>{{config:xss}} {{club-name}} {{module:chores-board}}</span>",
    ...overrides,
  };
}

/** Narrow a slot's content to its html (the test only fills html slots). */
function slotHtml(
  render: ReturnType<typeof buildLayoutRender>,
  key: string
): string {
  const content = render.slotContent[key];
  if (!content || "module" in content) throw new Error(`slot "${key}" is not html`);
  return content.html;
}

describe("buildLayoutRender — LTV-028 value-token resolution", () => {
  it("resolves value tokens in bodyHtml and swaps area tokens for inert markers", () => {
    const render = buildLayoutRender(input(), state(), CLUB_FORMAT_TEST);
    expect(render.bodyHtml).toContain("Silverpeak Lodge");
    expect(render.bodyHtml).toContain("alpine1234");
    // Area placeholders become inert markers the client portals into (LTV-041).
    expect(render.bodyHtml).toContain('<div data-display-area="main"></div>');
    expect(render.bodyHtml).not.toContain("{{area:main}}");
    // A site-catalogue token is left VERBATIM (token-scope boundary).
    expect(render.bodyHtml).toContain("{{club-name}}");
  });

  it("HTML-escapes an injected config value on every authored surface", () => {
    const render = buildLayoutRender(input(), state(), CLUB_FORMAT_TEST);
    // Slot html: the <img onerror> value is inert escaped text, not an element.
    expect(slotHtml(render, "main")).toContain("&lt;img");
    expect(slotHtml(render, "main")).not.toContain("<img");
    // Footer html: same.
    expect(render.footerHtml).toContain("&lt;img");
    expect(render.footerHtml).not.toContain("<img");
  });

  it("keeps the VISIBLE unset marker inside defaultContent html", () => {
    const render = buildLayoutRender(input(), state(), CLUB_FORMAT_TEST);
    const withdefault = render.areas.find((a) => a.key === "withdefault");
    expect(withdefault?.defaultContent).toEqual({
      html: "<p>Default ⟨config:door-pin?⟩</p>",
    });
  });

  it("swaps module embed tokens for inert markers on slot and footer html", () => {
    const render = buildLayoutRender(input(), state(), CLUB_FORMAT_TEST);
    expect(slotHtml(render, "main")).toContain(
      '<div data-display-module="arrivals-board"></div>'
    );
    expect(slotHtml(render, "main")).not.toContain("{{module:arrivals-board}}");
    expect(render.footerHtml).toContain(
      '<div data-display-module="chores-board"></div>'
    );
    expect(render.footerHtml).not.toContain("{{module:chores-board}}");
  });

  it("leaves site-catalogue tokens verbatim on slot and footer surfaces", () => {
    const render = buildLayoutRender(
      input({
        slotContent: { main: { html: "<p>{{club-name}} {{lodge-capacity}}</p>" } },
      }),
      state(),
      CLUB_FORMAT_TEST
    );
    expect(slotHtml(render, "main")).toContain("{{club-name}}");
    expect(slotHtml(render, "main")).toContain("{{lodge-capacity}}");
    expect(render.footerHtml).toContain("{{club-name}}");
  });

  it("still strips <script> from authored html (CMS trust model unchanged)", () => {
    const render = buildLayoutRender(
      input({
        footerHtml: "<span>Wi-Fi</span><script>evil()</script>",
      }),
      state(),
      CLUB_FORMAT_TEST
    );
    expect(render.footerHtml).not.toMatch(/<script/i);
  });
});

// Issue #161 (ADR-003 residual): the display img-src CSP is now 'self' data:,
// so an <img> pointed at an external host — including one saved BEFORE this
// change — must render with its src stripped, not throw and blank the board.
describe("buildLayoutRender — display img-src restriction (issue #161)", () => {
  it("strips an external <img> src from every authored html surface without throwing", () => {
    const render = buildLayoutRender(
      input({
        bodyHtml:
          '<h1>{{lodge-name}}</h1><img src="https://evil.example/beacon.gif" />' +
          "{{area:main}}{{area:withdefault}}",
        slotContent: {
          main: { html: '<img src="https://evil.example/x.png" alt="x" />' },
        },
        footerHtml: '<img src="https://evil.example/y.png" />Wi-Fi info',
      }),
      state(),
      CLUB_FORMAT_TEST
    );

    expect(render.bodyHtml).not.toContain("evil.example");
    // src stripped; the missing alt is backfilled from the filename (#1947).
    expect(render.bodyHtml).toContain('<img alt="beacon" />');
    expect(slotHtml(render, "main")).not.toContain("evil.example");
    expect(slotHtml(render, "main")).toBe('<img alt="x" />');
    expect(render.footerHtml).not.toContain("evil.example");
    // The rest of the board still renders — never a blank board.
    expect(render.bodyHtml).toContain("Silverpeak Lodge");
    expect(render.footerHtml).toContain("Wi-Fi info");
  });

  it("keeps a relative/self <img> src and a data: <img> src (matches display CSP img-src 'self' data:)", () => {
    const render = buildLayoutRender(
      input({
        slotContent: {
          main: {
            html:
              '<img src="/branding/lodge.jpg" alt="a" />' +
              '<img src="data:image/png;base64,aGVsbG8=" alt="b" />',
          },
        },
      }),
      state(),
      CLUB_FORMAT_TEST
    );
    expect(slotHtml(render, "main")).toBe(
      '<img src="/branding/lodge.jpg" alt="a" /><img src="data:image/png;base64,aGVsbG8=" alt="b" />'
    );
  });
});

// Issue #176: a resolved token value that opens an authored href/src must not
// smuggle a dangerous scheme past the sanitiser (which ran BEFORE resolution).
describe("buildLayoutRender — URL-scheme guard for resolved tokens (issue #176)", () => {
  it("neutralises a javascript: config value resolved into an authored href", () => {
    const render = buildLayoutRender(
      input({
        slotContent: { main: { html: '<a href="{{config:evil}}">Book</a>' } },
      }),
      state({ config: { "wifi-code": "alpine1234", evil: "javascript:alert(1)" } }),
      CLUB_FORMAT_TEST
    );
    const html = slotHtml(render, "main");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  it("preserves a benign https config value resolved into an authored href", () => {
    const render = buildLayoutRender(
      input({
        slotContent: { main: { html: '<a href="{{config:book-url}}">Book</a>' } },
      }),
      state({
        config: { "wifi-code": "alpine1234", "book-url": "https://club.nz/book" },
      }),
      CLUB_FORMAT_TEST
    );
    expect(slotHtml(render, "main")).toContain('href="https://club.nz/book"');
  });
});

describe("buildLayoutRender — LTV-041 marker replacement (issue #96)", () => {
  it("keeps an area marker INSIDE an authored container (nesting preserved)", () => {
    // The 2+1 case: two placeholders nested two containers deep. The marker must
    // land inside .main-col / .side-col, not break out to a sibling.
    const render = buildLayoutRender(
      input({
        bodyHtml:
          '<div class="two-plus-one">' +
          '<div class="main-col">{{area:main}}</div>' +
          '<div class="side-col">{{area:rail}}</div></div>',
        areas: [
          { key: "main", description: "Main", kind: "static" },
          { key: "rail", description: "Rail", kind: "static" },
        ],
        slotContent: { main: { html: "<p>x</p>" } },
      }),
      state(),
      CLUB_FORMAT_TEST
    );
    expect(render.bodyHtml).toContain(
      '<div class="main-col"><div data-display-area="main"></div></div>'
    );
    expect(render.bodyHtml).toContain(
      '<div class="side-col"><div data-display-area="rail"></div></div>'
    );
    // The grid container survives whole (its children were never auto-closed).
    expect(render.bodyHtml).toContain('<div class="two-plus-one">');
  });

  it("strips an author-typed marker div so only generated markers survive (spoof defence)", () => {
    // An author types a real placeholder AND a spoof marker div for the same key.
    // Sanitisation drops the hand-typed data-display-area attribute (only class/
    // aria-hidden are allowlisted), so exactly one genuine marker remains.
    const render = buildLayoutRender(
      input({
        bodyHtml:
          '<div data-display-area="main" class="spoof">hi</div>{{area:main}}',
        areas: [{ key: "main", description: "Main", kind: "static" }],
        slotContent: { main: { html: "<p>x</p>" } },
      }),
      state(),
      CLUB_FORMAT_TEST
    );
    const markerCount = (
      render.bodyHtml.match(/data-display-area="main"/g) ?? []
    ).length;
    expect(markerCount).toBe(1);
    // The spoof div lost its attribute but kept its allowlisted class.
    expect(render.bodyHtml).toContain('<div class="spoof">hi</div>');
  });

  it("strips an author-typed module marker div too (spoof defence)", () => {
    const render = buildLayoutRender(
      input({
        slotContent: {
          main: {
            html: '<div data-display-module="welcome" class="spoof"></div>{{module:arrivals-board}}',
          },
        },
      }),
      state(),
      CLUB_FORMAT_TEST
    );
    const html = slotHtml(render, "main");
    // Only the generated arrivals-board marker survives; the hand-typed welcome
    // marker lost its data attribute during sanitisation.
    expect(html).toContain('<div data-display-module="arrivals-board"></div>');
    expect(html).not.toContain('data-display-module="welcome"');
  });

  it("keeps a module marker INSIDE a nested slot-html container (nesting preserved)", () => {
    const render = buildLayoutRender(
      input({
        slotContent: {
          main: {
            html: '<div class="wrap"><section>{{module:arrivals-board}}</section></div>',
          },
        },
      }),
      state(),
      CLUB_FORMAT_TEST
    );
    expect(slotHtml(render, "main")).toContain(
      '<section><div data-display-module="arrivals-board"></div></section>'
    );
  });
});

describe("buildLayoutRender — LTV-029 CSS hardening + theme", () => {
  it("sanitises AND scopes defaultCss and cssOverrides", () => {
    const render = buildLayoutRender(
      input({
        defaultCss: ".board{color:red}",
        cssOverrides:
          ".x{background:url(https://evil.example/x.png)}.display-header-clock{display:none}",
      }),
      state(),
      CLUB_FORMAT_TEST
    );
    // Every authored selector is prefixed with the authored-root scope so it
    // can only style the editable body/footer, never the chrome.
    expect(render.defaultCss).toContain(".display-authored-root .board");
    expect(render.cssOverrides).toContain(".display-authored-root .x");
    expect(render.cssOverrides).toContain(
      ".display-authored-root .display-header-clock"
    );
    // The external url() exfiltration vector is removed.
    expect(render.cssOverrides).not.toContain("evil.example");
    expect(render.cssOverrides).toContain("/* blocked: external url */");
  });

  it("still neutralises the </style breakout in CSS (now via sanitiseDisplayCss)", () => {
    const render = buildLayoutRender(
      input({ defaultCss: "body{color:red}</style><script>y()</script>" }),
      state(),
      CLUB_FORMAT_TEST
    );
    expect(render.defaultCss).not.toMatch(/<\/style/i);
    expect(render.defaultCss).not.toContain("<");
  });

  it("passes the club themeCss through verbatim and unscoped", () => {
    const themeCss = ":root,.website-theme{--brand-gold:#8fa87c;}";
    const render = buildLayoutRender(input({ themeCss }), state(), CLUB_FORMAT_TEST);
    expect(render.themeCss).toBe(themeCss);
  });

  it("defaults themeCss to an empty string when none is supplied", () => {
    const render = buildLayoutRender(input(), state(), CLUB_FORMAT_TEST);
    expect(render.themeCss).toBe("");
  });
});

// LTV-038: the three seeded built-ins must build cleanly through the SAME server
// assembler the state route runs — a broken seed would fall a real wall back to
// the fallback board, so proving they validate + sanitise + scope here is the
// structural half of the visual-parity guarantee (the render half lives in the
// jsdom display-built-in-parity test).
describe("buildLayoutRender — LTV-038 seeded built-ins build cleanly", () => {
  it("assembles each built-in layout+template without throwing, scoping its CSS", async () => {
    const { BUILT_IN_DISPLAY_LAYOUTS, BUILT_IN_DISPLAY_TEMPLATES } = await import(
      "@/lib/lodge-display/built-in-seeds"
    );
    for (const layout of BUILT_IN_DISPLAY_LAYOUTS) {
      const template = BUILT_IN_DISPLAY_TEMPLATES.find(
        (candidate) => candidate.layoutKey === layout.key
      )!;
      const render = buildLayoutRender(
        {
          bodyHtml: layout.bodyHtml,
          defaultCss: layout.defaultCss,
          areas: layout.areas,
          slotContent: template.slotContent,
          cssOverrides: template.cssOverrides,
          footerHtml: template.footerHtml,
        },
        state(),
        CLUB_FORMAT_TEST
      );
      // Every area placeholder became an inert marker; no raw token survived.
      expect(render.bodyHtml).not.toContain("{{area:");
      expect(render.bodyHtml).toContain("data-display-area=");
      // The layout CSS is scoped to the authored root (chrome-safe).
      if (layout.defaultCss.trim().length > 0) {
        expect(render.defaultCss).toContain(".display-authored-root");
      }
    }
  });

  it("scopes the everyday-board board+rail grid so it cannot reach the chrome", async () => {
    const { BUILT_IN_DISPLAY_LAYOUTS, BUILT_IN_DISPLAY_TEMPLATES } = await import(
      "@/lib/lodge-display/built-in-seeds"
    );
    const layout = BUILT_IN_DISPLAY_LAYOUTS.find((l) => l.key === "everyday-board")!;
    const template = BUILT_IN_DISPLAY_TEMPLATES.find(
      (t) => t.key === "everyday-board"
    )!;
    const render = buildLayoutRender(
      {
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas,
        slotContent: template.slotContent,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
      },
      state(),
      CLUB_FORMAT_TEST
    );
    // The two-column grid selector survived sanitisation and is scoped.
    expect(render.defaultCss).toContain(".display-authored-root .eb-grid");
    expect(render.defaultCss).toContain("grid-template-columns: 1fr 27vw");
    // color-mix()/var() in the notice card treatment are preserved (not stripped).
    expect(render.defaultCss).toContain("color-mix(in srgb, var(--display-departing)");
  });
});
