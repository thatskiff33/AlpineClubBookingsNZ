import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/waitlist", () => ({ WAITLIST_OFFER_HOURS: 48 }));

import { bindClubFormat } from "@/lib/club-format-bound";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { BookingPaymentCards } from "../_components/booking-payment-cards";

/**
 * #5402: the waitlist card shows the position the page read from the live
 * queue on this request, never the number stored on the booking when it
 * joined (which is null for every new entry and wrong once anyone ahead left).
 */
function render(waitlistPosition: number | null, storedPosition: number | null) {
  return renderToStaticMarkup(
    <BookingPaymentCards
      booking={{ id: "booking-1", status: "WAITLISTED", finalPriceCents: 10_000, waitlistPosition: storedPosition, payment: null } as never}
      waitlistPosition={waitlistPosition}
      club={{} as never}
      money={bindClubFormat(CLUB_FORMAT_TEST)}
      viewer={{ canManageBooking: true, isBookingOwner: true, nonOwnerAdminViewer: false, canSeeAdminTools: false, canEditFinance: false } as never}
      access={{ isDeleted: false, isDraft: false, isWaitlisted: true, isWaitlistOffered: false } as never}
      party={{ hasProvisionalChildren: false, provisionalChildGuestCount: 0 } as never}
      payment={{ internetBankingPayment: null } as never}
      messages={{} as never}
    />,
  );
}

describe("member booking page waitlist position (#5402)", () => {
  it("shows the position it was passed, not the stored one", () => {
    const html = render(1, 3);
    expect(html).toContain("On the Waitlist");
    expect(html).toContain("Position: #1<");
    expect(html).not.toContain("#3");
  });

  it("shows no number when none is passed, even with a stored one", () => {
    const html = render(null, 2);
    expect(html).toContain("On the Waitlist");
    expect(html).not.toContain("Position:");
  });
});
