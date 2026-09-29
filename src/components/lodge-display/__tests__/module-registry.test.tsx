// @vitest-environment jsdom

import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { render } from "@/lib/__tests__/support/club-time-render";
import type {
  DisplayState,
  DisplayStateBooking,
  DisplayStateGuest,
} from "@/lib/lodge-display-state";
import { DISPLAY_CONDITION_NAMES } from "@/lib/lodge-display/conditions";
import { DISPLAY_MODULE_NAMES } from "@/lib/lodge-display/template-registry";
import {
  getDisplayModule,
  listDisplayModules,
} from "@/lib/lodge-display/module-registry";
import {
  DISPLAY_MODULE_COMPONENTS,
  type DisplayModuleProps,
} from "@/components/lodge-display/modules";
import { ArrivalsBoard } from "@/components/lodge-display/modules/arrivals-board";
import { ChoresBoard } from "@/components/lodge-display/modules/chores-board";
import { LodgeRules } from "@/components/lodge-display/modules/lodge-rules";
import { NoticeBoard } from "@/components/lodge-display/modules/notice-board";
import { OccupancyGrid } from "@/components/lodge-display/modules/occupancy-grid";
import { SinglesBoard } from "@/components/lodge-display/modules/singles-board";
import { WelcomePanel } from "@/components/lodge-display/modules/welcome-panel";

// LTV-026: the module metadata registry drives the LTV-034 reference screen,
// the render-boundary dependency guard, and the CSS-hook stability contract.
// These tests are the cross-registry sweep that catches a module forgetting its
// metadata, and the contract that fails CI when a class hook is renamed without
// updating the declared contract admins target.

const WINDOW = ["2026-04-13", "2026-04-14", "2026-04-15"];

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
 * A fixture row or guest may leave `nights` out, and gets the expanded envelope
 * (#2735) — which is exactly what the serialiser emits for a contiguous stay,
 * so these hook fixtures render the bars they always did.
 */
type GuestFixture = Omit<DisplayStateGuest, "nights"> & { nights?: string[] };
type RowFixture = Partial<Omit<DisplayStateBooking, "guests">> & {
  guests?: GuestFixture[] | null;
};

function row(overrides: RowFixture): DisplayStateBooking {
  const merged = {
    key: "row-1-0",
    label: "Olive O",
    wholeLodge: false,
    roomId: null,
    guests: [
      { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
    ] as GuestFixture[] | null,
    guestCount: 1,
    stayStart: "2026-04-13",
    stayEnd: "2026-04-15",
    // #2621: no expected arrival time is the ordinary case, so the base fixture
    // has none; the cases that exercise the chip set it explicitly.
    arrivalTime: null,
    ...overrides,
  };
  return {
    ...merged,
    guests:
      merged.guests?.map((guest) => ({
        ...guest,
        nights: guest.nights ?? envelopeNights(guest.stayStart, guest.stayEnd),
      })) ?? null,
    nights:
      overrides.nights ?? envelopeNights(merged.stayStart, merged.stayEnd),
  };
}

function state(overrides: Partial<DisplayState>): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: WINDOW.map((date) => ({ date, arriving: 0, departing: 0, staying: 0 })),
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    // #2286: no custodian in residence in the base fixture.
    custodian: null,
    ...overrides,
  };
}

