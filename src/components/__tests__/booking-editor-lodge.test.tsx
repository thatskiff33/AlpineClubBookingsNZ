// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";
import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";

function booking(overrides: Partial<BookingEditorData>): BookingEditorData {
  return {
    id: "bk-1",
    lodgeName: "Second Lodge",
    checkIn: "2026-08-03",
    checkOut: "2026-08-05",
    nights: 2,
    status: "DRAFT",
    guests: [],
    viewerRole: "USER",
    totalPriceCents: 20_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 20_000,
    promo: null,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    requiresAdminReview: false,
    adminReviewStatus: null,
    editPolicy: { mode: "future", today: "2026-07-01", editableFrom: null, checkInEditable: true },
    ...overrides,
  };
}

/**
 * INV-CAP-039: the booking page's Stay Details card is where a member checks a
 * booking before paying for it, so it names the booking's lodge — always, in a
 * one-lodge club too, for the #2701 reason the wizard's review step does.
 */
describe("BookingEditor Stay Details names the booking's lodge (INV-CAP-039)", () => {
  it("shows a Lodge line with the lodge it is given", () => {
    render(<BookingEditor booking={booking({})} canModify={false} />);

    const label = screen.getByText("Lodge");
    expect(label.nextElementSibling).toHaveTextContent("Second Lodge");
  });
});
