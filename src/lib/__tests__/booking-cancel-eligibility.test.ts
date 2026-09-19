import { BookingStatus } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeatureFlags } from "@/config/schema";
import type { BookingDetailRecord } from "@/app/(authenticated)/bookings/[id]/_lib/load-booking-detail";
import type { BookingDetailViewer } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-viewer";

/**
 * #3497: "WHICH BOOKINGS MAY BE CANCELLED?" IS ONE QUESTION, ANSWERED FROM ONE
 * HOME, AND EVERY MEMBER-FACING DOOR AGREES WITH IT.
 *
 * Before this issue the cancel service admitted seven statuses, the booking
 * page's Cancel button six, and the cancel-preview route four — so a member on
 * a waitlist pressed Cancel and the dialog dead-ended on "Only PENDING,
 * PAYMENT_PENDING, CONFIRMED, or PAID bookings can be cancelled". This file pins,
 * for EVERY `BookingStatus`, what the service set, the member set, `canCancel`,
 * the cancel-preview route and the notes route answer — as one table, so any
 * future divergence is a diff here rather than a dead-end for a member.
 *
 * The one deliberate difference between the service and the member doors is
 * `AWAITING_REVIEW` (owner decision Option B, 19 Sep 2026): `cancelBooking`
 * never touches `adminReviewStatus`, so a member self-cancel would leave a
 * CANCELLED row sitting as a ghost PENDING item in the officers' Approvals
 * queue. Withdrawing a booking under review is the reviewing officer's Reject.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  memberCreditAggregate: vi.fn(),
  paymentEligibleForPaidCancelPath: vi.fn(),
  loadCancellationPolicy: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique, update: mocks.bookingUpdate },
    memberCredit: { aggregate: mocks.memberCreditAggregate },
  },
}));
// The preview route reads ONE helper from the cancel service; mocking the module
// keeps the service's provider imports (Stripe, Xero, email) out of this file.
vi.mock("@/lib/booking-cancel", () => ({
  paymentEligibleForPaidCancelPath: mocks.paymentEligibleForPaidCancelPath,
}));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: vi.fn(async () => ({ today: () => ({ year: 2026, month: 7, day: 1 }) })),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// `resolveBookingDetailEditAccess` reaches three prisma-importing modules for
// gates this file does not test; the edit policy itself stays real.
vi.mock("@/lib/booking-modify", () => ({
  isBookingFullyPaidForGuestNameEdits: vi.fn(() => false),
}));
vi.mock("@/lib/bed-allocation-approval", () => ({
  isBookingBedAllocationLocked: vi.fn(async () => false),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  BED_ALLOCATABLE_BOOKING_STATUSES: [],
}));

import {
  CANCELLABLE_BOOKING_STATUSES,
  MEMBER_CANCELLABLE_BOOKING_STATUSES,
  isCancellableBookingStatus,
  isMemberCancellableBookingStatus,
  memberCancelRefusal,
} from "@/lib/booking-cancel-eligibility";
import { GET as getCancelPreview } from "@/app/api/bookings/[id]/cancel-preview/route";
import { PUT as putNotes } from "@/app/api/bookings/[id]/notes/route";
import { resolveBookingDetailEditAccess } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-edit-access";

const ALL_STATUSES: readonly string[] = Object.values(BookingStatus);

/**
 * The table. `service` is what `cancelBooking` admits (its internal and officer
 * callers); the other four columns are the member-facing doors. A `200` is a door
 * that opened, a `400` one that refused on status.
 */
const EXPECTED: Record<
  string,
  { service: boolean; member: boolean; canCancel: boolean; preview: 200 | 400; notes: 200 | 400 }
> = {
  DRAFT: { service: false, member: false, canCancel: false, preview: 400, notes: 400 },
  PENDING: { service: true, member: true, canCancel: true, preview: 200, notes: 200 },
  PAYMENT_PENDING: { service: true, member: true, canCancel: true, preview: 200, notes: 200 },
  CONFIRMED: { service: true, member: true, canCancel: true, preview: 200, notes: 200 },
  PAID: { service: true, member: true, canCancel: true, preview: 200, notes: 200 },
  BUMPED: { service: false, member: false, canCancel: false, preview: 400, notes: 400 },
  CANCELLED: { service: false, member: false, canCancel: false, preview: 400, notes: 400 },
  COMPLETED: { service: false, member: false, canCancel: false, preview: 400, notes: 400 },
  WAITLISTED: { service: true, member: true, canCancel: true, preview: 200, notes: 200 },
  WAITLIST_OFFERED: { service: true, member: true, canCancel: true, preview: 200, notes: 200 },
  // The one row where the service and the member doors part: see the docblock.
  AWAITING_REVIEW: { service: true, member: false, canCancel: false, preview: 400, notes: 400 },
};

const OWNER = "member-1";
// Under the repository's frozen clock (2026-07-01) this stay has not started, so
// `canCancel`'s started-stay condition is out of the way and only status decides.
const FUTURE_BOOKING = {
  id: "b1",
  memberId: OWNER,
  organisationId: null,
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-03T00:00:00.000Z"),
  deletedAt: null,
  requestedRoomId: null,
  finalPriceCents: 10_000,
  lodgeId: "lodge-1",
  payment: null,
};

