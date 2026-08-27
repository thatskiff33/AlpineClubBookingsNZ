// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";
import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";

/**
 * The read view's rate category for a partner-lodge member (Other Lodges epic,
 * follow-up to #2749).
 *
 * The guest list is the only place on this page that explains the fee beside a
 * name, so a non-member charged the club's MEMBER rate has to say so there —
 * otherwise the row reads "Non-member" beside a member-rate figure and looks
 * like a mispricing to anybody reconciling it.
 */

function booking(guests: BookingEditorData["guests"]): BookingEditorData {
  return {
    id: "bk-1",
    checkIn: "2026-08-08",
    checkOut: "2026-08-10",
    nights: 2,
    status: "PAID",
    guests,
    viewerRole: "USER",
    totalPriceCents: 10_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 10_000,
    promo: null,
    hasNonMembers: true,
    nonMemberHoldUntil: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    requiresAdminReview: false,
    adminReviewStatus: null,
    editPolicy: {
      mode: "future",
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
    },
  };
}

const VISITOR = {
  id: "g-visitor",
  firstName: "Vic",
  lastName: "Visitor",
  ageTier: "ADULT",
  isMember: false,
  stayStart: "2026-08-08",
  stayEnd: "2026-08-10",
  priceCents: 2_000,
};

describe("BookingEditor — Other Club Member rate category", () => {
  it("marks a recognised partner-lodge member on their rate category", () => {
    render(
      <BookingEditor
        booking={booking([{ ...VISITOR, otherLodgeMember: true }])}
        canModify={false}
      />,
    );

    // Still a non-member of THIS club — the suffix explains the rate, it does
    // not promote them.
    expect(
      screen.getByText(/Non-member \(Other Club Member\)/),
    ).toBeInTheDocument();
  });

  it("leaves an ordinary non-member's row exactly as it was", () => {
    render(<BookingEditor booking={booking([VISITOR])} canModify={false} />);

    expect(screen.getByText(/Non-member/)).toBeInTheDocument();
    expect(screen.queryByText(/Other Club Member/)).toBeNull();
  });

  it("says nothing on a member of this club", () => {
    render(
      <BookingEditor
        booking={booking([
          { ...VISITOR, id: "g-member", isMember: true, memberId: "m-1" },
        ])}
        canModify={false}
      />,
    );

    expect(screen.queryByText(/Other Club Member/)).toBeNull();
  });
});
