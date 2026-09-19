// @vitest-environment jsdom

import { render } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";

import type { BookingDetailEditAccess } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-edit-access";
import type { BookingDetailViewer } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-viewer";
import { BookingReviewNotices } from "@/app/(authenticated)/bookings/[id]/_components/booking-review-notices";

/**
 * #3500: the pending-review notice may only promise what the tree can do.
 *
 * A youth-only booking a member created is PARKED in `AWAITING_REVIEW`, which
 * every edit door refuses (`booking-edit-eligibility-one-home.test.ts`), so
 * "amend the booking to include an adult" is false there; a PAID booking
 * FLAGGED for review can be amended and clears in place
 * (`guests-add-notify-choice.test.ts`), but has already been paid, so
 * "payment cannot be taken" is false there. The component reads
 * `access.canModify` — the page's own edit answer — and the booking status, and
 * each sentence shows only where it is true.
 */

const AMEND = "You can amend the booking to include an adult guest";
const NO_PAYMENT = "Payment cannot be taken until an admin approves";

function booking(overrides: Record<string, unknown>) {
  return {
    createdBy: null,
    requiresAdminReview: true,
    adminReviewStatus: "PENDING",
    adminReviewReason: "No adult guest on the booking",
    memberReviewJustification: null,
    adminReviewNotes: null,
    changeRequests: [],
    ...overrides,
  } as never;
}

// The component takes the page's whole access object and its viewer since #3497
// added the owner-cancel notice; these cases turn only `canModify`, so the rest is
// built once with every flag off. A missing field is a compile error, which is what
// keeps this fixture honest when the real shape grows.
const baseAccess: BookingDetailEditAccess = {
  isDraft: false,
  isWaitlisted: false,
  isWaitlistOffered: false,
  isDeleted: false,
  canCancel: false,
  showArrivalTime: false,
  showRequestedRoom: false,
  bedAllocationLocked: false,
  showBedAllocationPanel: false,
  bookingCanHoldBeds: false,
  editPolicy: {
    canModify: false,
    mode: null,
    today: new Date("2026-07-01T00:00:00.000Z"),
    editableFrom: null,
    checkInEditable: false,
    reason: null,
  },
  canModify: false,
  canAdminOverride: false,
  canEditRequestedRoom: false,
  canEditNonMemberGuestNames: false,
  canFixNonMemberGuestNameTypos: false,
};

const accessWith = (canModify: boolean): BookingDetailEditAccess => ({
  ...baseAccess,
  canModify,
});

// Not the owner, so the #3497 owner-cancel notice never renders in these cases.
const viewer = { isBookingOwner: false } as BookingDetailViewer;

// `club` is only read for change-request dates, and every case renders none.
const club = {} as never;

describe("BookingReviewNotices pending-review copy (#3500)", () => {
  it("a parked booking is told payment waits on approval and that it cannot be changed — never to amend", () => {
    const { container } = render(
      <BookingReviewNotices
        booking={booking({ status: "AWAITING_REVIEW" })}
        club={club}
        viewer={viewer}
        access={accessWith(false)}
      />,
    );
    expect(container.textContent).toContain(NO_PAYMENT);
    expect(container.textContent).toContain("cannot be changed while it is under review");
    expect(container.textContent).not.toContain(AMEND);
  });

  it("a flagged PAID booking the viewer may edit is told to amend — never that payment cannot be taken", () => {
    const { container } = render(
      <BookingReviewNotices
        booking={booking({ status: "PAID" })}
        club={club}
        viewer={viewer}
        access={accessWith(true)}
      />,
    );
    expect(container.textContent).toContain(AMEND);
    expect(container.textContent).not.toContain(NO_PAYMENT);
  });

  it("a flagged PAID booking the viewer may NOT edit gets the heading only", () => {
    const { container } = render(
      <BookingReviewNotices
        booking={booking({ status: "PAID" })}
        club={club}
        viewer={viewer}
        access={accessWith(false)}
      />,
    );
    expect(container.textContent).toContain("Awaiting admin review.");
    expect(container.textContent).not.toContain(AMEND);
    expect(container.textContent).not.toContain(NO_PAYMENT);
  });

  it("an approved review shows neither sentence", () => {
    const { container } = render(
      <BookingReviewNotices
        booking={booking({ status: "PAID", adminReviewStatus: "APPROVED" })}
        club={club}
        viewer={viewer}
        access={accessWith(true)}
      />,
    );
    expect(container.textContent).toContain("Approved by admin.");
    expect(container.textContent).not.toContain(AMEND);
    expect(container.textContent).not.toContain(NO_PAYMENT);
  });
});
