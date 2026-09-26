// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@/lib/__tests__/support/club-time-render";
import type {
  DisplayState,
  DisplayStateBooking,
  DisplayStateGuest,
} from "@/lib/lodge-display-state";
import { RoomCards } from "@/components/lodge-display/modules/room-cards";
import { NightColumns } from "@/components/lodge-display/modules/night-columns";
import { StatusBoard } from "@/components/lodge-display/modules/status-board";

// Issue #115 (closes #114): the tonight / look-ahead / status modules — pure
// functions of the privacy-reduced DisplayState. Fixtures mirror the serialiser
// payload; no module queries anything. tonight = window.start = 2026-04-13.

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
 * (#2735).
 *
 * `nights` is REQUIRED on the real payload, and for every CONTIGUOUS stay the
 * serialiser emits exactly the expanded envelope — so a fixture that says
 * nothing about nights is handed the payload it would really receive. A case
 * about a stay with a GAP in it states `nights` explicitly, which is the only
 * way to express one.
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

/** The data-status on the dot in the nearest row/person ancestor of `text`.
 * Walks up from the text node and stops at the first ancestor that holds a dot,
 * which is the row itself — so a sibling row's dot is never matched. */
function statusOf(scope: HTMLElement, text: string, dotClass: string): string | null {
  const el = within(scope).getByText(text);
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== scope.parentElement) {
    const dot = node.querySelector(`.${dotClass}`);
    if (dot) return dot.getAttribute("data-status");
    node = node.parentElement;
  }
  return null;
}

describe("RoomCards (mock O2)", () => {
  const rooms = [
    { id: "r1", name: "Kea" },
    { id: "r2", name: "Tui" },
    { id: "r3", name: "Snowline" },
  ];
  const fixture = state({
    rooms,
    bookings: [
      // r1: an arriving guest + an already-staying guest → count 2.
      row({ key: "a", roomId: "r1", guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }] }),
      row({ key: "a2", roomId: "r1", guests: [{ label: "Tom B", stayStart: "2026-04-12", stayEnd: "2026-04-15" }] }),
      // r2: a guest checking out this morning + a withheld group arriving.
      row({ key: "b", roomId: "r2", guests: [{ label: "Dave L", stayStart: "2026-04-10", stayEnd: "2026-04-13" }], stayStart: "2026-04-10", stayEnd: "2026-04-13" }),
      row({ key: "c", roomId: "r2", guests: null, label: "Harakeke College", guestCount: 14 }),
      // r3: nobody → free card.
    ],
  });

  it("names guests, shows a withheld booking as label + count, never inventing names", () => {
    const { container } = render(<RoomCards state={fixture} />);
    expect(screen.getByText("Jane S")).toBeDefined();
    expect(screen.getByText("Tom B")).toBeDefined();
    expect(container.textContent).toContain("Harakeke College · 14");
  });

  it("classifies arrive / stay / depart with the shared status dot", () => {
    const { container } = render(<RoomCards state={fixture} />);
    const board = container as unknown as HTMLElement;
    expect(statusOf(board, "Jane S", "display-room-dot")).toBe("arriving");
    expect(statusOf(board, "Tom B", "display-room-dot")).toBe("staying");
    expect(statusOf(board, "Dave L", "display-room-dot")).toBe("departing");
  });

  it("renders a dashed free card for an empty room and counts headcount (group counts its guests)", () => {
    const { container } = render(<RoomCards state={fixture} />);
    expect(screen.getByText("Snowline — free")).toBeDefined();
    expect(container.querySelector(".display-room-card-empty")).not.toBeNull();
    // r1 has two named guests tonight.
    const counts = Array.from(container.querySelectorAll(".display-room-card-count")).map(
      (n) => n.textContent
    );
    expect(counts).toContain("2 guests");
  });

  it("degrades to a note (not a crash) when bed allocation is off", () => {
    const { container } = render(<RoomCards state={state({ rooms: null, bookings: [row({})] })} />);
    expect(container.querySelector(".display-room-cards-fallback")).not.toBeNull();
    expect(screen.getByText(/needs bed allocation/)).toBeDefined();
    expect(container.querySelector(".display-room-card")).toBeNull();
  });
});