describe("module registry cross-registry integrity", () => {
  it("gives every template-registry module name metadata", () => {
    const metadataNames = new Set(listDisplayModules().map((entry) => entry.name));
    for (const name of DISPLAY_MODULE_NAMES) {
      expect(metadataNames.has(name)).toBe(true);
      expect(getDisplayModule(name)).toBeDefined();
    }
    // No orphan metadata for a name the template registry does not know.
    expect(metadataNames.size).toBe(DISPLAY_MODULE_NAMES.length);
  });

  it("only contributes condition names that exist in the conditions registry", () => {
    const known = new Set(DISPLAY_CONDITION_NAMES);
    for (const entry of listDisplayModules()) {
      for (const condition of entry.contributes) {
        expect(known.has(condition)).toBe(true);
      }
    }
  });

  it("only declares dependency flags the capability map carries", () => {
    // Every dependency must resolve against DisplayState.capabilities, which
    // carries exactly the DISPLAY_RELEVANT_MODULE_KEYS flags.
    const capabilityKeys = new Set(Object.keys(state({}).capabilities));
    for (const entry of listDisplayModules()) {
      for (const flag of entry.dependencies) {
        expect(capabilityKeys.has(flag)).toBe(true);
      }
      // A hard dependency ("hides") only makes sense with a flag to check.
      if (entry.dependencyMode === "hides") {
        expect(entry.dependencies.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("CSS-hook stability contract", () => {
  // A representative fixture per visual module that exercises its declared
  // hooks. Page furniture (lodge-header / info-footer) lives in the display
  // page shell and is covered by its metadata, not rendered here.
  const rooms = [{ id: "r1", name: "A - Kea" }];
  const overflowGuests = ["A", "B", "C", "D", "E", "F", "G"].map((n) => ({
    label: `${n} X`,
    stayStart: "2026-04-13",
    stayEnd: "2026-04-15",
  }));
  const wholeLodge = row({
    key: "wl",
    wholeLodge: true,
    label: "Harakeke College",
    guests: null,
    guestCount: 14,
    stayStart: "2026-04-13",
    stayEnd: "2026-04-15",
  });

  const cases: Array<{
    name: string;
    Component: ComponentType<DisplayModuleProps>;
    fixture: DisplayState;
  }> = [
    {
      name: "arrivals-board",
      Component: ArrivalsBoard,
      fixture: state({
        rooms,
        bookings: [
          row({
            key: "a",
            roomId: "r1",
            guests: overflowGuests,
            guestCount: 7,
            // #2621: the fixture has to exercise every declared hook, and
            // `display-bar-arrival` only renders for a row that carries a time.
            arrivalTime: "17:30",
          }),
        ],
      }),
    },
    {
      name: "occupancy-grid",
      Component: OccupancyGrid,
      fixture: state({ rooms: null, bookings: [wholeLodge] }),
    },
    {
      name: "singles-board",
      Component: SinglesBoard,
      fixture: state({
        rooms,
        bookings: [
          row({
            key: "s",
            roomId: "r1",
            guests: [
              { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-14" },
              { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
            ],
            guestCount: 2,
          }),
        ],
      }),
    },
    {
      name: "welcome",
      Component: WelcomePanel,
      fixture: state({
        bookings: [wholeLodge],
        config: { "checkin-note": "See your group leader", "whole-lodge-note": "Bunks upstairs" },
      }),
    },
    {
      name: "chores-board",
      Component: ChoresBoard,
      fixture: state({
        capabilities: { bedAllocation: false, chores: true },
        chores: [{ date: "2026-04-13", title: "Dishes", assigneeLabels: ["Jane S"] }],
      }),
    },
    {
      name: "lodge-rules",
      Component: LodgeRules,
      fixture: state({ rules: [{ title: "Arrival", html: "<p>Welcome</p>" }] }),
    },
    {
      name: "notice-board",
      Component: NoticeBoard,
      fixture: state({ notice: "Committee meeting on Saturday." }),
    },
  ];

  for (const { name, Component, fixture } of cases) {
    it(`${name} emits every declared CSS hook`, () => {
      const metadata = getDisplayModule(name as (typeof DISPLAY_MODULE_NAMES)[number]);
      expect(metadata).toBeDefined();
      const { container } = render(<Component state={fixture} />);
      for (const hook of metadata!.cssHooks) {
        expect(
          container.querySelector(`.${hook}`),
          `expected module "${name}" to render CSS hook ".${hook}"`
        ).not.toBeNull();
      }
    });
  }
});

describe("capability fallback guard (graceful degrade)", () => {
  const choresState = state({
    chores: [{ date: "2026-04-13", title: "Dishes", assigneeLabels: ["Jane S"] }],
  });

  it("hides chores-board when the Chores flag is off", () => {
    const Chores = DISPLAY_MODULE_COMPONENTS["chores-board"]!;
    const { container } = render(
      <Chores state={{ ...choresState, capabilities: { bedAllocation: false, chores: false } }} />
    );
    const disabled = container.querySelector("[data-module-disabled='chores-board']");
    expect(disabled).not.toBeNull();
    // The card itself is gone — the rail keeps its shape, no empty card.
    expect(container.querySelector(".display-chores-board")).toBeNull();
  });

  it("renders chores-board normally when the Chores flag is on", () => {
    const Chores = DISPLAY_MODULE_COMPONENTS["chores-board"]!;
    const { container } = render(
      <Chores state={{ ...choresState, capabilities: { bedAllocation: false, chores: true } }} />
    );
    expect(container.querySelector("[data-module-disabled]")).toBeNull();
    expect(container.querySelector(".display-chores-board")).not.toBeNull();
  });

  it("leaves degrade-mode modules unwrapped (they render their own reduced form)", () => {
    // Bed allocation off → arrivals-board still renders (per-booking rows).
    const Arrivals = DISPLAY_MODULE_COMPONENTS["arrivals-board"]!;
    const { container } = render(
      <Arrivals state={state({ bookings: [row({})] })} />
    );
    expect(container.querySelector("[data-module-disabled]")).toBeNull();
    expect(container.querySelector(".display-arrivals-board")).not.toBeNull();
  });
});
