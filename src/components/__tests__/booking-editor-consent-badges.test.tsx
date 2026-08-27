// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";
import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";

// #2307 (owner decision MG2-M-2) — the guest list's consent badges. The badge
// arrives pre-composed from the server (`describeMemberGuestConsentBadge`,
// whose wording has its own pinned tests); what THIS pins is the rendering
// contract: a row with a badge shows exactly its label, and a family or
// non-member row — which is sent WITHOUT a `consent` key at all — renders
// byte-for-byte the row it always rendered.

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
    hasNonMembers: false,
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

const FAMILY_GUEST = {
  id: "g-family",
  firstName: "Marama",
  lastName: "Ngata",
  ageTier: "ADULT",
  isMember: true,
  memberId: "m-family",
  stayStart: "2026-08-08",
  stayEnd: "2026-08-10",
  nights: ["2026-08-08", "2026-08-09"],
  priceCents: 5_000,
};

describe("BookingEditor consent badges", () => {
  it("renders each provided badge with its exact ticked wording", () => {
    render(
      <BookingEditor
        booking={booking([
          FAMILY_GUEST,
          {
            ...FAMILY_GUEST,
            id: "g-pending",
            firstName: "Priya",
            lastName: "Kaur",
            consent: {
              tone: "pending",
              label: "Waiting for consent · expires 7 Aug",
            },
          },
          {
            ...FAMILY_GUEST,
            id: "g-delegate",
            firstName: "Tama",
            lastName: "Kaur",
            consent: { tone: "ok", label: "Consented by Ana Kaur, 2 Aug" },
          },
          {
            ...FAMILY_GUEST,
            id: "g-blocked",
            firstName: "Tui",
            lastName: "Aporo",
            consent: { tone: "blocked", label: "Said no — could not be removed" },
          },
        ])}
        canModify={false}
      />,
    );

    expect(
      screen.getByText("Waiting for consent · expires 7 Aug"),
    ).toBeInTheDocument();
    expect(screen.getByText("Consented by Ana Kaur, 2 Aug")).toBeInTheDocument();
    expect(
      screen.getByText("Said no — could not be removed"),
    ).toBeInTheDocument();
  });

  it("changes nothing for rows sent without a consent key", () => {
    const { container } = render(
      <BookingEditor booking={booking([FAMILY_GUEST])} canModify={false} />,
    );
    expect(screen.getByText("Marama Ngata")).toBeInTheDocument();
    expect(container.textContent).not.toContain("consent");
    expect(container.textContent).not.toContain("Consented");
  });
});
