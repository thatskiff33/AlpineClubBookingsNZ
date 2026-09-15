/**
 * Strictness pins for the ACTING paths over a booking request whose stored
 * JSON cannot be read back (#2342).
 *
 * #2342 made admin READS tolerant so one malformed historical row stopped
 * 500ing the whole Booking Requests queue. The hazard that created is the
 * mirror image: a flagged row is now REACHABLE by the buttons on the queue, and
 * a tolerant reader anywhere on a write path silently substitutes salvaged (or
 * empty) data for real data — an unreadable member link becomes "no link", so
 * the guest converts and invoices as a NON-MEMBER; an unreadable age tier
 * becomes zero children, so a 30-child school group is invoiced for two people.
 *
 * Every test here therefore asserts the SERVICE refuses, with the plain-English
 * message an officer actually sees, and that it refused BEFORE opening a
 * transaction. They are written to fail if someone swaps the strict reader for
 * the tolerant one on any of these paths — which is exactly the mutation the
 * pre-existing suites did not catch, because they stub the strict readers out.
 *
 * Sibling file: `booking-request-tolerant-guest-reads.test.ts` pins the other
 * half (that READS stay tolerant).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingRequestPricingMode,
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingRequestType,
} from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    bookingRequestQuote: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    booking: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    member: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
      count: vi.fn().mockResolvedValue(1),
    },
    season: { findMany: vi.fn().mockResolvedValue([]) },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  sendBookingRequestVerificationEmail: vi.fn(),
  sendAdminBookingRequestPendingEmail: vi.fn(),
  sendBookingRequestApprovedEmail: vi.fn(),
  sendBookingRequestDeclinedEmail: vi.fn(),
  sendAdminOwnerSubstitutionAlert: vi.fn(),
  sendAdminSchoolManualInvoiceEmail: vi.fn(),
  sendAdminWholeLodgeManualInvoiceEmail: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  sendHutLeaderAssignmentEmail: vi.fn(),
  sendBookingRequestQuoteEmail: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: vi.fn() }));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: vi.fn(),
  findOverlappingCapacityHoldingBookings: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(40),
  getDefaultLodgeCapacity: vi.fn().mockResolvedValue(40),
  FALLBACK_LODGE_CAPACITY: 20,
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadSchoolGroupSoftCap: vi.fn().mockResolvedValue(25),
}));
vi.mock("@/lib/lodge-pin-session", () => ({
  generateHutLeaderPin: vi.fn(() => "246810"),
  hashHutLeaderPin: vi.fn().mockResolvedValue("hashed-pin"),
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(2),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn().mockResolvedValue({}),
  MAX_AUDITED_PRUNED_ALLOCATIONS: 50,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  enqueueXeroAppliedCreditAllocationOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// bcrypt at cost 13 runs on some of these paths before the guard under test;
// the placeholder hash itself is irrelevant here and real bcrypt would add
// seconds per case.
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

const guards = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: guards.requireAdmin }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  approveBookingRequest,
  BookingRequestError,
  priceBookingRequest,
  UNREADABLE_STORED_GUESTS_MESSAGE,
  UNREADABLE_STORED_LINKS_MESSAGE,
} from "@/lib/booking-request";
import {
  createBookingRequestQuote,
  getBookingRequestQuoteContext,
  holdBookingRequestSlots,
  UNREADABLE_STORED_QUOTE_MESSAGE,
} from "@/lib/booking-request-quotes";
import { approveSchoolBookingRequest } from "@/lib/school-booking-request";
import { GET as listRequests } from "@/app/api/admin/booking-requests/route";

const findUnique = vi.mocked(prisma.bookingRequest.findUnique);
const transaction = vi.mocked(prisma.$transaction);
const quoteFindUnique = vi.mocked(prisma.bookingRequestQuote.findUnique);

/** A guest list that fails `bookingRequestGuestSchema`: the surname is empty. */
const MALFORMED_GUESTS = [
  { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
  { firstName: "School Child 1", lastName: "", ageTier: "YOUTH" },
];
const HEALTHY_GUESTS = [
  { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
  { firstName: "Sam", lastName: "Student", ageTier: "YOUTH" },
];
/** A link blob that fails its schema: a negative index and an empty member id. */
const MALFORMED_LINKS = [{ guestIndex: -1, memberId: "" }];

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    type: BookingRequestType.GENERAL,
    status: BookingRequestStatus.VERIFIED,
    lodgeId: null,
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
    guests: MALFORMED_GUESTS,
    message: null,
    priceCents: null,
    heldBookingId: null,
    quotes: [],
    ...overrides,
  };
}

