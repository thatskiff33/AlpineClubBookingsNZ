// @vitest-environment jsdom

import { render } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";

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

// `club` is only read for change-request dates, and every case renders none.
const club = {} as never;

describe("BookingReviewNotices pending-review copy (#3500)", () => {
  it("a parked booking is told payment waits on approval and that it cannot be changed — never to amend", () => {
    const { container } = render(
      <BookingReviewNotices
        booking={booking({ status: "AWAITING_REVIEW" })}
        club={club}
        access={{ canModify: false }}
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
        access={{ canModify: true }}
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
        access={{ canModify: false }}
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
        access={{ canModify: true }}
      />,
    );
    expect(container.textContent).toContain("Approved by admin.");
    expect(container.textContent).not.toContain(AMEND);
    expect(container.textContent).not.toContain(NO_PAYMENT);
  });
});