const ownerViewer = {
  viewerAuthorizationRole: "USER",
  isAdmin: false,
  isBookingOwner: true,
  canManageBooking: true,
  canAdminEditBookings: false,
  canSeeAdminTools: false,
} as unknown as BookingDetailViewer;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function canCancelFor(status: string): Promise<boolean> {
  const access = await resolveBookingDetailEditAccess({
    booking: { ...FUTURE_BOOKING, status } as unknown as BookingDetailRecord,
    modules: { bedAllocation: false } as unknown as FeatureFlags,
    clubTodayDateOnly: new Date("2026-07-01T00:00:00.000Z"),
    viewer: ownerViewer,
  });
  return access.canCancel;
}

async function previewFor(status: string) {
  mocks.bookingFindUnique.mockResolvedValue({ ...FUTURE_BOOKING, status });
  return getCancelPreview(
    new NextRequest("http://localhost/api/bookings/b1/cancel-preview"),
    params("b1"),
  );
}

async function notesFor(status: string) {
  mocks.bookingFindUnique.mockResolvedValue({ memberId: OWNER, status });
  return putNotes(
    new NextRequest("http://localhost/api/bookings/b1/notes", {
      method: "PUT",
      body: JSON.stringify({ notes: "see you there" }),
      headers: { "Content-Type": "application/json" },
    }),
    params("b1"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: OWNER, role: "MEMBER", accessRoles: [{ role: "USER" }] },
  });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: null } });
  mocks.bookingUpdate.mockResolvedValue({ id: "b1", notes: "see you there" });
  mocks.paymentEligibleForPaidCancelPath.mockResolvedValue(false);
});

describe("#3497: the cancellable sets", () => {
  it("the table names every BookingStatus exactly once, so a new status cannot fall through unpinned", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("the member set is a strict subset of the service set", () => {
    for (const status of MEMBER_CANCELLABLE_BOOKING_STATUSES) {
      expect(CANCELLABLE_BOOKING_STATUSES).toContain(status);
    }
    expect(MEMBER_CANCELLABLE_BOOKING_STATUSES.length).toBeLessThan(
      CANCELLABLE_BOOKING_STATUSES.length,
    );
  });

  it("the member set is exactly the service set minus AWAITING_REVIEW — one exclusion, with its reason recorded at the derivation", () => {
    expect([...MEMBER_CANCELLABLE_BOOKING_STATUSES]).toEqual(
      CANCELLABLE_BOOKING_STATUSES.filter((status) => status !== "AWAITING_REVIEW"),
    );
    expect(MEMBER_CANCELLABLE_BOOKING_STATUSES).not.toContain("AWAITING_REVIEW");
  });

  it("the predicates are the sets, and the refusal sentence is null exactly when a member door opens", () => {
    for (const status of ALL_STATUSES) {
      expect(isCancellableBookingStatus(status), status).toBe(
        (CANCELLABLE_BOOKING_STATUSES as readonly string[]).includes(status),
      );
      expect(isMemberCancellableBookingStatus(status), status).toBe(
        (MEMBER_CANCELLABLE_BOOKING_STATUSES as readonly string[]).includes(status),
      );
      expect(memberCancelRefusal(status) === null, status).toBe(
        isMemberCancellableBookingStatus(status),
      );
    }
  });

  it("a booking under review is refused with the sentence that tells the member what to do instead", () => {
    const refusal = memberCancelRefusal("AWAITING_REVIEW");
    expect(refusal).toMatch(/with the club for review/);
    expect(refusal).toMatch(/contact the club/);
    // And a status the service itself cannot cancel gets a plain-English
    // sentence with no status codes in it, not the review sentence — the member
    // is not told to contact anyone about a booking that is already cancelled.
    const plain = memberCancelRefusal("CANCELLED");
    expect(plain).not.toMatch(/review/);
    expect(plain).toBe("This booking can no longer be cancelled from here.");
    for (const status of ALL_STATUSES) expect(plain).not.toContain(status);
  });
});

describe("#3497: every door answers every status the way the table says", () => {
  for (const status of ALL_STATUSES) {
    it(`${status}`, async () => {
      const expected = EXPECTED[status];
      const preview = await previewFor(status);
      const notes = await notesFor(status);
      const actual = {
        service: isCancellableBookingStatus(status),
        member: isMemberCancellableBookingStatus(status),
        canCancel: await canCancelFor(status),
        preview: preview.status as 200 | 400,
        notes: notes.status as 200 | 400,
      };
      expect(
        actual,
        `Which bookings may be cancelled has CHANGED for ${status}, or a door ` +
          `has stopped deriving from MEMBER_CANCELLABLE_BOOKING_STATUSES in ` +
          `src/lib/booking-cancel-eligibility.ts. Update the table deliberately, ` +
          `with the issue that decided it, or undo the change.`,
      ).toEqual(expected);

      // The preview refuses with the ONE sentence, so the dialog and the cancel
      // route can never disagree about why.
      if (expected.preview === 400) {
        expect(await preview.json()).toEqual({ error: memberCancelRefusal(status) });
      }
      // The notes route saved only when the door opened.
      expect(mocks.bookingUpdate).toHaveBeenCalledTimes(expected.notes === 200 ? 1 : 0);
    });
  }
});
