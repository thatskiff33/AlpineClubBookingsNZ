// @vitest-environment jsdom

import { render } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";

import {
  BookingEditor,
  type BookingEditorData,
} from "@/components/booking-editor";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeBooking(
  overrides: Partial<BookingEditorData> = {}
): BookingEditorData {
  return {
    id: "bk_hold_1",
    checkIn: "2026-08-01",
    checkOut: "2026-08-03",
    nights: 2,
    status: "PENDING",
    guests: [
      {
        id: "g1",
        firstName: "Ada",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        priceCents: 5000,
      },
    ],
    viewerRole: "MEMBER",
    totalPriceCents: 5000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 5000,
    promo: null,
    hasNonMembers: true,
    nonMemberHoldUntil: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    editPolicy: {
      mode: null,
      today: "2026-07-05",
      editableFrom: null,
      checkInEditable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
    ...overrides,
  };
}

describe("BookingEditor — non-member hold banner (#1321)", () => {
  it("shows future-tense auto-confirm copy when the hold deadline is in the future", () => {
    const future = new Date(Date.now() + DAY_MS).toISOString();
    const { container } = render(
      <BookingEditor
        booking={makeBooking({ nonMemberHoldUntil: future })}
        canModify={false}
      />
    );

    const text = container.textContent ?? "";
    expect(text).toContain("It will be auto-confirmed on");
    expect(text).not.toContain("The hold period ended on");
  });

  it("shows honest lapsed-deadline copy when the hold deadline is in the past", () => {
    const past = new Date(Date.now() - DAY_MS).toISOString();
    const { container } = render(
      <BookingEditor
        booking={makeBooking({ nonMemberHoldUntil: past })}
        canModify={false}
      />
    );

    const text = container.textContent ?? "";
    // The regression guard: a lapsed hold must not claim a future auto-confirm.
    expect(text).not.toContain("It will be auto-confirmed on");
    expect(text).toContain("The hold period ended on");
    expect(text).toContain(
      "awaiting confirmation, payment, or admin processing"
    );
  });
});
