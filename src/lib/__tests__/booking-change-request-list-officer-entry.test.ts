import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4030 Part B: the admin list says which pending finished-stay requests take
 * an officer's entry (those that name no change), and how far the officer's
 * member finder reaches.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  guestFindMany: vi.fn(),
  gate: vi.fn(),
  user: { id: "officer-1" } as Record<string, unknown>,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => ({ ok: true, session: { user: mocks.user } }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingChangeRequest: {
      findMany: (...args: unknown[]) => mocks.findMany(...args),
      count: async () => 3,
    },
    bookingGuest: { findMany: (...args: unknown[]) => mocks.guestFindMany(...args) },
  },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));
vi.mock("@/lib/member-guest-find-service", () => ({
  loadMemberGuestFindGate: (...args: unknown[]) => mocks.gate(...args),
}));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminAreaAccess: (user: { membershipView?: boolean }) => user.membershipView === true,
}));

import { GET } from "@/app/api/admin/booking-change-requests/route";

const original = { checkIn: "2026-06-10", checkOut: "2026-06-14", guests: [{ id: "g1" }] };
const freeText = {
  original,
  requested: { addGuests: [], removeGuests: [], guestStayRanges: [], requestedEffectiveDate: "2026-06-10" },
};
const structured = {
  original,
  requested: {
    addGuests: [{ firstName: "A", lastName: "B", ageTier: "ADULT", isMember: false }],
    removeGuests: [],
    guestStayRanges: [],
  },
};
const finished = {
  checkIn: new Date("2026-06-10T00:00:00.000Z"),
  checkOut: new Date("2026-06-14T00:00:00.000Z"),
  status: "COMPLETED",
};
const running = { ...finished, checkOut: new Date("2026-07-02T00:00:00.000Z"), status: "PAID" };

const at = (night: string) => new Date(`${night}T00:00:00.000Z`);

/** A booking guest as the route's second query reads it: range and night rows. */
function liveGuest(id: string, nights: string[], bookingId = "booking-1") {
  return {
    id,
    bookingId,
    stayStart: at("2026-06-10"),
    stayEnd: at("2026-06-14"),
    nights: nights.map((night) => ({ stayDate: at(night) })),
  };
}

function row(id: string, requestedChanges: unknown, booking: object, status = "REQUESTED") {
  // #4533 review: the list reads the codes a booking carries, for the card's promo entry.
  return { id, status, requestedChanges, booking: { promoRedemptions: [], ...booking } };
}

async function list() {
  const response = await GET(new NextRequest("http://localhost/api/admin/booking-change-requests?status=ALL"));
  return response.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: "officer-1" };
  mocks.gate.mockResolvedValue({ ok: true, settings: {} });
  mocks.guestFindMany.mockResolvedValue([]);
});

