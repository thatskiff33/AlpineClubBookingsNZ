// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import type {
  DisplayState,
  DisplayStateBooking,
  DisplayStateGuest,
} from "@/lib/lodge-display-state";

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

// Issue #2047 — the template pack renders end to end through the REAL server
// assembler (buildLayoutRender) and the REAL client layout engine (DisplayScreen
// → LayoutScreen → Area/RotatorArea), mirroring the LTV-038 parity smoke. Two
// sources of truth are exercised:
//   • the four BUILT-IN pack boards, straight from built-in-seeds.ts;
//   • the two EXTRAS boards, parsed from the committed importable bundle
//     (docs/lobby-display/seeds/display-template-pack.bundle.zip) — so the test
//     proves the shipped artifact renders, not a hand-copied duplicate.
// Each new template gets a render assertion (incl. the rotator cases and the
// chores-off degradation case), plus the welcome-kiosk no-guest-names guarantee.
//
// buildLayoutRender imports the server-only sanitiser; stub `server-only` and
// import it dynamically (mirrors display-built-in-parity.test).
vi.mock("server-only", () => ({}));

let buildLayoutRender: (typeof import("@/lib/lodge-display/layout-render"))["buildLayoutRender"];

interface Def {
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
}

/** Load the extras bundle's layouts + templates from the committed zip. */
function loadExtras(): {
  layouts: Record<string, { bodyHtml: string; defaultCss: string; areas: unknown }>;
  templates: Record<
    string,
    { layoutKey: string; slotContent: unknown; cssOverrides: string; footerHtml: string }
  >;
} {
  const zipPath = path.join(
    process.cwd(),
    "docs/lobby-display/seeds/display-template-pack.bundle.zip"
  );
  const files = unzipSync(readFileSync(zipPath));
  const layoutsJson = JSON.parse(strFromU8(files["display/layouts.json"])) as Array<{
    key: string;
    bodyHtml: string;
    defaultCss: string;
    areas: unknown;
  }>;
  const templatesJson = JSON.parse(
    strFromU8(files["display/templates.json"])
  ) as Array<{
    key: string;
    layoutKey: string;
    slotContent: unknown;
    cssOverrides: string;
    footerHtml: string;
  }>;
  const layouts = Object.fromEntries(layoutsJson.map((l) => [l.key, l]));
  const templates = Object.fromEntries(templatesJson.map((t) => [t.key, t]));
  return { layouts, templates };
}

/** Build a Def for a committed built-in by key. */
async function builtInDef(key: string): Promise<Def> {
  const { BUILT_IN_DISPLAY_LAYOUTS, BUILT_IN_DISPLAY_TEMPLATES } = await import(
    "@/lib/lodge-display/built-in-seeds"
  );
  const layout = BUILT_IN_DISPLAY_LAYOUTS.find((l) => l.key === key)!;
  const template = BUILT_IN_DISPLAY_TEMPLATES.find((t) => t.key === key)!;
  return {
    bodyHtml: layout.bodyHtml,
    defaultCss: layout.defaultCss,
    areas: layout.areas,
    slotContent: template.slotContent,
    cssOverrides: template.cssOverrides,
    footerHtml: template.footerHtml,
  };
}

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

/** Render a (layout+template) def against a DisplayState through the real
 * server assembly + client layout engine; returns the mounted container. */
