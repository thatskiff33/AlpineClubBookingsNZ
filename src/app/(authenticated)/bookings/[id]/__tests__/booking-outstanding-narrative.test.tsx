import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { resolveBookingNarrative, type NarrativeEvent } from "@/lib/booking-narrative";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { bindClubFormat } from "@/lib/club-format-bound";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { BookingStatusBanners } from "../_components/booking-status-banners";
const club = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);
function narrative(pending: boolean, events: NarrativeEvent[] = []) {
  return resolveBookingNarrative({ booking: { status: "COMPLETED", firstName: "Member", finalPriceCents: 3000,
    adminReviewStatus: null, adminReviewNotes: null, adminReviewReason: null,
    amountOwed: { owedCents: 3000, dueCents: 3000, appliedCreditCents: 0 }, checkIn: new Date("2026-06-01T00:00:00Z"), checkOut: new Date("2026-06-02T00:00:00Z") },
    events, club, additionalCollectionPending: pending }, CLUB_FORMAT_TEST);
}
describe("additional evidence and the status narrative", () => {
  it("suppresses no-payment/nothing-more-to-do reassurance for positive or unknown extras", () => {
    expect(narrative(true).message).not.toContain("No payment was required");
    expect(narrative(true).nextStep).not.toContain("Nothing more to do");
    expect(narrative(false).message).toContain("No payment was required");
  });
  it("preserves durable received-payment facts while an additional amount is owed", () => {
    const result = narrative(true, [{ type: "MEMBER_PAID", occurredAt: new Date("2026-06-01T00:00:00Z"), amountCents: 5000, reason: null, snapshot: null }]);
    expect(result.message).toContain("received your payment of $50.00");
    expect(result.nextStep).not.toContain("Nothing more to do");
  });
  it("keeps a linked guest's confirmation neutral while officers who are also guests see money", () => {
    const received = narrative(true, [{ type: "MEMBER_PAID", occurredAt: new Date("2026-06-01T00:00:00Z"), amountCents: 5000, reason: null, snapshot: null }]);
    const render = (canSeeOwnerCredit: boolean) => renderToStaticMarkup(<BookingStatusBanners
      booking={{ status: "COMPLETED", creditElectionCents: null } as never} club={club} money={bindClubFormat(CLUB_FORMAT_TEST)}
      viewer={{ isBookingOwner: false, nonOwnerAdminViewer: canSeeOwnerCredit, isLinkedGuestViewer: true, canSeeOwnerCredit } as never}
      access={{ isDeleted: false } as never} party={{} as never} payment={{ showCompletePaymentCard: false } as never}
      history={{ bookingNarrative: received, moneyReconciliation: { visibility: "WITHHELD" } } as never} messages={{} as never} />);
    expect(render(false)).toContain("This stay is confirmed");
    expect(render(false)).not.toContain("$50.00");
    expect(render(true)).toContain("$50.00");
  });
});
