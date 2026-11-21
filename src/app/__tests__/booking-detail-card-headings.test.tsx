// @vitest-environment jsdom
/**
 * #5216 (`INV-PUB-006`) — the cards /bookings/[id] draws beside the booking
 * editor keep the page's outline sound: one "Booking Details" h1, and each
 * card's title a level-2 heading under it.
 *
 * `page.tsx` renders its h1 and then these cards as siblings: the officer's
 * Admin tools card, the officer's view of an outstanding additional payment,
 * and the guest's own consent card, which changes title as the guest answers.
 * Each is rendered for real (the payment panel is an async server component,
 * so it is awaited first) under that h1. The booking editor's own cards are
 * covered by `src/components/edit-booking/__tests__/heading-outline.test.tsx`.
 */
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { bindClubFormat } from "@/lib/club-format-bound";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { expectSoundOutline, headingOutline } from "@/lib/__tests__/support/heading-outline";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-1", adminPermissionMatrix: { bookings: "edit", finance: "edit" } } },
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: async () => bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST),
}));
vi.mock("@/lib/club-format-server", () => ({
  clubFormat: async () => bindClubFormat(CLUB_FORMAT_TEST),
}));

import { AdminBookingToolsCard } from "@/components/admin/admin-booking-tools-card";
import { BookingAdditionalPaymentPanel } from "@/components/admin/booking-additional-payment-panel";
import { MemberGuestConsentCard } from "@/components/member-guest-consent-card";

afterEach(() => {
  vi.restoreAllMocks();
});

const allFeaturesOn = Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as FeatureFlags;

function renderBookingPage(cards: ReactNode) {
  return render(
    <>
      <h1>Booking Details</h1>
      {cards}
    </>,
  );
}

function adminToolsCard({ showConfirmPendingGuests = false } = {}) {
  return (
    <AdminBookingToolsCard
      bookingId="bk-5216"
      memberId="member-1"
      memberName="Aroha Ngata"
      checkIn={new Date("2026-08-03T00:00:00.000Z")}
      checkOut={new Date("2026-08-05T00:00:00.000Z")}
      lodgeId="lodge-1"
      copyProps={{ sourceCheckIn: "2026-08-03", sourceCheckOut: "2026-08-05", minCheckIn: "2026-07-01" }}
      isDeleted={false}
      paymentId="pay-1"
      showConfirmPendingGuests={showConfirmPendingGuests}
      hasSavedPaymentMethod={false}
      savedCardChargeCents={0}
      features={allFeaturesOn}
    />
  );
}

async function additionalPaymentPanel() {
  return BookingAdditionalPaymentPanel({
    bookingId: "bk-5216",
    bookingStatus: "CONFIRMED",
    payment: {
      additionalAmountCents: 4_000,
      additionalPaymentStatus: "PENDING",
      additionalReminderSentAt: null,
      additionalFinalReminderSentAt: null,
    },
    requestedOn: new Date("2026-06-28T00:00:00.000Z"),
    canResend: true,
    canWithdraw: true,
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
}

function consentCard() {
  return (
    <MemberGuestConsentCard
      bookingId="bk-5216"
      guestId="bg-5216"
      bookerName="Dave Ngata"
      bookerFirstName="Dave"
      lodgeName="Main Lodge"
      stayLabel="Mon 3 Aug – Wed 5 Aug 2026 (2 nights)"
      nightsLabel="Mon 3 Aug, Tue 4 Aug"
      nightsCountLabel="two nights"
      answerByLabel="Sun 2 Aug 2026"
      lapseByLabel="Sun 2 Aug"
      party={[
        { name: "Dave Ngata", isViewer: false },
        { name: "Priya Kaur", isViewer: true },
      ]}
      quotePriced={false}
      refusalWarning={null}
    />
  );
}

function levelTwoTitles() {
  return headingOutline()
    .filter((entry) => entry.level === 2)
    .map((entry) => entry.name);
}

describe("the officer's cards on /bookings/[id] (#5216)", () => {
  it("title Admin tools and the outstanding payment at level 2 under the page h1", async () => {
    const panel = await additionalPaymentPanel();
    renderBookingPage(
      <>
        {adminToolsCard()}
        {panel}
      </>,
    );

    expectSoundOutline("Booking Details");
    expect(levelTwoTitles()).toEqual(
      expect.arrayContaining(["Admin tools", "Additional payment outstanding"]),
    );
  });

  it("titles Confirm pending guests now at level 2 beside Admin tools", () => {
    renderBookingPage(adminToolsCard({ showConfirmPendingGuests: true }));

    expectSoundOutline("Booking Details");
    expect(levelTwoTitles()).toEqual(
      expect.arrayContaining(["Admin tools", "Confirm pending guests now"]),
    );
  });
});

describe("the guest's consent card on /bookings/[id] (#5216)", () => {
  function answer(button: "Yes, add me" | "No thanks", outcome: string) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ outcome }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fireEvent.click(screen.getByRole("button", { name: button }));
  }

  it("titles the question at level 2", () => {
    renderBookingPage(consentCard());

    expectSoundOutline("Booking Details");
    expect(levelTwoTitles()).toEqual(["Dave Ngata has added you to this booking"]);
  });

  it("titles the accepted outcome at level 2", async () => {
    renderBookingPage(consentCard());
    answer("Yes, add me", "APPROVED");

    await screen.findByRole("heading", { level: 2, name: "You're on this booking" });
    expectSoundOutline("Booking Details");
  });

  it("titles the declined outcome at level 2", async () => {
    renderBookingPage(consentCard());
    answer("No thanks", "DECLINED");

    await screen.findByRole("heading", { level: 2, name: "You've said no" });
    expectSoundOutline("Booking Details");
  });
});
