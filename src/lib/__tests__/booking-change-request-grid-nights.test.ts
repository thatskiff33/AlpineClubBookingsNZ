import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4088: a change request sent from the booking editor's per-night grid keeps
 * each guest's night set (#713). The route's schema used to strip
 * `guestStayRanges[].nights` and `addGuests[].nights`, so the stored request
 * lost the member's nights and approval reset every guest to the booking's
 * dates. Here: the route keeps them, the stored request reads them back onto
 * the canonical batch input, and a range-only request is unchanged.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingChangeRequestFindFirst: vi.fn(),
  bookingChangeRequestCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    member: { findMany: async () => [] },
    bookingChangeRequest: {
      findFirst: (...args: unknown[]) => mocks.bookingChangeRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.bookingChangeRequestCreate(...args),
    },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimiters: { bookingChangeRequest: { id: "booking-change-request" } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/club-time/server", () => ({
  // The club's day: the stay below (30 June to 3 July) is under way.
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));

import { POST } from "@/app/api/bookings/[id]/change-requests/route";
import {
  CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE,
  CHANGE_REQUEST_DUPLICATE_GUEST_RANGE_MESSAGE,
} from "@/lib/booking-change-request-guests";
import { GUEST_NIGHT_INVALID_MESSAGE } from "@/lib/booking-guest-stay-range-input";
import { changeRequestDeltaSchema } from "@/lib/booking-change-request-input";
import {
  changeRequestProposalBatchInput,
  describeRequestedGuestNights,
  lockedPeriodRequestToBatchInput,
  storedLockedPeriodRequestSchema,
  storedRequestNamesNoChange,
} from "@/lib/booking-change-request-stored";

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const STAY_NIGHTS = ["2026-06-30", "2026-07-01", "2026-07-02"];

function booking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAID",
    checkIn: day("2026-06-30"),
    checkOut: day("2026-07-03"),
    lodgeId: "lodge-1",
    guests: [
      {
        id: "guest-1",
        firstName: "Alex",
        lastName: "Example",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: day("2026-06-30"),
        stayEnd: day("2026-07-03"),
        nights: STAY_NIGHTS.map((night) => ({ stayDate: day(night) })),
      },
    ],
    member: { id: "member-1", firstName: "Alex", lastName: "Example", email: "alex@example.com" },
    organisation: null,
    payment: null,
  };
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/bookings/booking-1/change-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

/** What the route stored on its one create, as the column holds it. */
function storedChanges(): unknown {
  expect(mocks.bookingChangeRequestCreate).toHaveBeenCalledTimes(1);
  const { data } = mocks.bookingChangeRequestCreate.mock.calls[0][0] as {
    data: { requestedChanges: unknown };
  };
  // Through JSON, as the database round-trips it.
  return JSON.parse(JSON.stringify(data.requestedChanges));
}

const grandchild = {
  firstName: "Ari",
  lastName: "Example",
  ageTier: "CHILD",
  isMember: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
  });
  mocks.bookingFindUnique.mockResolvedValue(booking());
  mocks.bookingChangeRequestFindFirst.mockResolvedValue(null);
  mocks.bookingChangeRequestCreate.mockImplementation(async (args: { data: unknown }) => ({
    id: "request-1",
    status: "REQUESTED",
    ...(args.data as object),
  }));
});