async function renderBoard(def: Def, state: DisplayState) {
  const layoutRender = buildLayoutRender(
    {
      bodyHtml: def.bodyHtml,
      defaultCss: def.defaultCss,
      areas: def.areas as never,
      slotContent: def.slotContent as never,
      cssOverrides: def.cssOverrides,
      footerHtml: def.footerHtml,
    },
    state
  );
  queue.push({
    match: (url) => url.includes("/api/display/state"),
    body: { ...state, template: FALLBACK_TEMPLATE_FIELD, layoutRender },
  });
  const { DisplayScreen } = await import("@/app/display/display-screen");
  const utils = render(<DisplayScreen zone={CLUB_ZONE} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  return utils;
}

// --- state fixtures --------------------------------------------------------

const WINDOW3 = ["2026-04-13", "2026-04-14", "2026-04-15"];

/** Expand a half-open envelope into night keys — the payload's own rule. */
function envelopeNights(stayStart: string, stayEnd: string): string[] {
  const nights: string[] = [];
  for (let key = stayStart; key < stayEnd; ) {
    nights.push(key);
    const next = new Date(`${key}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    key = next.toISOString().slice(0, 10);
  }
  return nights;
}

/**
 * A fixture row or guest may leave `nights` out and gets the expanded envelope
 * (#2735) — the same convention as the module fixtures.
 *
 * `nights` is REQUIRED on the real payload and every board here reads it, so a
 * fixture without one would render through the `nights === undefined` fallback
 * branch that the serialiser never produces. Filling it in keeps this file —
 * the tree's only whole-board-pack coverage — on the payload shape production
 * actually emits.
 */
type GuestFixture = Omit<DisplayStateGuest, "nights"> & { nights?: string[] };
type BookingFixture = Omit<DisplayStateBooking, "guests" | "nights"> & {
  guests?: GuestFixture[] | null;
  nights?: string[];
};
type StateFixture = Omit<Partial<DisplayState>, "bookings"> & {
  bookings?: BookingFixture[];
};

function withNights(booking: BookingFixture): DisplayStateBooking {
  return {
    ...booking,
    guests:
      booking.guests?.map((guest) => ({
        ...guest,
        nights: guest.nights ?? envelopeNights(guest.stayStart, guest.stayEnd),
      })) ?? null,
    nights: booking.nights ?? envelopeNights(booking.stayStart, booking.stayEnd),
  };
}

function baseState(overrides: StateFixture = {}): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    occupancy: WINDOW3.map((date) => ({ date, arriving: 0, departing: 0, staying: 0 })),
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
    bookings: (overrides.bookings ?? []).map(withNights),
  } as DisplayState;
}

describe("issue #2047 pack — built-in boards", () => {
  it("room-by-room renders the room cards main + arrivals side rail", async () => {
    const def = await builtInDef("room-by-room");
    const state = baseState({
      rooms: [
        { id: "r1", name: "Kea" },
        { id: "r2", name: "Tui" },
      ],
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: "r1",
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 1 },
        { date: "2026-04-15", arriving: 0, departing: 1, staying: 1 },
      ],
      capabilities: { bedAllocation: true, chores: false },
    });
    const { container } = await renderBoard(def, state);

    const rooms = container.querySelector(".display-room-cards");
    const arrivals = container.querySelector(".display-arrivals-board");
    expect(rooms).not.toBeNull();
    expect(arrivals).not.toBeNull();
    // The room cards sit in the main column, the arrivals board in the rail.
    expect(rooms?.closest(".rbr-main")).not.toBeNull();
    expect(arrivals?.closest(".rbr-rail")).not.toBeNull();
  });

  it("nights-ahead renders the night columns and the notice band when a notice is set", async () => {
    const def = await builtInDef("nights-ahead");
    const state = baseState({
      rooms: [{ id: "r1", name: "Kea" }],
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: "r1",
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 1 },
        { date: "2026-04-15", arriving: 0, departing: 1, staying: 1 },
      ],
      notice: "Snow report at 8am",
      capabilities: { bedAllocation: true, chores: false },
    });
    const { container } = await renderBoard(def, state);

    expect(container.querySelector(".display-night-columns")).not.toBeNull();
    const notice = container.querySelector(".display-notice-board");
    expect(notice).not.toBeNull();
    expect(notice?.closest(".na-band")).not.toBeNull();
    expect(screen.getByText(/Snow report at 8am/)).toBeDefined();
  });

  it("nights-ahead drops the notice band when no notice is set (conditional area)", async () => {
    const def = await builtInDef("nights-ahead");
    const { container } = await renderBoard(def, baseState({ notice: null }));
    expect(container.querySelector(".display-night-columns")).not.toBeNull();
    expect(container.querySelector(".display-notice-board")).toBeNull();
  });

  it("operations-board renders status + chores + notice with the Chores module on", async () => {
    const def = await builtInDef("operations-board");
    const state = baseState({
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: null,
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      chores: [
        { date: "2026-04-13", title: "Sweep the bunkroom", assigneeLabels: ["Sam T"] },
      ],
      notice: "Committee meeting Friday",
      capabilities: { bedAllocation: false, chores: true },
    });
    const { container } = await renderBoard(def, state);

    expect(container.querySelector(".display-status-board")).not.toBeNull();
    expect(container.querySelector(".display-chores-board")).not.toBeNull();
    expect(container.querySelector(".display-notice-board")).not.toBeNull();
    // No disabled placeholder while chores are on.
    expect(container.querySelector("[data-module-disabled]")).toBeNull();
  });

  it("operations-board auto-degrades gracefully when the Chores module is off", async () => {
    const def = await builtInDef("operations-board");
    const state = baseState({
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: null,
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      chores: [],
      notice: "Committee meeting Friday",
      capabilities: { bedAllocation: false, chores: false },
    });
    const { container } = await renderBoard(def, state);

    // The status board and the notice still render; the chores card hides itself
    // to an empty placeholder so the rail keeps its shape (no empty card, no crash).
    expect(container.querySelector(".display-status-board")).not.toBeNull();
    expect(container.querySelector(".display-notice-board")).not.toBeNull();
    expect(container.querySelector(".display-chores-board")).toBeNull();
    expect(
      container.querySelector("[data-module-disabled='chores-board']")
    ).not.toBeNull();
  });

  it("welcome-kiosk renders the welcome hero + rotator (house rules first) and NO guest names", async () => {
    const def = await builtInDef("welcome-kiosk");
    // A whole-lodge group (label only) AND a named individual booking present:
    // the kiosk must surface neither the individual's name nor any board of names.
    const state = baseState({
      bookings: [
        {
          key: "wl",
          label: "Harakeke College",
          wholeLodge: true,
          roomId: null,
          guests: null,
          guestCount: 20,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
        {
          key: "ind",
          label: "Priya N",
          wholeLodge: false,
          roomId: null,
          guests: [{ label: "Priya Nathan", stayStart: "2026-04-13", stayEnd: "2026-04-14" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-14",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      rules: [{ title: "House rules", html: "<p>Boots off at the door.</p>" }],
      notice: "Committee meeting Friday",
    });
    const { container } = await renderBoard(def, state);

    // Welcome hero present; the rotator's first eligible child (house rules) shows.
    expect(container.querySelector(".display-welcome")).not.toBeNull();
    expect(container.querySelector(".display-lodge-rules")).not.toBeNull();
    expect(screen.getByText(/Boots off at the door/)).toBeDefined();

    // No guest ROSTER / arrivals name anywhere — the whole-lodge holder here is an
    // organisation ("Harakeke College"), so not even a group person-name shows. The
    // only name-bearing roster modules (arrivals/room/status/singles/night) are never
    // embedded. F6 hardening: scan innerHTML too (not just textContent), so a name
    // hidden in an attribute value (title / aria-label) can't slip past.
    const text = container.textContent ?? "";
    const html = container.innerHTML;
    for (const forbidden of ["Priya", "Priya N", "Priya Nathan"]) {
      expect(text).not.toContain(forbidden);
      expect(html).not.toContain(forbidden);
    }
    expect(container.querySelector(".display-arrivals-board")).toBeNull();
    expect(container.querySelector(".display-room-cards")).toBeNull();
    expect(container.querySelector(".display-status-board")).toBeNull();
    expect(container.querySelector(".display-singles-board")).toBeNull();
    expect(container.querySelector(".display-night-columns")).toBeNull();
  });

  it("welcome-kiosk whole-lodge group label CAN be a named member's name at FULL_NAME — the true, bounded behaviour (F2)", async () => {
    const def = await builtInDef("welcome-kiosk");
    // An EXCLUSIVE whole-lodge hold booked by a single named member (no minors,
    // not an organisation) under FULL_NAME granularity: the server has already
    // reduced its label to `bookingLabel` = the organiser's name at the lodge's
    // setting, so `wholeLodgeRow.label` here is that member's own name. The kiosk
    // is the LOWEST-name-surface board, not a zero-name board: it may show this
    // one whole-lodge GROUP label (never more than the lodge granularity), and no
    // roster/arrivals names at all.
    const state = baseState({
      bookings: [
        {
          key: "wl",
          label: "Priya Nathan", // FULL_NAME reduction of a single-member whole-lodge hold
          wholeLodge: true,
          roomId: null,
          guests: null,
          guestCount: 4,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      rules: [{ title: "House rules", html: "<p>Boots off at the door.</p>" }],
      notice: null,
    });
    const { container } = await renderBoard(def, state);

    // The whole-lodge group label renders — and this test ACCEPTS it: the copy
    // must match reality. It appears in the welcome-group span, i.e. the whole-lodge
    // label surface, not via any roster module.
    const group = container.querySelector(".display-welcome-group");
    expect(group?.textContent).toContain("Priya Nathan");

    // Nothing MORE than the lodge granularity's whole-lodge label: the name occurs
    // ONLY inside the welcome-group label — nowhere else in text OR markup — and no
    // name-bearing roster module is embedded to emit any further name.
    const occurrences = (container.innerHTML.match(/Priya Nathan/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(container.querySelector(".display-arrivals-board")).toBeNull();
    expect(container.querySelector(".display-room-cards")).toBeNull();
    expect(container.querySelector(".display-status-board")).toBeNull();
    expect(container.querySelector(".display-singles-board")).toBeNull();
    expect(container.querySelector(".display-night-columns")).toBeNull();
  });

  it("welcome-kiosk rotator skips the rules card when the lodge has no instruction docs — notice still rotates (F3)", async () => {
    const def = await builtInDef("welcome-kiosk");
    // Notice set, but NO instruction docs. The `rules` child is gated on
    // `content:instructions`, so it is skipped (no blank rules card flashing);
    // the notice is the only eligible rotator child and shows.
    const state = baseState({
      rules: null,
      notice: "Committee meeting Friday",
    });
    const { container } = await renderBoard(def, state);

    expect(container.querySelector(".display-welcome")).not.toBeNull();
    // Rules card skipped (no empty div rotating in), notice shown.
    expect(container.querySelector(".display-lodge-rules")).toBeNull();
    expect(container.querySelector(".display-notice-board")).not.toBeNull();
    expect(screen.getByText(/Committee meeting Friday/)).toBeDefined();
  });

  it("welcome-kiosk rotator degrades to nothing (no crash, hero still shows) when there are NEITHER docs NOR a notice (F3)", async () => {
    const def = await builtInDef("welcome-kiosk");
    // Both rotator children are gated (rules on content:instructions, notice on
    // content:notice) and neither holds: the rotator has zero eligible children,
    // so RotatorArea renders null (its `.wk-info` slot is simply empty). The board
    // does NOT go fully blank — the welcome hero + header + footer still render —
    // and nothing crashes.
    const state = baseState({ rules: null, notice: null });
    const { container } = await renderBoard(def, state);

    // Hero still present → not a blank screen.
    expect(container.querySelector(".display-welcome")).not.toBeNull();
    // Rotator degraded to empty: neither card renders.
    expect(container.querySelector(".display-lodge-rules")).toBeNull();
    expect(container.querySelector(".display-notice-board")).toBeNull();
    // The info area's portal marker still exists but carries no rendered card.
    const infoArea = container.querySelector('[data-display-area="info"]');
    expect(infoArea).not.toBeNull();
    expect(infoArea?.querySelector(".display-lodge-rules, .display-notice-board")).toBeNull();
  });
});

describe("issue #2047 pack — extras bundle boards (from the committed zip)", () => {
  it("busy-weekend rotates the occupancy blockout in first while the lodge is booked out", async () => {
    const { layouts, templates } = loadExtras();
    const t = templates["busy-weekend"];
    const l = layouts[t.layoutKey];
    const def: Def = {
      bodyHtml: l.bodyHtml,
      defaultCss: l.defaultCss,
      areas: l.areas,
      slotContent: t.slotContent,
      cssOverrides: t.cssOverrides,
      footerHtml: t.footerHtml,
    };
    const state = baseState({
      rooms: [
        { id: "r1", name: "Kea" },
        { id: "r2", name: "Tui" },
      ],
      bookings: [
        {
          key: "wl",
          label: "Harakeke College",
          wholeLodge: true,
          roomId: null,
          guests: null,
          guestCount: 20,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 20, departing: 0, staying: 20 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 20 },
        { date: "2026-04-15", arriving: 0, departing: 20, staying: 0 },
      ],
      capabilities: { bedAllocation: true, chores: false },
    });
    const { container } = await renderBoard(def, state);
    // occupancy child is condition-eligible (a whole-lodge booking is in window),
    // so it is the first rotator child rendered.
    expect(container.querySelector(".display-occupancy-grid, .display-blockout-board")).not.toBeNull();
    expect(screen.getByText("Harakeke College")).toBeDefined();
  });

  it("busy-weekend falls to the arrivals board when no whole-lodge booking is in the window", async () => {
    const { layouts, templates } = loadExtras();
    const t = templates["busy-weekend"];
    const l = layouts[t.layoutKey];
    const def: Def = {
      bodyHtml: l.bodyHtml,
      defaultCss: l.defaultCss,
      areas: l.areas,
      slotContent: t.slotContent,
      cssOverrides: t.cssOverrides,
      footerHtml: t.footerHtml,
    };
    const state = baseState({
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: null,
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-14" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-14",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
        { date: "2026-04-14", arriving: 0, departing: 1, staying: 0 },
        { date: "2026-04-15", arriving: 0, departing: 0, staying: 0 },
      ],
    });
    const { container } = await renderBoard(def, state);
    // occupancy child is filtered out (no whole-lodge booking) → arrivals is first.
    expect(container.querySelector(".display-arrivals-board")).not.toBeNull();
    expect(container.querySelector(".display-blockout-board")).toBeNull();
  });

  it("arrivals-strip renders the arrivals strip + welcome panel (small-screen board)", async () => {
    const { layouts, templates } = loadExtras();
    const t = templates["arrivals-strip"];
    const l = layouts[t.layoutKey];
    const def: Def = {
      bodyHtml: l.bodyHtml,
      defaultCss: l.defaultCss,
      areas: l.areas,
      slotContent: t.slotContent,
      cssOverrides: t.cssOverrides,
      footerHtml: t.footerHtml,
    };
    const state = baseState({
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: null,
          guests: [
            { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-14" },
            { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-14" },
          ],
          guestCount: 2,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-14",
          // #2621: no expected arrival time in this fixture.
          arrivalTime: null,
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 2, departing: 0, staying: 2 },
        { date: "2026-04-14", arriving: 0, departing: 2, staying: 0 },
        { date: "2026-04-15", arriving: 0, departing: 0, staying: 0 },
      ],
    });
    const { container } = await renderBoard(def, state);
    expect(container.querySelector(".display-arrivals-board")).not.toBeNull();
    expect(container.querySelector(".display-welcome")).not.toBeNull();
    // lead-count name style (arrivals-board splits the lead name + overflow into
    // sibling spans): the lead name shows and the rest fold into a "+N" overflow,
    // rather than the second guest being spelled out.
    expect(screen.getByText("Jane S")).toBeDefined();
    expect(container.querySelector(".display-bar-overflow")?.textContent).toContain("+1");
    expect(screen.queryByText(/Rewi P/)).toBeNull();
  });
});