describe("GET /api/admin/booking-change-requests — acceptsOfficerGuests (#4030)", () => {
  it("is true only for a pending free-text request on a finished stay", async () => {
    mocks.findMany.mockResolvedValue([
      row("free-finished", freeText, finished),
      row("structured-finished", structured, finished),
      row("free-running", freeText, running),
      row("free-approved", freeText, finished, "APPROVED"),
    ]);
    const body = await list();
    expect(
      Object.fromEntries(body.data.map((r: { id: string; acceptsOfficerGuests: boolean }) => [r.id, r.acceptsOfficerGuests])),
    ).toEqual({
      "free-finished": true,
      "structured-finished": false,
      "free-running": false,
      "free-approved": false,
    });
  });

  it("offers the finder by email to any officer, and by name only with the membership directory", async () => {
    mocks.findMany.mockResolvedValue([row("free-finished", freeText, finished)]);
    expect((await list()).memberGuestFind).toEqual({ openSearchEnabled: false });
    mocks.user = { id: "officer-1", membershipView: true };
    expect((await list()).memberGuestFind).toEqual({ openSearchEnabled: true });
  });

  it("offers no finder when the club's member-guest module is off, or no card takes an entry", async () => {
    mocks.findMany.mockResolvedValue([row("free-finished", freeText, finished)]);
    mocks.gate.mockResolvedValue({ ok: false });
    expect((await list()).memberGuestFind).toBeNull();
    mocks.gate.mockClear();
    mocks.findMany.mockResolvedValue([row("structured-finished", structured, finished)]);
    expect((await list()).memberGuestFind).toBeNull();
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it("reads only the member ids of the booking's guests, for the finder", async () => {
    mocks.findMany.mockResolvedValue([]);
    await list();
    const [args] = mocks.findMany.mock.calls[0] as [
      { include: { booking: { select: { guests: unknown } } } },
    ];
    expect(args.include.booking.select.guests).toEqual({
      where: { memberId: { not: null } },
      select: { memberId: true },
    });
  });

  it("returns the guests' member ids only on rows that take an officer's entry (review S7)", async () => {
    const withGuests = (booking: object) => ({ ...booking, guests: [{ memberId: "member-7" }] });
    mocks.findMany.mockResolvedValue([
      row("free-finished", freeText, withGuests(finished)),
      row("structured-finished", structured, withGuests(finished)),
    ]);
    const body = await list();
    const byId = Object.fromEntries(
      body.data.map((r: { id: string; booking: Record<string, unknown> }) => [r.id, r.booking]),
    );
    expect(byId["free-finished"].guests).toEqual([{ memberId: "member-7" }]);
    expect(byId["structured-finished"]).not.toHaveProperty("guests");
  });
});

describe("GET /api/admin/booking-change-requests — requestedGuestNights (#4088)", () => {
  it("answers each guest's requested nights, as runs, for the card", async () => {
    mocks.findMany.mockResolvedValue([
      row(
        "grid",
        {
          original: { ...original, guests: [{ id: "g1", firstName: "Jo", lastName: "Bloggs", stayStart: "2026-06-10", stayEnd: "2026-06-14" }] },
          requested: { guestStayRanges: [{ guestId: "g1", nights: ["2026-06-10", "2026-06-11", "2026-06-13"] }] },
        },
        finished,
      ),
      row("free-finished", freeText, finished),
    ]);
    const body = await list();
    expect(body.data.map((r: { requestedGuestNights: unknown }) => r.requestedGuestNights)).toEqual([
      [
        {
          name: "Jo Bloggs",
          runs: [
            { firstNight: "2026-06-10", lastNight: "2026-06-11" },
            { firstNight: "2026-06-13", lastNight: "2026-06-13" },
          ],
          nightCount: 3,
          added: false,
          unchanged: false,
          fillsGaps: false,
        },
      ],
      [],
    ]);
  });
});

describe("GET /api/admin/booking-change-requests — a repeated range on a gapped guest (#4157)", () => {
  // Sent in date-range mode before #4088 stored night rows: the snapshot has
  // the guest's own dates and no nights. The request repeats their 10-14 June.
  const repeated = {
    original: {
      ...original,
      guests: [{ id: "g1", firstName: "Jo", lastName: "Bloggs", stayStart: "2026-06-10", stayEnd: "2026-06-14" }],
    },
    requested: {
      addGuests: [{ firstName: "A", lastName: "B", ageTier: "ADULT", isMember: false }],
      guestStayRanges: [{ guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14" }],
    },
  };
  // Sent since #4088: the snapshot records the guest's 10, 11 and 13 June.
  const snapshotted = {
    ...repeated,
    original: {
      ...repeated.original,
      guests: [{ ...repeated.original.guests[0], nights: ["2026-06-10", "2026-06-11", "2026-06-13"] }],
    },
  };
  const booking = { ...finished, id: "booking-1" };
  const GAPPED_RUNS = [
    { firstNight: "2026-06-10", lastNight: "2026-06-11" },
    { firstNight: "2026-06-13", lastNight: "2026-06-13" },
  ];
  const keptCard = {
    name: "Jo Bloggs",
    runs: GAPPED_RUNS,
    nightCount: 3,
    added: false,
    unchanged: true,
    fillsGaps: false,
  };
  const asAskedCard = {
    name: "Jo Bloggs",
    runs: [{ firstNight: "2026-06-10", lastNight: "2026-06-13" }],
    nightCount: 4,
    added: false,
    unchanged: false,
    fillsGaps: false,
  };
  const nightsOf = async (status: string, requestedChanges: unknown, live: string[]) => {
    mocks.guestFindMany.mockResolvedValue([liveGuest("g1", live)]);
    mocks.findMany.mockResolvedValue([row("repeated", requestedChanges, booking, status)]);
    return (await list()).data[0].requestedGuestNights[0];
  };

  it("reads a pending request against the guest's live nights, the source approval keeps", async () => {
    // The guest really holds 10, 11 and 13 June; the snapshot recorded none.
    expect(
      await nightsOf("REQUESTED", repeated, ["2026-06-10", "2026-06-11", "2026-06-13"]),
      "INV-REQ-012: the card must show the nights approval keeps",
    ).toEqual(keptCard);
    // Loaded for the pending row's booking only.
    expect(mocks.guestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookingId: { in: ["booking-1"] } } }),
    );
  });

  it("loads no guest night rows for a list of decided requests", async () => {
    await nightsOf("APPROVED", snapshotted, ["2026-06-10"]);
    await nightsOf("REJECTED", snapshotted, ["2026-06-10"]);
    expect(mocks.guestFindMany).not.toHaveBeenCalled();
  });

  // The decided cases below are given live rows that DIFFER from the snapshot
  // (every night, 10-13 June): a decided row read against them would show the
  // range as unchanged with no gap, and fail.
  const EVERY_NIGHT = ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"];

  it("describes an approval that recorded the kept nights exactly as recorded", async () => {
    const recorded = {
      ...snapshotted,
      keptNights: [{ guestId: "g1", nights: ["2026-06-10", "2026-06-11", "2026-06-13"] }],
    };
    expect(await nightsOf("APPROVED", recorded, EVERY_NIGHT), "INV-REQ-012: a recorded approval kept them").toEqual(
      keptCard,
    );
    // Even where the snapshot recorded no nights: the record is what was kept.
    expect(await nightsOf("APPROVED", { ...repeated, keptNights: recorded.keptNights }, EVERY_NIGHT)).toEqual(
      keptCard,
    );
  });

  it("describes an approval from before this release as asked, claiming neither outcome", async () => {
    // No record: it may have filled the gap (an approval before this release)
    // or applied nothing, so the card says only what was asked.
    expect(
      await nightsOf("APPROVED", snapshotted, EVERY_NIGHT),
      "INV-REQ-012: an unrecorded approval is not reread",
    ).toEqual(asAskedCard);
    // And "no change" only where the snapshot holds the guest's night rows:
    // with none, the card cannot know the guest had no gaps.
    expect(await nightsOf("APPROVED", repeated, EVERY_NIGHT)).toMatchObject({ unchanged: false, fillsGaps: false });
    const fullSnapshot = {
      ...repeated,
      original: { ...repeated.original, guests: [{ ...repeated.original.guests[0], nights: EVERY_NIGHT }] },
    };
    expect(await nightsOf("APPROVED", fullSnapshot, EVERY_NIGHT)).toMatchObject({ unchanged: true, nightCount: 4 });
  });

  it("describes a declined request as a pending one reads, against the snapshot", async () => {
    // Nothing was applied: the kept nights the snapshot records, never the live rows.
    expect(
      await nightsOf("REJECTED", snapshotted, EVERY_NIGHT),
      "INV-REQ-012: a declined row reads its snapshot",
    ).toEqual(keptCard);
  });
});