const quoteInput = {
  pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
  options: [{ id: "STANDARD", totalCents: 12_000 }],
};

/** Assert a rejection is the officer-facing refusal, not a raw 500. */
async function expectCleanRefusal(promise: Promise<unknown>, message: string) {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(Error);
  const typed = err as Error & { status?: number };
  expect(typed.message).toBe(message);
  // 409, not 500: an unreadable stored blob is an expected data condition, and
  // the message is written to be shown to a human as-is.
  expect(typed.status).toBe(409);
  return typed;
}

beforeEach(() => {
  vi.clearAllMocks();
  guards.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  transaction.mockImplementation(async () => {
    throw new Error("the transaction must never be reached on a flagged row");
  });
});

describe("createBookingRequestQuote refuses a request it cannot read (#2342)", () => {
  it("refuses when the stored guest list is unreadable", async () => {
    findUnique.mockResolvedValue(requestRow() as never);

    await expectCleanRefusal(
      createBookingRequestQuote({
        requestId: "req-1",
        adminMemberId: "admin-1",
        quote: quoteInput,
      }),
      UNREADABLE_STORED_GUESTS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses when the stored member links are unreadable, rather than overwriting them", async () => {
    // The exact loss this guard exists to prevent: the admin panel posts its
    // DISPLAY link list, which is EMPTY on a row whose stored blob failed to
    // parse, and the quote transaction writes that list straight over the
    // stored column. One "Save quote" would have destroyed a recoverable link
    // and the guest would later convert and invoice as a non-member.
    findUnique.mockResolvedValue(
      requestRow({
        guests: HEALTHY_GUESTS,
        linkedGuestMembers: MALFORMED_LINKS,
      }) as never,
    );

    await expectCleanRefusal(
      createBookingRequestQuote({
        requestId: "req-1",
        adminMemberId: "admin-1",
        // What the panel actually sends for such a row.
        quote: { ...quoteInput, linkedGuestMembers: [] },
      }),
      UNREADABLE_STORED_LINKS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(prisma.bookingRequest.update).not.toHaveBeenCalled();
  });

  it("still quotes a request whose stored data reads back cleanly", async () => {
    findUnique.mockResolvedValue(
      requestRow({
        guests: HEALTHY_GUESTS,
        linkedGuestMembers: [{ guestIndex: 0, memberId: "mem-1" }],
      }) as never,
    );
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      { id: "mem-1" },
    ] as never);
    transaction.mockResolvedValue({
      id: "quote-1",
      version: 1,
      status: BookingRequestQuoteStatus.DRAFT,
    } as never);

    const quote = await createBookingRequestQuote({
      requestId: "req-1",
      adminMemberId: "admin-1",
      quote: { ...quoteInput, linkedGuestMembers: [{ guestIndex: 0, memberId: "mem-1" }] },
    });

    expect(quote.id).toBe("quote-1");
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe("approveBookingRequest refuses a request it cannot read (#2342)", () => {
  it("refuses when the stored guest list is unreadable", async () => {
    findUnique.mockResolvedValue(
      requestRow({ status: BookingRequestStatus.PRICED, priceCents: 12_000 }) as never,
    );

    await expectCleanRefusal(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" }),
      UNREADABLE_STORED_GUESTS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses when the stored member links are unreadable", async () => {
    findUnique.mockResolvedValue(
      requestRow({
        status: BookingRequestStatus.PRICED,
        priceCents: 12_000,
        guests: HEALTHY_GUESTS,
        linkedGuestMembers: MALFORMED_LINKS,
      }) as never,
    );

    await expectCleanRefusal(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" }),
      UNREADABLE_STORED_LINKS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("approveSchoolBookingRequest refuses a request it cannot read (#2342)", () => {
  const schoolRow = (overrides: Record<string, unknown> = {}) =>
    requestRow({
      type: BookingRequestType.SCHOOL,
      schoolName: "Demo High School",
      teachers: [{ firstName: "Mr", lastName: "Teacher", email: "t@example.com" }],
      ...overrides,
    });

  it("refuses when the stored guest list is unreadable", async () => {
    findUnique.mockResolvedValue(schoolRow() as never);

    await expectCleanRefusal(
      approveSchoolBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" }),
      UNREADABLE_STORED_GUESTS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses WITH an admin count override, which used to skip the stored list entirely", async () => {
    // The override branch regenerates the guest list from admin-typed counts,
    // so it never had to read request.guests — a flagged SCHOOL row could be
    // approved, priced, capacity-checked and invoiced from those numbers alone.
    // Worse, the panel PREFILLS them from the salvaged list, in which an
    // unreadable age tier counts as ZERO: the 30-child request below prefills
    // as 1 child. Conversions of a flagged row are not possible by any route.
    findUnique.mockResolvedValue(
      schoolRow({
        guests: [
          { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
          ...Array.from({ length: 30 }, (_, index) => ({
            firstName: `School Child ${index + 1}`,
            lastName: "",
            ageTier: "YOUTH",
          })),
        ],
      }) as never,
    );

    await expectCleanRefusal(
      approveSchoolBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        guestOverride: { childCounts: { INFANT: 0, CHILD: 1, YOUTH: 0 } },
      }),
      UNREADABLE_STORED_GUESTS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses when the stored member links are unreadable, override or not", async () => {
    findUnique.mockResolvedValue(
      schoolRow({ guests: HEALTHY_GUESTS, linkedGuestMembers: MALFORMED_LINKS }) as never,
    );

    await expectCleanRefusal(
      approveSchoolBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        guestOverride: { childCounts: { INFANT: 0, CHILD: 2, YOUTH: 0 } },
      }),
      UNREADABLE_STORED_LINKS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("holdBookingRequestSlots refuses a request it cannot read (#2342)", () => {
  it("refuses when the stored guest list is unreadable", async () => {
    findUnique.mockResolvedValue(requestRow({ priceCents: 12_000 }) as never);

    await expectCleanRefusal(
      holdBookingRequestSlots({ requestId: "req-1", adminMemberId: "admin-1" }),
      UNREADABLE_STORED_GUESTS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses when the stored member links are unreadable", async () => {
    findUnique.mockResolvedValue(
      requestRow({
        priceCents: 12_000,
        guests: HEALTHY_GUESTS,
        linkedGuestMembers: MALFORMED_LINKS,
      }) as never,
    );

    await expectCleanRefusal(
      holdBookingRequestSlots({ requestId: "req-1", adminMemberId: "admin-1" }),
      UNREADABLE_STORED_LINKS_MESSAGE,
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("priceBookingRequest refuses a request it cannot read (#2342)", () => {
  it("refuses when the stored guest list is unreadable, and stamps no price", async () => {
    // /price is the one admin action on this list that never needed to read the
    // guests — it only stamps priceCents — so it used to return 200 on a row
    // every other action refuses. It is also the gate that arms Approve for a
    // GENERAL request, and the price it stamps is later split across the
    // strictly-parsed guest list.
    findUnique.mockResolvedValue(requestRow() as never);

    await expectCleanRefusal(
      priceBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        priceCents: 12_000,
      }),
      UNREADABLE_STORED_GUESTS_MESSAGE,
    );
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the stored member links are unreadable", async () => {
    findUnique.mockResolvedValue(
      requestRow({ guests: HEALTHY_GUESTS, linkedGuestMembers: MALFORMED_LINKS }) as never,
    );

    await expectCleanRefusal(
      priceBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        priceCents: 12_000,
      }),
      UNREADABLE_STORED_LINKS_MESSAGE,
    );
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("still prices a request whose stored data reads back cleanly", async () => {
    findUnique.mockResolvedValue(requestRow({ guests: HEALTHY_GUESTS }) as never);
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({ count: 1 } as never);

    await priceBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      priceCents: 12_000,
    });

    expect(prisma.bookingRequest.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("the quote link stays strict about a corrupt stored quote (#2342)", () => {
  it("refuses to build the requester's quote page from an unreadable options blob", async () => {
    // The list route now DISPLAYS such a row with its quote omitted (so one
    // corrupt blob no longer 500s every filter), but nothing may ACT on it:
    // the options carry the totals and the per-guest split that become money.
    quoteFindUnique.mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      responseTokenExpiresAt: new Date(Date.now() + 60_000),
      options: [{ id: "STANDARD", totalCents: "not-a-number" }],
      message: null,
      bookingRequest: { ...requestRow({ guests: HEALTHY_GUESTS }), lodge: null },
    } as never);

    const err = await getBookingRequestQuoteContext("a".repeat(64)).then(
      () => null,
      (caught: unknown) => caught as Error & { status?: number },
    );
    expect(err?.message).toBe(UNREADABLE_STORED_QUOTE_MESSAGE);
    expect(err?.status).toBe(409);
  });
});

describe("GET /api/admin/booking-requests degrades a corrupt quote blob (#2342)", () => {
  it("returns 200 with that row's quote omitted and flagged, leaving healthy rows alone", async () => {
    // The list route parses each row's latest quote. Until this fix that parse
    // was the STRICT one, so a single corrupt BookingRequestQuote.options blob
    // still 500'd every filter on the page — the exact mechanism #2342 set out
    // to remove, just one blob further along.
    const listRow = (id: string) => ({
      ...requestRow({ id, guests: HEALTHY_GUESTS }),
      lodge: null,
      pricedByMemberId: null,
      reviewedByMemberId: null,
      convertedMemberId: null,
      verifiedAt: null,
      pricedAt: null,
      reviewedAt: null,
      declineReason: null,
      convertedBookingId: null,
      attendeesConfirmedAt: null,
      acceptedQuoteOptionId: null,
      acceptedPriceCents: null,
      acceptedAt: null,
      responseMessage: null,
      responseMessageAt: null,
      indicativePriceCents: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    vi.mocked(prisma.bookingRequest.findMany).mockResolvedValue([
      listRow("req-good"),
      listRow("req-badquote"),
    ] as never);
    vi.mocked(prisma.bookingRequest.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.bookingRequestQuote.findMany).mockResolvedValue([
      {
        id: "quote-good",
        bookingRequestId: "req-good",
        version: 1,
        status: BookingRequestQuoteStatus.DRAFT,
        pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
        sentAt: null,
        responseTokenExpiresAt: null,
        options: [
          {
            id: "STANDARD",
            label: "Quote",
            cateringOption: null,
            totalCents: 12_000,
            pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
            guestBreakdown: [],
          },
        ],
      },
      {
        id: "quote-bad",
        bookingRequestId: "req-badquote",
        version: 1,
        status: BookingRequestQuoteStatus.DRAFT,
        pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
        sentAt: null,
        responseTokenExpiresAt: null,
        // Fails quoteOptionsSchema: no label, and a non-integer total.
        options: [{ id: "STANDARD", totalCents: "lots" }],
      },
    ] as never);

    const res = await listRequests(
      new NextRequest("http://localhost/api/admin/booking-requests?status=ALL"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        quoteDataNeedsAttention?: boolean;
        latestQuote: { id: string; options: unknown[] } | null;
      }>;
    };
    expect(body.data).toHaveLength(2);
    // The healthy row keeps its quote, unflagged.
    expect(body.data[0].quoteDataNeedsAttention).toBeUndefined();
    expect(body.data[0].latestQuote?.options).toHaveLength(1);
    // The corrupt row renders with the quote details omitted and flagged.
    expect(body.data[1]).toMatchObject({
      id: "req-badquote",
      quoteDataNeedsAttention: true,
    });
    expect(body.data[1].latestQuote?.id).toBe("quote-bad");
    expect(body.data[1].latestQuote?.options).toEqual([]);
  });
});

/*
 * #3412 (review, F16) — the queue serialises the HOLD'S STATUS, not just its id.
 *
 * `heldBookingId` alone does not say whether beds are reserved: a cancelled
 * booking leaves a stale pointer that reserves nothing, which the quote service
 * deliberately lets the officer past. Keyed on the pointer, the panel disabled
 * Save quote and sent the officer to Release hold — which 409s on that same dead
 * pointer, so both doors were shut on a save the service would have accepted.
 * The panel now keys on this field, so it is the field that has to arrive.
 */
describe("GET /api/admin/booking-requests carries the hold's status (#3412)", () => {
  it("serialises the held booking's status, and null for a pointer that resolves to nothing", async () => {
    const listRow = (id: string, heldBookingId: string | null) => ({
      ...requestRow({ id, guests: HEALTHY_GUESTS }),
      heldBookingId,
      lodge: null,
      pricedByMemberId: null,
      reviewedByMemberId: null,
      convertedMemberId: null,
      verifiedAt: null,
      pricedAt: null,
      reviewedAt: null,
      declineReason: null,
      convertedBookingId: null,
      attendeesConfirmedAt: null,
      acceptedQuoteOptionId: null,
      acceptedPriceCents: null,
      acceptedAt: null,
      responseMessage: null,
      responseMessageAt: null,
      indicativePriceCents: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    vi.mocked(prisma.bookingRequest.findMany).mockResolvedValue([
      listRow("req-held", "booking-live"),
      listRow("req-dangling", "booking-gone"),
      listRow("req-unheld", null),
    ] as never);
    vi.mocked(prisma.bookingRequest.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.bookingRequestQuote.findMany).mockResolvedValue([] as never);
    // Only the live hold's booking still exists; "booking-gone" was cancelled
    // and deleted from under its pointer.
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      { id: "booking-live", status: "AWAITING_REVIEW" },
    ] as never);

    const res = await listRequests(
      new NextRequest("http://localhost/api/admin/booking-requests?status=ALL"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; heldBookingStatus: string | null }>;
    };
    expect(body.data.map((row) => row.heldBookingStatus)).toEqual([
      "AWAITING_REVIEW",
      null,
      null,
    ]);
    // One batched read for the whole page, not one per row.
    expect(prisma.booking.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("the refusals are officer-readable, not developer strings (#2342)", () => {
  it("never leaks the old internal wording or a 500", () => {
    for (const message of [
      UNREADABLE_STORED_GUESTS_MESSAGE,
      UNREADABLE_STORED_LINKS_MESSAGE,
      UNREADABLE_STORED_QUOTE_MESSAGE,
    ]) {
      expect(message).not.toMatch(/invalid|schema|parse|JSON/i);
      // Plain English, and long enough to actually say what to do next.
      expect(message.length).toBeGreaterThan(60);
    }
    // The two admin-facing ones name the only remedies that exist: there is no
    // guest-edit screen anywhere in the admin UI.
    expect(UNREADABLE_STORED_GUESTS_MESSAGE).toMatch(/Decline/);
    expect(UNREADABLE_STORED_LINKS_MESSAGE).toMatch(/Decline/);
    expect(new BookingRequestError(UNREADABLE_STORED_GUESTS_MESSAGE, 409).status).toBe(
      409,
    );
  });
});