describe("POST /api/bookings/[id]/change-requests keeps a grid request's night sets (#4088)", () => {
  it("stores an existing guest's night set, and the nights each guest held", async () => {
    // The grid drops the guest's 1 July night: a gap, so the dates do not move.
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedChanges() as {
      original: { guests: Array<Record<string, unknown>> };
      requested: { guestStayRanges: unknown };
    };
    expect(stored.requested.guestStayRanges).toEqual([
      { guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] },
    ]);
    expect(stored.original.guests[0]).toMatchObject({
      id: "guest-1",
      stayStart: "2026-06-30",
      stayEnd: "2026-07-03",
      nights: STAY_NIGHTS,
    });
  });

  it("stores an added guest's night set, and reads its first night as where it starts", async () => {
    const response = await post({
      addGuests: [{ ...grandchild, nights: ["2026-06-30", "2026-07-02"] }],
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedChanges() as { requested: { addGuests: unknown } };
    expect(stored.requested.addGuests).toEqual([
      expect.objectContaining({ firstName: "Ari", nights: ["2026-06-30", "2026-07-02"] }),
    ]);

    // From tomorrow only, it is an ordinary edit, not a locked-period change:
    // the first night decides, as Date In does.
    mocks.bookingChangeRequestCreate.mockClear();
    const tomorrow = await post({ addGuests: [{ ...grandchild, nights: ["2026-07-02"] }] });
    expect(tomorrow.status).toBe(400);
    expect((await tomorrow.json()).error).toMatch(/past-night changes that require admin review/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("stores a grid request that moves the dates with the nights that moved them", async () => {
    const response = await post({
      checkIn: "2026-06-29",
      guestStayRanges: [
        { guestId: "guest-1", nights: ["2026-06-29", "2026-06-30", "2026-07-02"] },
      ],
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedChanges() as { requested: Record<string, unknown> };
    expect(stored.requested).toMatchObject({
      checkIn: "2026-06-29",
      guestStayRanges: [
        { guestId: "guest-1", nights: ["2026-06-29", "2026-06-30", "2026-07-02"] },
      ],
    });
  });

  it("counts a night set the same size as the guest's own, but on other nights, as a change", async () => {
    // The guest holds 30 June and 2 July; the request asks for 30 June and
    // 1 July. Same count, no date moved: only the nights tell them apart.
    const sparse = booking();
    sparse.guests[0].nights = ["2026-06-30", "2026-07-02"].map((night) => ({ stayDate: day(night) }));
    mocks.bookingFindUnique.mockResolvedValue(sparse);
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30", "2026-07-01"] }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  });

  it("does not count a night set repeating the guest's own nights as a change", async () => {
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: [...STAY_NIGHTS].reverse() }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("STRUCTURED_CHANGE_REQUIRED");
  });

  it("reads night sets by the editor's own rules", async () => {
    const malformed = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: ["30/06/2026"] }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(malformed.status).toBe(400);
    // Said in the member's terms, not as a schema failure.
    expect((await malformed.json()).error).toBe(GUEST_NIGHT_INVALID_MESSAGE);

    // Only a night that is not a date gets that sentence: a list that is too
    // long, or `nights` that is not a list, is an ordinary validation failure.
    const tooMany = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: Array.from({ length: 371 }, () => "2026-06-30") }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toBe("Validation failed");
    const notAList = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: "2026-06-30" }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(notAList.status).toBe(400);
    expect((await notAList.json()).error).toBe("Validation failed");

    // An added guest's nights must fall inside the stay, as their dates must.
    const outside = await post({
      addGuests: [{ ...grandchild, nights: ["2026-06-30", "2026-07-03"] }],
    });
    expect(outside.status).toBe(400);
    expect((await outside.json()).error).toMatch(/must fall within the stay \(2026-06-30 to 2026-07-03\)/);

    // A date move the night set does not reach is refused, as for ranges.
    const unreached = await post({
      checkIn: "2026-06-28",
      guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-29", "2026-06-30"] }],
    });
    expect(unreached.status).toBe(400);
    expect((await unreached.json()).error).toBe(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("names the guest in a refusal, not their position in the list", async () => {
    const existing = await post({
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-07-02", stayEnd: "2026-07-01" }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(existing.status).toBe(400);
    expect((await existing.json()).error).toBe("Alex Example: Date Out must be after Date In.");

    const added = await post({
      addGuests: [{ ...grandchild, stayStart: "2026-06-30", stayEnd: "2026-06-30" }],
    });
    expect(added.status).toBe(400);
    expect((await added.json()).error).toBe("Ari Example: Date Out must be after Date In.");
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/bookings/[id]/change-requests judges the ranges approval applies (#4157)", () => {
  it("refuses a request that names one guest's dates twice, in the member's words", async () => {
    // Crafted: the guest's own dates, then the same guest with no dates, and
    // a later check-out. Approval applies one entry per guest, so this says
    // two things; it is refused before anything is stored.
    const response = await post({
      checkOut: "2026-07-04",
      guestStayRanges: [
        { guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-04" },
        { guestId: "guest-1" },
      ],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error, "INV-REQ-012: a guest named twice is refused").toBe(
      CHANGE_REQUEST_DUPLICATE_GUEST_RANGE_MESSAGE,
    );
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("stores only the entries approval applies: a dateless entry asks for nothing", async () => {
    const response = await post({
      addGuests: [grandchild],
      guestStayRanges: [{ guestId: "guest-1" }],
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedChanges() as { requested: { guestStayRanges: unknown } };
    expect(stored.requested.guestStayRanges, "INV-REQ-012: only applied entries are stored").toEqual([]);
  });

  it("still refuses a one-bound entry, rather than dropping it", async () => {
    const response = await post({
      addGuests: [grandchild],
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30" }],
    });
    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });
});

describe("the stored grid request, read back for approval (#4088)", () => {
  const live = { checkIn: day("2026-06-30"), checkOut: day("2026-07-03") };

  it("round-trips each guest's night set onto the canonical batch input", async () => {
    const response = await post({
      addGuests: [{ ...grandchild, nights: ["2026-06-30", "2026-07-02"] }],
      guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] }],
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedLockedPeriodRequestSchema.parse(storedChanges());
    const input = lockedPeriodRequestToBatchInput(stored, live);
    expect(input?.guestStayRanges).toEqual([
      { guestId: "guest-1", stayStart: null, stayEnd: null, nights: ["2026-06-30", "2026-07-02"] },
    ]);
    expect(input?.addGuests).toEqual([
      expect.objectContaining({ firstName: "Ari", nights: ["2026-06-30", "2026-07-02"] }),
    ]);
  });

  it("reads a night set repeating the guest's stored nights as no change", () => {
    const requestedChanges = {
      original: {
        checkIn: "2026-06-30",
        checkOut: "2026-07-03",
        guests: [{ id: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03", nights: STAY_NIGHTS }],
      },
      requested: {
        guestStayRanges: [{ guestId: "guest-1", nights: STAY_NIGHTS }],
      },
    };
    expect(storedRequestNamesNoChange(requestedChanges, live)).toBe(true);
    // Before #4088 a row stored no nights: a night set is then compared with
    // the guest's stored range, every night of it.
    const older = {
      ...requestedChanges,
      original: {
        ...requestedChanges.original,
        guests: [{ id: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03" }],
      },
    };
    expect(storedRequestNamesNoChange(older, live)).toBe(true);
    const gap = {
      ...requestedChanges,
      requested: { guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] }] },
    };
    expect(storedRequestNamesNoChange(gap, live)).toBe(false);
  });

  it("maps a range-only request exactly as before: bounds, and no nights", async () => {
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-01" }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status).toBe(201);
    const stored = storedLockedPeriodRequestSchema.parse(storedChanges());
    expect(lockedPeriodRequestToBatchInput(stored, live)).toEqual({
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-01" }],
    });
  });
});

describe("each guest's requested nights, for the officer's card (#4088)", () => {
  it("lists a grid night set as runs, an added guest's nights, and the guest's name", async () => {
    const response = await post({
      addGuests: [{ ...grandchild, nights: ["2026-06-30", "2026-07-01"] }, { ...grandchild, firstName: "Bo" }],
      guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] }],
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    expect(describeRequestedGuestNights(storedChanges(), { status: "REQUESTED" })).toEqual([
      {
        name: "Alex Example",
        runs: [
          { firstNight: "2026-06-30", lastNight: "2026-06-30" },
          { firstNight: "2026-07-02", lastNight: "2026-07-02" },
        ],
        nightCount: 2,
        added: false,
        unchanged: false,
        fillsGaps: false,
      },
      {
        name: "Ari Example",
        runs: [{ firstNight: "2026-06-30", lastNight: "2026-07-01" }],
        nightCount: 2,
        added: true,
        unchanged: false,
        fillsGaps: false,
      },
      // No nights of their own: the whole stay.
      { name: "Bo Example", runs: [], nightCount: null, added: true, unchanged: false, fillsGaps: false },
    ]);
  });

  it("shows a two-bound range as Date In to the last night, and marks nights the guest already holds", () => {
    const original = {
      checkIn: "2026-06-30",
      checkOut: "2026-07-03",
      guests: [
        { id: "guest-1", firstName: "Alex", lastName: "Example", stayStart: "2026-06-30", stayEnd: "2026-07-03", nights: STAY_NIGHTS },
        { id: "guest-2", firstName: "Sam", lastName: "Example", stayStart: "2026-06-30", stayEnd: "2026-07-03" },
      ],
    };
    expect(
      describeRequestedGuestNights({
        original,
        requested: {
          guestStayRanges: [
            { guestId: "guest-1", nights: STAY_NIGHTS },
            { guestId: "guest-2", stayStart: "2026-06-30", stayEnd: "2026-07-01" },
          ],
        },
      }, { status: "REQUESTED" }),
    ).toEqual([
      {
        name: "Alex Example",
        runs: [{ firstNight: "2026-06-30", lastNight: "2026-07-02" }],
        nightCount: 3,
        added: false,
        unchanged: true,
        fillsGaps: false,
      },
      {
        name: "Sam Example",
        runs: [{ firstNight: "2026-06-30", lastNight: "2026-06-30" }],
        nightCount: 1,
        added: false,
        unchanged: false,
        fillsGaps: false,
      },
    ]);
    // A guest the same request removes is not listed: their range is moot.
    expect(
      describeRequestedGuestNights({
        original,
        requested: {
          removeGuests: [{ id: "guest-2" }],
          guestStayRanges: [{ guestId: "guest-2", stayStart: "2026-06-30", stayEnd: "2026-07-01" }],
        },
      }, { status: "REQUESTED" }),
    ).toEqual([]);
    // An unreadable row (a night that is not a day) lists nobody.
    expect(
      describeRequestedGuestNights({
        original,
        requested: { guestStayRanges: [{ guestId: "guest-1", nights: ["not-a-night"] }] },
      }, { status: "REQUESTED" }),
    ).toEqual([]);
  });

  it("marks a guest with gaps whose request repeats their Date In and Date Out as no change, listing the nights they keep (#4157)", () => {
    // Approval keeps the nights the guest holds where their range only repeats
    // their own dates (owner decision on #4157), so 1 July is neither added
    // nor charged, and the card shows the two nights that stand.
    const requestedChanges = {
      original: {
        checkIn: "2026-06-30",
        checkOut: "2026-07-03",
        guests: [
          {
            id: "guest-1",
            firstName: "Alex",
            lastName: "Example",
            stayStart: "2026-06-30",
            stayEnd: "2026-07-03",
            nights: ["2026-06-30", "2026-07-02"],
          },
        ],
      },
      requested: { guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03" }] },
    };
    expect(describeRequestedGuestNights(requestedChanges, { status: "REQUESTED" })).toEqual([
      {
        name: "Alex Example",
        runs: [
          { firstNight: "2026-06-30", lastNight: "2026-06-30" },
          { firstNight: "2026-07-02", lastNight: "2026-07-02" },
        ],
        nightCount: 2,
        added: false,
        unchanged: true,
        fillsGaps: false,
      },
    ]);
    // A range that really moves a bound re-spreads the guest's nights: every
    // night of it, the gap included, which the card still flags.
    const moved = {
      ...requestedChanges,
      requested: { guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-04" }] },
    };
    expect(describeRequestedGuestNights(moved, { status: "REQUESTED" })).toEqual([
      {
        name: "Alex Example",
        runs: [{ firstNight: "2026-06-30", lastNight: "2026-07-03" }],
        nightCount: 4,
        added: false,
        unchanged: false,
        fillsGaps: true,
      },
    ]);
    // A snapshot from before names were stored still reads as a sentence.
    const unnamed = {
      ...requestedChanges,
      original: {
        ...requestedChanges.original,
        guests: [{ id: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03" }],
      },
    };
    expect(describeRequestedGuestNights(unnamed, { status: "REQUESTED" })[0]).toMatchObject({ name: "A guest on the booking" });
    // A range that only covers nights the guest already holds fills nothing.
    const narrow = {
      ...requestedChanges,
      requested: { guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-07-02", stayEnd: "2026-07-03" }] },
    };
    expect(describeRequestedGuestNights(narrow, { status: "REQUESTED" })[0]).toMatchObject({ fillsGaps: false, unchanged: false });
  });
});

describe("the card's estimate reads a proposal as submission stores it (#4203, INV-SSOT-001)", () => {
  it("maps the route's stored row and the unstored proposal onto the same batch input", async () => {
    const base = booking();
    const gapped = ["2026-06-30", "2026-07-02"];
    const party = {
      ...base,
      guests: [
        base.guests[0],
        { ...base.guests[0], id: "guest-2", firstName: "Bo", memberId: null, isMember: false },
        {
          ...base.guests[0],
          id: "guest-3",
          firstName: "Cy",
          memberId: null,
          isMember: false,
          nights: gapped.map((night) => ({ stayDate: day(night) })),
        },
      ],
    };
    mocks.bookingFindUnique.mockResolvedValue(party);
    const proposal = {
      checkOut: "2026-07-04",
      addGuests: [{ ...grandchild, nights: ["2026-07-01", "2026-07-03"] }],
      // Named twice: stored once, in booking order.
      removeGuestIds: ["guest-2", "guest-2"],
      guestStayRanges: [
        // A dateless entry approval ignores, and a repeat of a gapped guest's bounds (kept nights, #4157).
        { guestId: "guest-1" },
        { guestId: "guest-3", stayStart: "2026-06-30", stayEnd: "2026-07-03" },
      ],
    };
    const response = await post(proposal);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedLockedPeriodRequestSchema.parse(storedChanges());
    expect(stored.requested.removeGuests).toEqual([expect.objectContaining({ id: "guest-2" })]);
    const fromRoute = lockedPeriodRequestToBatchInput(stored, party);
    expect(fromRoute?.guestStayRanges).toEqual([
      { guestId: "guest-3", stayStart: "2026-06-30", stayEnd: "2026-07-03", nights: gapped },
    ]);
    // Parsed as the estimate's route parses it.
    expect(changeRequestProposalBatchInput(party, changeRequestDeltaSchema.parse(proposal))).toEqual(fromRoute);
  });
});
