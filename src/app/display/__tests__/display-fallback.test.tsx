// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LTV-030 (ADR-003 §5 "Unattended surface"): a WHOLE-LayoutScreen failure must
// drop to the known-good FallbackBoard, never a blank wall.
//
// Force the `welcome` module to throw at render. A layoutRender that embeds
// {{module:welcome}} in its FOOTER (which LayoutScreen renders OUTSIDE the
// per-area AreaErrorBoundary) therefore throws the whole LayoutScreen — the
// realistic "a module crashes on some edge of real data" failure. The fallback
// board is the everyday-board built-in, which does NOT use welcome, so it
// renders cleanly through the proven legacy region path.
vi.mock("@/components/lodge-display/modules", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/lodge-display/modules")>(
      "@/components/lodge-display/modules"
    );
  function BoomModule(): never {
    throw new Error("welcome module crashed");
  }
  return {
    ...actual,
    DISPLAY_MODULE_COMPONENTS: {
      ...actual.DISPLAY_MODULE_COMPONENTS,
      welcome: BoomModule,
    },
  };
});

import { DisplayScreen } from "@/app/display/display-screen";

/**
 * The club timezone these renders are about (CT-4, #2870).
 *
 * `DisplayScreen` takes the zone as a REQUIRED prop because `/display` sits
 * outside both route-group chrome components and so has no shared provider above
 * it: the server page resolves the club's persisted setting and hands it down.
 * A test therefore has to say which club it is rendering for, which is what makes
 * a zone assertion here capable of failing.
 */
const CLUB_ZONE = "Pacific/Auckland";

const PAYLOAD = {
  lodge: { name: "Silverpeak Lodge" },
  club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
  generatedAt: "2026-04-13T00:00:00.000Z",
  window: { start: "2026-04-13", days: 3 },
  rooms: null,
  bookings: [
    {
      key: "row-1-0",
      label: "Olive O",
      wholeLodge: false,
      roomId: null,
      guests: [
        {
          label: "Jane S",
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          nights: ["2026-04-13", "2026-04-14"],
        },
      ],
      guestCount: 1,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-15",
      // #2735: the expanded envelope, which is what the serialiser emits for a
      // contiguous stay.
      nights: ["2026-04-13", "2026-04-14"],
    },
  ],
  occupancy: [{ date: "2026-04-13", arriving: 1, departing: 0, staying: 1 }],
  chores: [],
  rules: null,
  notice: null,
  config: { "wifi-code": "alpine1234" },
  capabilities: { bedAllocation: false, chores: false },
  template: {
    key: "everyday-board",
    name: "Everyday board",
    regions: [
      { key: "header", panels: [{ module: "lodge-header" }] },
      { key: "main", panels: [{ module: "arrivals-board", options: { days: 3 } }] },
      { key: "footer", panels: [{ module: "info-footer" }] },
    ],
  },
};

// A layoutRender that renders a distinctive custom body, but whose footer embeds
// the (now-throwing) welcome module so LayoutScreen throws at render. Since
// LTV-041 the server ships inert markers (not `{{…}}` tokens); the client portals
// the welcome module into the footer's module marker, and its throw propagates up
// the React tree (the footer sits OUTSIDE the per-area AreaErrorBoundary) to the
// LayoutErrorBoundary.
const THROWING_LAYOUT_RENDER = {
  bodyHtml: '<h2>Custom Board Heading</h2><div data-display-area="main"></div>',
  themeCss: "",
  defaultCss: "",
  cssOverrides: "",
  areas: [{ key: "main", description: "Main", kind: "static" }],
  slotContent: { main: { html: "<p>custom body copy</p>" } },
  footerHtml: '<span>Footer</span><div data-display-module="welcome"></div>',
};

function enqueueState(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("/api/display/state")) throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // A caught render error still logs to console.error in dev — silence it so the
  // gate output stays clean; the boundary behaviour is what we assert.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/display");
});

describe("DisplayScreen page-level fallback (LTV-030) — client render throw", () => {
  it("drops a throwing LayoutScreen to the FallbackBoard, with no error text on a real wall", async () => {
    enqueueState({ ...PAYLOAD, layoutRender: THROWING_LAYOUT_RENDER });
    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // The fallback board is present and tagged for tests/diagnosis.
    const fallback = container.querySelector("[data-display-fallback]");
    expect(fallback).not.toBeNull();
    // The known-good everyday-board renders (its header chrome shows the lodge).
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    // The broken custom template's content never made it to the DOM.
    expect(screen.queryByText("Custom Board Heading")).toBeNull();
    expect(screen.queryByText("custom body copy")).toBeNull();
    // A real, unattended wall shows NO error text.
    expect(screen.queryByText(/Template failed/)).toBeNull();
  });

  it("shows the preview marker only in preview mode", async () => {
    window.history.pushState({}, "", "/display?preview=1");
    enqueueState({ ...PAYLOAD, layoutRender: THROWING_LAYOUT_RENDER });
    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(container.querySelector("[data-display-fallback]")).not.toBeNull();
    expect(screen.getByText(/Template failed — showing fallback board/)).toBeDefined();
  });
});

describe("DisplayScreen page-level fallback (LTV-030) — server broken binding", () => {
  it("renders the FallbackBoard when the server flags layoutRenderError (no layoutRender)", async () => {
    enqueueState({ ...PAYLOAD, layoutRenderError: true });
    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(container.querySelector("[data-display-fallback]")).not.toBeNull();
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    // Silent on a real wall.
    expect(screen.queryByText(/Template failed/)).toBeNull();
  });

  it("marks the broken binding in preview mode", async () => {
    window.history.pushState({}, "", "/display?previewDevice=dev-9");
    enqueueState({ ...PAYLOAD, layoutRenderError: true });
    render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText(/Template failed — showing fallback board/)).toBeDefined();
  });
});