describe("NightColumns (mocks O3 / C1a)", () => {
  const rooms = [
    { id: "r1", name: "Kea" },
    { id: "r2", name: "Ruru" },
    { id: "r3", name: "Pukeko" },
  ];
  const fixture = state({
    rooms,
    occupancy: [
      { date: "2026-04-13", arriving: 2, departing: 1, staying: 3 },
      { date: "2026-04-14", arriving: 2, departing: 1, staying: 4 },
      { date: "2026-04-15", arriving: 0, departing: 2, staying: 2 },
    ],
    bookings: [
      // Named party of two, in all three columns (arrive → stay → depart).
      row({ key: "a", roomId: "r1", guests: [
        { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
        { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
      ], guestCount: 2 }),
      // Withheld group arriving on the second night only.
      row({ key: "b", roomId: "r2", guests: null, label: "Alpine Skills", guestCount: 14, stayStart: "2026-04-14", stayEnd: "2026-04-15" }),
      // Guest checking out tonight.
      row({ key: "c", roomId: "r3", guests: [{ label: "Dave L", stayStart: "2026-04-10", stayEnd: "2026-04-13" }], stayStart: "2026-04-10", stayEnd: "2026-04-13" }),
    ],
  });

  it("marks the today column and shows occupancy counts (with 'N new' on later nights)", () => {
    const { container } = render(<NightColumns state={fixture} />);
    const today = container.querySelector(".display-night-col-today") as HTMLElement;
    expect(today).not.toBeNull();
    expect(within(today).getByText(/Tonight/)).toBeDefined();
    expect(within(today).getByText("3 in")).toBeDefined();
    // Second column carries the arrivals delta.
    expect(screen.getByText("4 in · 2 new")).toBeDefined();
  });

  it("collapses a booking to lead name + overflow, a withheld booking to label + count", () => {
    const { container } = render(<NightColumns state={fixture} />);
    const today = container.querySelector(".display-night-col-today") as HTMLElement;
    expect(within(today).getByText("Jane S +1")).toBeDefined();
    // The group is not in tonight's column but appears on its arrival + stay nights.
    expect(within(today).queryByText(/Alpine Skills/)).toBeNull();
    expect(screen.getAllByText("Alpine Skills · 14").length).toBeGreaterThan(0);
  });

  it("classifies arrive / stay / depart per night and annotates the room (C1a)", () => {
    const { container } = render(<NightColumns state={fixture} />);
    const cols = container.querySelectorAll(".display-night-col");
    // Tonight: Jane arriving; Dave departing.
    expect(statusOf(cols[0] as HTMLElement, "Jane S +1", "display-night-dot")).toBe("arriving");
    expect(statusOf(cols[0] as HTMLElement, "Dave L", "display-night-dot")).toBe("departing");
    // Last night: Jane departing (checkout 15th).
    expect(statusOf(cols[2] as HTMLElement, "Jane S +1", "display-night-dot")).toBe("departing");
    // Room annotation present with allocation on.
    expect(within(cols[0] as HTMLElement).getByText("Kea")).toBeDefined();
  });

  it("hides room annotations when show-rooms is off (plain O3 look-ahead)", () => {
    const { container } = render(<NightColumns state={fixture} options={{ "show-rooms": false }} />);
    expect(container.querySelector(".display-night-room")).toBeNull();
    expect(screen.getAllByText("Jane S +1").length).toBeGreaterThan(0);
  });

  it("shows an empty-night placeholder and never throws on bad options", () => {
    const soloTonight = state({
      bookings: [row({ key: "x", guests: [{ label: "Solo P", stayStart: "2026-04-13", stayEnd: "2026-04-14" }], stayStart: "2026-04-13", stayEnd: "2026-04-14" })],
    });
    const { container } = render(<NightColumns state={soloTonight} options={{ days: "banana" }} />);
    // days falls back to 3 → three columns; the 15th is empty.
    expect(container.querySelectorAll(".display-night-col").length).toBe(3);
    expect(container.querySelector(".display-night-empty")).not.toBeNull();
  });
});

describe("StatusBoard (mock O4, closes #114)", () => {
  const fixture = state({
    bookings: [
      row({ key: "a", guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }] }),
      row({ key: "b", guests: [{ label: "Ruth K", stayStart: "2026-04-12", stayEnd: "2026-04-15" }], stayStart: "2026-04-12", stayEnd: "2026-04-15" }),
      row({ key: "c", guests: [{ label: "Dave L", stayStart: "2026-04-10", stayEnd: "2026-04-13" }], stayStart: "2026-04-10", stayEnd: "2026-04-13" }),
      row({ key: "d", guests: null, label: "Nguyen family", guestCount: 4, stayStart: "2026-04-13", stayEnd: "2026-04-15" }),
    ],
  });

  it("groups tonight's bookings into Arriving / Staying / Leaving by status", () => {
    const { container } = render(<StatusBoard state={fixture} />);
    const groups = container.querySelectorAll(".display-status-group");
    const arriving = Array.from(groups).find((g) => g.getAttribute("data-status") === "arriving") as HTMLElement;
    const staying = Array.from(groups).find((g) => g.getAttribute("data-status") === "staying") as HTMLElement;
    const leaving = Array.from(groups).find((g) => g.getAttribute("data-status") === "departing") as HTMLElement;
    expect(within(arriving).getByText("Jane S")).toBeDefined();
    expect(within(arriving).getByText("Nguyen family · 4")).toBeDefined();
    expect(within(staying).getByText("Ruth K")).toBeDefined();
    expect(within(leaving).getByText("Dave L")).toBeDefined();
  });

  it("shows a withheld booking as label + count, never invented names", () => {
    const { container } = render(<StatusBoard state={fixture} />);
    expect(container.textContent).toContain("Nguyen family · 4");
  });

  it("renders an empty-group placeholder for a status with no bookings", () => {
    const arrivalsOnly = state({
      bookings: [row({ key: "a", guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }] })],
    });
    const { container } = render(<StatusBoard state={arrivalsOnly} />);
    // Staying and Leaving are both empty.
    expect(container.querySelectorAll(".display-status-empty").length).toBe(2);
  });

  it("is room-agnostic: renders identically whether or not bed allocation is on", () => {
    const withRooms = { ...fixture, rooms: [{ id: "r1", name: "Kea" }] };
    const { container } = render(<StatusBoard state={withRooms} />);
    expect(screen.getByText("Jane S")).toBeDefined();
    expect(container.querySelectorAll(".display-status-group").length).toBe(3);
  });
});

