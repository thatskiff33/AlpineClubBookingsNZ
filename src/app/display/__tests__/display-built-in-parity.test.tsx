// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// LTV-038 visual-parity smoke: the seeded everyday-board built-in, rendered end
// to end through the REAL server assembler (buildLayoutRender) and the REAL
// client layout engine (DisplayScreen → LayoutScreen), must reproduce the
// LTV-015/016 signature: the arrivals board, the stacked side-rail cards
// (chores + rules + a gated committee notice), the two-column grid container,
// and the footer chrome — mirroring the LTV-016 module-hook assertions.
//
// buildLayoutRender imports the server-only sanitiser; stub `server-only` and
// import it dynamically (mirrors lodge-display-layout-render.test).
vi.mock("server-only", () => ({}));

let buildLayoutRender: (typeof import("@/lib/lodge-display/layout-render"))["buildLayoutRender"];

// A DisplayState that makes every everyday-board module render its signature
// hook: bookings + occupancy (arrivals board), chores + the chores capability
// (chores card), a rules doc (rules card), and a committee notice (the gated
// notice area appears only when content:notice holds).
function everydayState(): import("@/lib/lodge-display-state").DisplayState {
  return {
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
        // #2735: the expanded envelope, which is what the serialiser emits for
        // a contiguous stay.
        nights: ["2026-04-13", "2026-04-14"],
      },
    ],
    occupancy: [
      { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
      { date: "2026-04-14", arriving: 0, departing: 0, staying: 1 },
      { date: "2026-04-15", arriving: 0, departing: 1, staying: 1 },
    ],
    chores: [
      { date: "2026-04-13", title: "Sweep the bunkroom", assigneeLabels: ["Sam T"] },
    ],
    rules: [{ title: "House rules", html: "<p>Boots off at the door.</p>" }],
    notice: "Committee meeting Friday 7pm",
    config: { "wifi-code": "alpine1234" },
    capabilities: { bedAllocation: false, chores: true },
  } as unknown as import("@/lib/lodge-display-state").DisplayState;
}

// The legacy `template` field the state route always attaches as the fallback;
// the layout render wins, but the payload type requires it.
const FALLBACK_TEMPLATE_FIELD = {
  key: "everyday-board",
  name: "Everyday board",
  regions: [{ key: "main", panels: [{ module: "arrivals-board" }] }],
};

const queue: Array<{ match: (url: string) => boolean; body: unknown }> = [];

beforeEach(async () => {
  vi.useFakeTimers();
  queue.length = 0;
  ({ buildLayoutRender } = await import("@/lib/lodge-display/layout-render"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const index = queue.findIndex((entry) => entry.match(url));
      if (index === -1) throw new Error(`no queued response for ${url}`);
      const [entry] = queue.splice(index, 1);
      return new Response(JSON.stringify(entry.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LTV-038 everyday-board built-in — visual parity", () => {
  it("renders the board, side-rail cards, notice, grid container, and footer chrome", async () => {
    const { BUILT_IN_DISPLAY_LAYOUTS, BUILT_IN_DISPLAY_TEMPLATES } = await import(
      "@/lib/lodge-display/built-in-seeds"
    );
    const { DisplayScreen } = await import("@/app/display/display-screen");

    const layout = BUILT_IN_DISPLAY_LAYOUTS.find((l) => l.key === "everyday-board")!;
    const template = BUILT_IN_DISPLAY_TEMPLATES.find(
      (t) => t.key === "everyday-board"
    )!;
    const state = everydayState();
    // The exact payload the state route would ship for a device bound to the
    // seeded everyday-board template.
    const layoutRender = buildLayoutRender(
      {
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas,
        slotContent: template.slotContent,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
      },
      state
    );

    queue.push({
      match: (url) => url.includes("/api/display/state"),
      body: { ...state, template: FALLBACK_TEMPLATE_FIELD, layoutRender },
    });

    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Fixed header chrome (page furniture, outside the authored root).
    expect(container.querySelector(".display-lodge-header")).not.toBeNull();
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();

    // The two-column board+rail grid container from the layout body (LTV-041
    // nesting): the grid holds the board column and the rail column.
    const grid = container.querySelector(".eb-grid");
    expect(grid).not.toBeNull();
    expect(container.querySelector(".eb-board")).not.toBeNull();
    expect(container.querySelector(".eb-rail")).not.toBeNull();

    // Board: the arrivals board renders inside the board column.
    const board = container.querySelector(".display-arrivals-board");
    expect(board).not.toBeNull();
    expect(board?.closest(".eb-board")).not.toBeNull();
    expect(screen.getByText(/Jane S/)).toBeDefined();

    // Side rail: chores card + rules card + the gated committee notice, all
    // inside the rail column.
    const chores = container.querySelector(".display-chores-board");
    const rules = container.querySelector(".display-lodge-rules");
    const notice = container.querySelector(".display-notice-board");
    expect(chores).not.toBeNull();
    expect(rules).not.toBeNull();
    expect(notice).not.toBeNull();
    expect(chores?.closest(".eb-rail")).not.toBeNull();
    expect(rules?.closest(".eb-rail")).not.toBeNull();
    expect(notice?.closest(".eb-rail")).not.toBeNull();
    // The notice is a real (non-empty) card, not the empty placeholder.
    expect(notice?.classList.contains("display-notice-empty")).toBe(false);
    expect(screen.getByText(/Committee meeting Friday/)).toBeDefined();

    // Footer chrome (#112): the built-in ships a friendly static footer default
    // (no forced wifi/config tokens), rendered in the footer container. The
    // config-driven InfoFooter wifi is only the fallback for an empty footerHtml.
    expect(screen.getByText(/Have a nice day/)).toBeDefined();
    expect(screen.queryByText("alpine1234")).toBeNull();
    expect(container.querySelector(".display-info-footer")).not.toBeNull();
    expect(
      container.querySelector(".display-authored-root .display-lodge-header")
    ).toBeNull();
  });

  it("omits the notice card when no committee notice is set (conditional area)", async () => {
    const { BUILT_IN_DISPLAY_LAYOUTS, BUILT_IN_DISPLAY_TEMPLATES } = await import(
      "@/lib/lodge-display/built-in-seeds"
    );
    const { DisplayScreen } = await import("@/app/display/display-screen");

    const layout = BUILT_IN_DISPLAY_LAYOUTS.find((l) => l.key === "everyday-board")!;
    const template = BUILT_IN_DISPLAY_TEMPLATES.find(
      (t) => t.key === "everyday-board"
    )!;
    const state = { ...everydayState(), notice: null };
    const layoutRender = buildLayoutRender(
      {
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas,
        slotContent: template.slotContent,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
      },
      state
    );

    queue.push({
      match: (url) => url.includes("/api/display/state"),
      body: { ...state, template: FALLBACK_TEMPLATE_FIELD, layoutRender },
    });

    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // The board and the two static rail cards remain; the notice area is gone.
    expect(container.querySelector(".display-arrivals-board")).not.toBeNull();
    expect(container.querySelector(".display-chores-board")).not.toBeNull();
    expect(container.querySelector(".display-notice-board")).toBeNull();
  });
});
