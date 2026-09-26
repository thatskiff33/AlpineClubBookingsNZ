/**
 * Tolerant admin READS of a stored booking-request guest list (#2342).
 *
 * The bug: the admin Booking Requests queue's **All** filter widened the query
 * past the default QUEUE statuses and pulled in a historical CONVERTED school
 * request whose stored guests carried `lastName: ""`. The serialiser parsed
 * every row strictly, the empty surname failed `nameField`, the parse threw,
 * and the WHOLE page of results 500'd — one malformed row taking down the
 * entire view.
 *
 * The contract these tests pin:
 *   - a malformed row renders (flagged, names shown as saved) in the LIST
 *     payload and in the shared per-request serialiser, instead of throwing;
 *   - each stored blob is flagged SEPARATELY, so a payload never claims a
 *     failure that did not happen;
 *   - a well-formed row's payload is unchanged, flag and all (there is no flag);
 *   - WRITES still reject an empty name, and the strict reader every
 *     conversion/approval path uses still throws on a malformed stored row.
 *
 * The mirror half — that every ACTING path refuses a flagged row, with the
 * plain-English message an officer sees — lives in
 * `booking-request-malformed-stored-data.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { BookingRequest } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    bookingRequestQuote: { findMany: vi.fn().mockResolvedValue([]) },
    member: { findMany: vi.fn().mockResolvedValue([]) },
    lodge: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// Import-graph trims: the serialiser under test is pure, but it lives in the
// module that also owns the create/approve/decline pipeline.
vi.mock("@/lib/email", () => ({
  sendBookingRequestVerificationEmail: vi.fn(),
  sendAdminBookingRequestPendingEmail: vi.fn(),
  sendBookingRequestApprovedEmail: vi.fn(),
  sendBookingRequestDeclinedEmail: vi.fn(),
  sendAdminOwnerSubstitutionAlert: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: vi.fn() }));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(20),
  getDefaultLodgeCapacity: vi.fn().mockResolvedValue(20),
  // Completes the mock: `club-identity.ts` imports this constant (reached
  // transitively via `xero-invoice-payments`), and an incomplete factory throws
  // "No FALLBACK_LODGE_CAPACITY export" once a schema change perturbs the
  // module-eval order enough to load club-identity under this mock.
  FALLBACK_LODGE_CAPACITY: 20,
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadSchoolGroupSoftCap: vi.fn().mockResolvedValue(25),
}));
vi.mock("@/lib/cancellation", () => ({ getNonMemberHoldDays: vi.fn().mockResolvedValue(2) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/booking-request-quotes", () => ({
  parseBookingRequestQuoteOptions: vi.fn(() => []),
  // The list route reads a row's latest quote through the tolerant reader
  // (#2342). No row in this file carries a quote, so the stub is never called;
  // the real reader's tolerance is exercised in
  // `booking-request-malformed-stored-data.test.ts`, which imports the module
  // for real.
  readBookingRequestQuoteOptionsForDisplay: vi.fn(() => ({
    options: [],
    needsAttention: false,
  })),
}));

const guards = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: guards.requireAdmin }));

const limits = vi.hoisted(() => ({ applyRateLimit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: limits.applyRateLimit,
  getClientIp: () => "127.0.0.1",
  rateLimiters: { bookingRequest: { id: "booking-request", limit: 5, windowSeconds: 3600 } },
}));

import {
  bookingRequestGuestSchema,
  parseBookingRequestGuests,
  readBookingRequestGuestsForDisplay,
  serializeBookingRequestForAdmin,
  UNREADABLE_STORED_GUESTS_MESSAGE,
} from "@/lib/booking-request";
import { nameField } from "@/lib/zod-helpers";
import { prisma } from "@/lib/prisma";
import { GET as listRequests } from "@/app/api/admin/booking-requests/route";
import { POST as priceRequest } from "@/app/api/admin/booking-requests/[id]/price/route";
import { POST as submitPublicRequest } from "@/app/api/booking-requests/route";

const db = prisma as unknown as {
  bookingRequest: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

const HEALTHY_GUESTS = [
  { firstName: "Tina", lastName: "Tramper", ageTier: "ADULT" },
  { firstName: "Theo", lastName: "Tramper", ageTier: "CHILD" },
];

/**
 * The exact stored shape that produced the 500: the pre-#2342 demo seed's
 * CONVERTED school request, whose children carried an empty surname.
 */