describe("a stay with a gap, per segment (#2735)", () => {
  // Gappy holds nights 13 and 15 and NOT the 14th. On the morning of the 14th
  // they are in the lodge until midday and then gone; on the evening of the
  // 15th they are back. The envelope alone cannot say any of that — it reads as
  // one unbroken stay from the 13th to the 16th — so before #2735 every board
  // below called them "staying" on all three days.
  const gappy = (label: string) => ({
    label,
    stayStart: "2026-04-13",
    stayEnd: "2026-04-16",
    nights: ["2026-04-13", "2026-04-15"],
  });
  const gapRow = row({
    key: "gap",
    roomId: "r1",
    guests: [gappy("Gappy G")],
    stayStart: "2026-04-13",
    stayEnd: "2026-04-16",
    nights: ["2026-04-13", "2026-04-15"],
  });

  // The wall as it stands on the GAP MORNING itself — window.start = the 14th.
  // This is the day the three tonight/look-ahead panels get wrong if they read
  // the envelope, so it is where their assertions have to be made.
  const onGapMorning = (overrides: Partial<DisplayState>) =>
    state({
      window: { start: "2026-04-14", days: 3 },
      occupancy: ["2026-04-14", "2026-04-15", "2026-04-16"].map((date) => ({
        date,
        arriving: 0,
        departing: 0,
        staying: 0,
      })),
      ...overrides,
    });

  it("RoomCards: on the gap morning they are LEAVING, not staying", () => {
    // Contiguous parity is the case below; this is the one that fails without
    // the night-set branch, because the envelope says "staying" all week.
    const { container } = render(
      <RoomCards
        state={onGapMorning({ rooms: [{ id: "r1", name: "Kea" }], bookings: [gapRow] })}
      />
    );
    expect(
      statusOf(container as unknown as HTMLElement, "Gappy G", "display-room-dot")
    ).toBe("departing");
    expect(container.querySelector(".display-room-span")?.textContent).toBe(
      "leaves today"
    );
  });

  it("RoomCards: on their return night the card names THAT segment's span, not the whole envelope", () => {
    const { container } = render(
      <RoomCards
        state={state({
          window: { start: "2026-04-15", days: 1 },
          occupancy: [{ date: "2026-04-15", arriving: 0, departing: 0, staying: 1 }],
          rooms: [{ id: "r1", name: "Kea" }],
          bookings: [gapRow],
        })}
      />
    );
    // The second segment is 15 → 16. The envelope is 13 → 16, so an envelope
    // label would start the stay two days before they came back.
    expect(container.querySelector(".display-room-span")?.textContent).toBe(
      "Wed 15 – Thu 16"
    );
  });

  it("RoomCards: tonight they are arriving, exactly as an ordinary first night", () => {
    // Contiguous-parity check: on the FIRST night the night model and the
    // envelope agree, and this asserts the fix did not disturb that.
    const { container } = render(
      <RoomCards state={state({ rooms: [{ id: "r1", name: "Kea" }], bookings: [gapRow] })} />
    );
    expect(
      statusOf(container as unknown as HTMLElement, "Gappy G", "display-room-dot")
    ).toBe("arriving");
    // …and the span is the FIRST segment, 13 → 14 — not the 13 → 16 envelope,
    // which would promise a bed on the 14th that nobody booked.
    expect(container.querySelector(".display-room-span")?.textContent).toBe(
      "Mon 13 – Tue 14"
    );
  });

  it("StatusBoard: on the gap morning they are under Leaving today, with THAT segment's dates", () => {
    const { container } = render(
      <StatusBoard state={onGapMorning({ bookings: [gapRow] })} />
    );
    const departing = container.querySelector(
      '.display-status-group[data-status="departing"]'
    ) as HTMLElement;
    expect(within(departing).getByText("Gappy G")).toBeDefined();
    // "Leaving today · Gappy G · Mon 13 – Thu 16" was the contradiction: a
    // check-out two days after the day it says they leave.
    expect(departing.querySelector(".display-status-span")?.textContent).toBe(
      "Mon 13 – Tue 14"
    );
  });

  it("StatusBoard: on the first night the check-out is this segment's, not the envelope's", () => {
    const { container } = render(<StatusBoard state={state({ bookings: [gapRow] })} />);
    const arriving = container.querySelector(
      '.display-status-group[data-status="arriving"]'
    ) as HTMLElement;
    expect(arriving.querySelector(".display-status-span")?.textContent).toBe(
      "→ Tue 14"
    );
  });

  it("NightColumns: each column's check-out is its own segment's", () => {
    const { container } = render(
      <NightColumns state={state({ bookings: [gapRow] })} />
    );
    const spans = Array.from(
      container.querySelectorAll(".display-night-col")
    ).map(
      (column) => column.querySelector(".display-night-span")?.textContent ?? null
    );
    // One panel used to say "→ Thu 16" in the 13th's column and "leaves" in the
    // 14th's — contradicting itself about whether the bed was taken.
    expect(spans).toEqual(["→ Tue 14", "leaves", "→ Thu 16"]);
  });

  it("NightColumns: they leave on the gap morning and arrive again on their return night", () => {
    const { container } = render(
      <NightColumns state={state({ bookings: [gapRow] })} />
    );
    const columns = Array.from(
      container.querySelectorAll(".display-night-col")
    ) as HTMLElement[];
    expect(columns).toHaveLength(3);
    const statusIn = (column: HTMLElement) =>
      column.querySelector(".display-night-dot")?.getAttribute("data-status") ?? null;
    expect(statusIn(columns[0])).toBe("arriving"); // 13th: in tonight
    expect(statusIn(columns[1])).toBe("departing"); // 14th: here until midday
    expect(statusIn(columns[2])).toBe("arriving"); // 15th: back for the night
  });

  it("keeps a contiguous stay's three statuses exactly as they were", () => {
    // The no-regression half: the same three columns for a plain 13→15 stay.
    const { container } = render(
      <NightColumns
        state={state({
          bookings: [
            row({ key: "plain", guests: [{ label: "Anna A", stayStart: "2026-04-13", stayEnd: "2026-04-15" }] }),
          ],
        })}
      />
    );
    const statuses = Array.from(container.querySelectorAll(".display-night-col")).map(
      (column) =>
        column.querySelector(".display-night-dot")?.getAttribute("data-status") ?? null
    );
    expect(statuses).toEqual(["arriving", "staying", "departing"]);
  });
});
