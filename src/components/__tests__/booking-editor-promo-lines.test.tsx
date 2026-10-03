// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";
import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";

/**
 * #3828: the booking detail payment card names each promo code on its own row
 * when a booking carries several; one code keeps its one row.
 */
function booking(overrides: Partial<BookingEditorData>): BookingEditorData {
  return {
    id: "bk-1",
    checkIn: "2026-08-08",
    checkOut: "2026-08-10",
    nights: 2,
    status: "PAID",
    guests: [],
    viewerRole: "USER",
    totalPriceCents: 30_000,
    discountCents: 5_000,
    promoAdjustmentCents: -5_000,
    finalPriceCents: 25_000,
    promo: null,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    requiresAdminReview: false,
    adminReviewStatus: null,
    editPolicy: { mode: "future", today: "2026-08-01", editableFrom: null, checkInEditable: true },
    ...overrides,
  };
}

describe("BookingEditor payment card promo rows (#3828)", () => {
  it("shows one row per code, each with its own adjustment", () => {
    render(
      <BookingEditor
        booking={booking({
          promoLines: [
            { code: "SPRING10", type: "PERCENT", description: null, amountCents: -3_000 },
            { code: "GUESTFREE", type: "FREE_NIGHTS", description: null, amountCents: -2_000 },
          ],
        })}
        canModify={false}
      />,
    );

    expect(screen.getByText("(SPRING10)")).toBeInTheDocument();
    expect(screen.getByText("(GUESTFREE)")).toBeInTheDocument();
    expect(screen.getByText("-$30.00")).toBeInTheDocument();
    expect(screen.getByText("-$20.00")).toBeInTheDocument();
    expect(screen.getAllByText("Promo adjustment")).toHaveLength(2);
  });

  it("keeps a one-code booking's single row", () => {
    render(
      <BookingEditor
        booking={booking({ promo: { code: "SPRING10", type: "PERCENT", description: null } })}
        canModify={false}
      />,
    );

    expect(screen.getAllByText("Promo adjustment")).toHaveLength(1);
    expect(screen.getByText("(SPRING10)")).toBeInTheDocument();
    expect(screen.getByText("-$50.00")).toBeInTheDocument();
  });
});