const MALFORMED_GUESTS = [
  { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
  { firstName: "School Child 1", lastName: "", ageTier: "YOUTH" },
  { firstName: "School Child 2", lastName: "", ageTier: "YOUTH" },
];

function row(overrides: Record<string, unknown> = {}): BookingRequest & {
  lodge?: { name: string } | null;
} {
  return {
    id: "req-good",
    type: "GENERAL",
    status: "VERIFIED",
    lodgeId: null,
    lodge: null,
    exclusivityRequested: false,
    requestedByMemberId: null,
    schoolName: null,
    teachers: null,
    cateringPreference: null,
    linkedGuestMembers: null,
    contactFirstName: "Tina",
    contactLastName: "Tramper",
    contactEmail: "tina@example.com",
    contactPhone: null,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    guests: HEALTHY_GUESTS,
    message: null,
    indicativePriceCents: null,
    priceCents: null,
    verifiedAt: null,
    pricedAt: null,
    pricedByMemberId: null,
    reviewedAt: null,
    reviewedByMemberId: null,
    declineReason: null,
    convertedBookingId: null,
    attendeesConfirmedAt: null,
    convertedMemberId: null,
    heldBookingId: null,
    acceptedQuoteId: null,
    acceptedQuoteOptionId: null,
    acceptedPriceCents: null,
    acceptedAt: null,
    responseMessage: null,
    responseMessageAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as BookingRequest & { lodge?: { name: string } | null };
}

const badRow = (overrides: Record<string, unknown> = {}) =>
  row({
    id: "req-bad",
    type: "SCHOOL",
    status: "CONVERTED",
    guests: MALFORMED_GUESTS,
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  guards.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  limits.applyRateLimit.mockResolvedValue(null);
});

describe("readBookingRequestGuestsForDisplay (#2342)", () => {
  it("returns a well-formed list exactly as the strict reader does, unflagged", () => {
    const display = readBookingRequestGuestsForDisplay(HEALTHY_GUESTS);

    expect(display.needsAttention).toBe(false);
    expect(display.guests).toEqual(parseBookingRequestGuests(HEALTHY_GUESTS));
  });

  it("shows the stored names as saved and flags the row when the list fails the schema", () => {
    const display = readBookingRequestGuestsForDisplay(MALFORMED_GUESTS);

    expect(display.needsAttention).toBe(true);
    expect(display.guests).toEqual([
      { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
      { firstName: "School Child 1", lastName: "", ageTier: "YOUTH" },
      { firstName: "School Child 2", lastName: "", ageTier: "YOUTH" },
    ]);
  });

  it("flags — and never throws on — stored JSON that is not a guest list at all", () => {
    expect(readBookingRequestGuestsForDisplay(null)).toEqual({
      guests: [],
      needsAttention: true,
    });
    expect(readBookingRequestGuestsForDisplay({ nope: true })).toEqual({
      guests: [],
      needsAttention: true,
    });
    // Non-string cells have no sensible rendering, so they become empty cells
    // rather than "[object Object]" — but the row still renders.
    expect(
      readBookingRequestGuestsForDisplay([{ firstName: 7, lastName: null, ageTier: {} }]),
    ).toEqual({
      guests: [{ firstName: "", lastName: "", ageTier: "" }],
      needsAttention: true,
    });
  });

  it("strips CR/LF from salvaged names, which bypassed nameField's strip", () => {
    const display = readBookingRequestGuestsForDisplay([
      { firstName: "Eve\r\nBcc: attacker@example.com", lastName: "", ageTier: "ADULT" },
    ]);

    expect(display.needsAttention).toBe(true);
    expect(display.guests[0].firstName).toBe("Eve Bcc: attacker@example.com");
  });

  it("caps salvaged text at nameField's 100 characters", () => {
    // A blob that skipped the schema can hold a name of any length, and the
    // queue renders it into a badge. Full parity with the persistence-time
    // cleanup: collapse CR/LF, then cap at 100 (#2342).
    const display = readBookingRequestGuestsForDisplay([
      { firstName: "x".repeat(400), lastName: "", ageTier: "ADULT" },
    ]);

    expect(display.needsAttention).toBe(true);
    expect(display.guests[0].firstName).toHaveLength(100);
    // Length and emptiness are NOT re-validated — the point is to show what is
    // stored — so the empty surname survives as an empty cell.
    expect(display.guests[0].lastName).toBe("");
  });
});

describe("serializeBookingRequestForAdmin (#2342)", () => {
  it("leaves a well-formed row's payload untouched and adds no flag", () => {
    const serialized = serializeBookingRequestForAdmin(row());

    expect(serialized.guests).toEqual(HEALTHY_GUESTS);
    expect("guestDataNeedsAttention" in serialized).toBe(false);
  });

  it("flags ONLY the links — not the guests — on an unreadable linked-member list", () => {
    // The other stored JSON blob this payload parses, and the other way one bad
    // row could 500 the queue. It falls back to NO links: a guest index or
    // member id we cannot trust is worse than none.
    //
    // The two flags are separate on purpose (#2342 review finding D): with one
    // OR'd flag this payload also claimed the GUEST list was unreadable, and
    // the panel then told the officer to distrust names that had validated.
    const serialized = serializeBookingRequestForAdmin(
      row({ linkedGuestMembers: [{ guestIndex: -1, memberId: "" }] }),
    );

    expect(serialized).toMatchObject({ linkedMemberDataNeedsAttention: true });
    expect("guestDataNeedsAttention" in serialized).toBe(false);
    expect(serialized.linkedGuestMembers).toEqual([]);
    // The guest list itself was fine, so it is still served in full.
    expect(serialized.guests).toEqual(HEALTHY_GUESTS);
  });

  it("still serialises a well-formed linked-member list unflagged", () => {
    const serialized = serializeBookingRequestForAdmin(
      row({ linkedGuestMembers: [{ guestIndex: 0, memberId: "mem-1" }] }),
    );

    expect("guestDataNeedsAttention" in serialized).toBe(false);
    expect("linkedMemberDataNeedsAttention" in serialized).toBe(false);
    expect(serialized.linkedGuestMembers).toEqual([
      { guestIndex: 0, memberId: "mem-1" },
    ]);
  });

  it("serialises a malformed row instead of throwing, flagging only the guests", () => {
    const serialized = serializeBookingRequestForAdmin(badRow());

    expect(serialized).toMatchObject({ id: "req-bad", guestDataNeedsAttention: true });
    // Its links parsed fine (there are none), so the payload does not claim
    // otherwise — the panel would say "no linked members are shown" over a row
    // that has nothing to hide.
    expect("linkedMemberDataNeedsAttention" in serialized).toBe(false);
    expect(serialized.guests).toHaveLength(3);
    expect(serialized.guests[1]).toEqual({
      firstName: "School Child 1",
      lastName: "",
      ageTier: "YOUTH",
    });
  });

  it("flags both blobs when both are unreadable", () => {
    const serialized = serializeBookingRequestForAdmin(
      badRow({ linkedGuestMembers: [{ guestIndex: -1, memberId: "" }] }),
    );

    expect(serialized).toMatchObject({
      guestDataNeedsAttention: true,
      linkedMemberDataNeedsAttention: true,
    });
  });

  /*
   * #3412 review round 5 (E) — THE TEACHER NAMES THE PANEL SEES MUST BE THE
   * ONES THE SERVER REBUILDS THE PARTY FROM.
   *
   * Since #3412 the admin panel composes the party it is about to quote —
   * stored teachers first, then the regenerated children — and compares it to
   * the stored guest list to decide whether the officer's numbers changed
   * anything. The server composes the same list through `schoolTeacherSchema`,
   * whose names go through `nameField()` and are trimmed. This serialiser read
   * the column raw, so on a hand-repaired row carrying " Tui " the two lists
   * differed at row 0 for EVERY set of numbers, the stored ones included.
   *
   * Measured before the fix, typing the stored numbers straight back: Send
   * quote disabled and the "these numbers renumber that row" warning raised
   * against the teacher's own link, which disabled Save quote as well. Both
   * doors shut on a request nothing was wrong with, and no existing flag could
   * see it — the three cover guests, links and quotes.
   */
  it("normalises stored teacher names through the same helper the school reader uses (#3412)", () => {
    const stored = [
      { firstName: " Tui ", lastName: "Teacher\r\nSmith", email: null },
    ];

    const serialized = serializeBookingRequestForAdmin(
      row({ type: "SCHOOL", schoolName: "Test School", teachers: stored }),
    );

    // Pinned against the shared helper rather than against a literal, because
    // the fact under test is "one definition of how a person-name is
    // normalised", not "these two particular spellings".
    expect(serialized.teachers).toEqual([
      {
        firstName: nameField().parse(stored[0].firstName),
        lastName: nameField().parse(stored[0].lastName),
        email: null,
      },
    ]);
    expect(serialized.teachers[0]).toEqual({
      firstName: "Tui",
      lastName: "Teacher Smith",
      email: null,
    });
    expect("teacherDataNeedsAttention" in serialized).toBe(false);
  });

  it.each([
    ["empty name", [{ firstName: "", lastName: "Teacher", email: null }]],
    ["overlong name", [{ firstName: "T".repeat(101), lastName: "Teacher", email: null }]],
    ["invalid email", [{ firstName: "Tui", lastName: "Teacher", email: "not-an-email" }]],
    ["unreadable blob", null],
  ])("flags only malformed school teachers: %s", (_case, teachers) => {
    const serialized = serializeBookingRequestForAdmin(
      row({ type: "SCHOOL", schoolName: "Test School", teachers }),
    );

    expect(serialized.teachers).toEqual([]);
    expect(serialized).toMatchObject({ teacherDataNeedsAttention: true });
    expect("guestDataNeedsAttention" in serialized).toBe(false);
    expect("linkedMemberDataNeedsAttention" in serialized).toBe(false);
  });

  it("does not flag the absent teacher column on a general request", () => {
    const serialized = serializeBookingRequestForAdmin(row({ teachers: null }));
    expect(serialized.teachers).toEqual([]);
    expect("teacherDataNeedsAttention" in serialized).toBe(false);
  });
});

describe("GET /api/admin/booking-requests — the list path (#2342)", () => {
  it("keeps a malformed school's teacher warning scoped to its own row", async () => {
    db.bookingRequest.findMany.mockResolvedValue([
      row({ type: "SCHOOL", schoolName: "Test School", teachers: [
        { firstName: "", lastName: "Teacher", email: null },
      ] }),
      row(),
    ]);
    db.bookingRequest.count.mockResolvedValue(2);

    const res = await listRequests(
      new NextRequest("http://localhost/api/admin/booking-requests?status=ALL"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ teacherDataNeedsAttention?: boolean; teachers: unknown[] }>;
    };
    expect(body.data[0]).toMatchObject({
      teacherDataNeedsAttention: true,
      teachers: [],
    });
    expect("teacherDataNeedsAttention" in body.data[1]).toBe(false);
  });

  it("returns 200 for status=ALL with a malformed row on the page, flagging only that row", async () => {
    db.bookingRequest.findMany.mockResolvedValue([row(), badRow()]);
    db.bookingRequest.count.mockResolvedValue(2);

    const res = await listRequests(
      new NextRequest("http://localhost/api/admin/booking-requests?status=ALL"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; guestDataNeedsAttention?: boolean; guests: unknown[] }>;
    };
    // The whole page survives: the good row is still there, unflagged.
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: "req-good" });
    expect(body.data[0].guestDataNeedsAttention).toBeUndefined();
    expect(body.data[1]).toMatchObject({ id: "req-bad", guestDataNeedsAttention: true });
    expect(body.data[1].guests).toHaveLength(3);
    // status=ALL is the filter that surfaced the bug: it must widen past QUEUE.
    expect(db.bookingRequest.findMany.mock.calls[0][0].where).toBeUndefined();
  });
});

describe("POST /api/admin/booking-requests/[id]/price — the detail path (#2342)", () => {
  async function callPrice(id: string) {
    return priceRequest(
      new NextRequest(`http://localhost/api/admin/booking-requests/${id}/price`, {
        method: "POST",
        body: JSON.stringify({ priceCents: 36000 }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("returns the tolerant per-request payload for a well-formed row", async () => {
    db.bookingRequest.findUnique.mockResolvedValue(row());
    db.bookingRequest.updateMany.mockResolvedValue({ count: 1 });

    const res = await callPrice("req-good");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      guestDataNeedsAttention?: boolean;
      guests: unknown[];
    };
    expect(body).toMatchObject({ id: "req-good" });
    expect(body.guestDataNeedsAttention).toBeUndefined();
  });

  it("refuses a flagged row with a clean 409, and stamps no price", async () => {
    // This route reads no guests of its own — it only stamps priceCents — so it
    // used to 200 on a row every other admin action refuses. It is also what
    // arms Approve for a GENERAL request, and the price it stamps is later
    // split across the strictly-parsed guest list, so it now refuses too and
    // docs/guides/booking-requests.md can say so without qualification.
    db.bookingRequest.findUnique.mockResolvedValue(badRow());
    db.bookingRequest.updateMany.mockResolvedValue({ count: 1 });

    const res = await callPrice("req-bad");

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(UNREADABLE_STORED_GUESTS_MESSAGE);
    expect(body.error).not.toMatch(/invalid|schema/i);
    expect(db.bookingRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe("writes and conversions stay strict (#2342)", () => {
  it("rejects an empty surname at the guest schema", () => {
    const parsed = bookingRequestGuestSchema.safeParse({
      firstName: "School Child 1",
      lastName: "",
      ageTier: "YOUTH",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an empty surname on the public submission route with 422", async () => {
    const res = await submitPublicRequest(
      new NextRequest("http://localhost/api/booking-requests", {
        method: "POST",
        body: JSON.stringify({
          contactFirstName: "Mr",
          contactLastName: "Teacher",
          contactEmail: "office@example.com",
          checkIn: "2099-09-01",
          checkOut: "2099-09-03",
          guests: MALFORMED_GUESTS,
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(422);
  });

  it("still throws from the strict reader the conversion/approval paths use", () => {
    // approveBookingRequest, the school approval, and every quote/pricing path
    // read through this function. A row the admin queue merely DISPLAYS must
    // never become booking guests.
    //
    // The message is the officer-facing one and the status is 409 (#2342): this
    // string is rendered verbatim by the admin panel, and an unreadable stored
    // blob is an expected data condition rather than a server fault. The old
    // "Stored booking request guests are invalid" / 500 pair was neither.
    const err = (() => {
      try {
        parseBookingRequestGuests(MALFORMED_GUESTS);
        return null;
      } catch (caught) {
        return caught as Error & { status?: number };
      }
    })();

    expect(err?.message).toBe(UNREADABLE_STORED_GUESTS_MESSAGE);
    expect(err?.status).toBe(409);
  });
});
