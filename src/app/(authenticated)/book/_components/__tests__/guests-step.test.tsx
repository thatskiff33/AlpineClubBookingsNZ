// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GuestsStep } from "@/app/(authenticated)/book/_components/guests-step";
import type {
  FamilyMember,
  PriceQuote,
} from "@/app/(authenticated)/book/_components/types";
import type { GuestData } from "@/components/guest-form";

vi.mock("@/components/guest-form", () => ({
  GuestForm: () => <div data-testid="guest-form" />,
}));

function renderGuestsStep(
  overrides: Partial<ComponentProps<typeof GuestsStep>> = {},
) {
  return render(
    <GuestsStep
      checkIn="2026-07-10"
      checkOut="2026-07-12"
      nights={2}
      familyMembers={[]}
      guests={[]}
      lodgeCapacity={8}
      capacityShortNights={[]}
      capacityShortMessage={null}
      addFamilyMemberAsGuest={vi.fn()}
      showInviteFamilyGroupMembersLink={false}
      handleGuestsChange={vi.fn()}
      perGuestDatesEnabled={false}
      handlePerGuestDatesEnabledChange={vi.fn()}
      multiDateRangesEnabled={false}
      handleMultiDateRangesEnabledChange={vi.fn()}
      priceQuote={null}
      groupBookingsEnabled={false}
      groupTrip={false}
      setGroupTrip={vi.fn()}
      groupPaymentMode="EACH_PAYS_OWN"
      setGroupPaymentMode={vi.fn()}
      setStep={vi.fn()}
      handleGuestsDone={vi.fn()}
      priceLoading={false}
      memberGuestEnabled={false}
      memberGuestOpenSearchEnabled={false}
      addMemberGuest={vi.fn()}
      memberGuestAddError={null}
      {...overrides}
    />,
  );
}

/**
 * #2930 fix round — a lodge with no configured capacity resolves to 0 beds by
 * design, so it can never be overbooked before somebody configures it. Read as a
 * party ceiling, that meant "you may add zero guests" — with every add-guest
 * control disabled at zero guests, the step still requiring one guest to
 * continue, and the calendar (since #2930) showing every night at that lodge as
 * full and inviting the member onto the waitlist. Invitation followed by a step
 * with no way forward is the shape this issue exists to remove.
 *
 * Null means no client ceiling. The server is the authority on capacity
 * (settled contract point 3) and its refusal is what offers the waitlist.
 */
describe("GuestsStep party ceiling (#2930)", () => {
  const party = (size: number): GuestData[] =>
    Array.from({ length: size }, (_, i) => ({
      firstName: `G${i}`,
      lastName: "Guest",
      ageTier: "ADULT" as const,
      isMember: false,
    }));

  const family: FamilyMember[] = [
    {
      id: "member-self",
      firstName: "Sam",
      lastName: "Skier",
      ageTier: "ADULT",
      relationship: "self",
    },
  ];

  it("keeps quick-add available when there is no ceiling", () => {
    renderGuestsStep({
      lodgeCapacity: null,
      familyMembers: family,
      guests: party(3),
    });

    expect(
      screen.getByRole("button", { name: /Sam/ }),
    ).not.toBeDisabled();
  });

  it("still enforces a real ceiling", () => {
    renderGuestsStep({
      lodgeCapacity: 3,
      familyMembers: family,
      guests: party(3),
    });

    expect(screen.getByRole("button", { name: /Sam/ })).toBeDisabled();
  });
});

describe("GuestsStep", () => {
  it("keeps the family-profile pointer visible when some family members already exist", () => {
    const familyMembers: FamilyMember[] = [
      {
        id: "member-self",
        firstName: "Sam",
        lastName: "Skier",
        ageTier: "ADULT",
        relationship: "self",
      },
      {
        id: "member-child",
        firstName: "Casey",
        lastName: "Skier",
        ageTier: "CHILD",
        relationship: "dependent",
      },
    ];

    render(
      <GuestsStep
        checkIn="2026-07-10"
        checkOut="2026-07-12"
        nights={2}
        familyMembers={familyMembers}
        guests={[]}
        lodgeCapacity={8}
        addFamilyMemberAsGuest={vi.fn()}
        memberGuestEnabled={false}
        memberGuestOpenSearchEnabled={false}
        addMemberGuest={vi.fn()}
        memberGuestAddError={null}
        capacityShortNights={[]}
        capacityShortMessage={null}
        showInviteFamilyGroupMembersLink={false}
        handleGuestsChange={vi.fn()}
        perGuestDatesEnabled={false}
        handlePerGuestDatesEnabledChange={vi.fn()}
        multiDateRangesEnabled={false}
        handleMultiDateRangesEnabledChange={vi.fn()}
        priceQuote={null}
        groupBookingsEnabled={false}
        groupTrip={false}
        setGroupTrip={vi.fn()}
        groupPaymentMode="EACH_PAYS_OWN"
        setGroupPaymentMode={vi.fn()}
        setStep={vi.fn()}
        handleGuestsDone={vi.fn()}
        priceLoading={false}
      />,
    );

    expect(screen.getByText(/Family member missing/i)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open Family Group in your profile" })
        .getAttribute("href"),
    ).toBe("/profile?returnTo=%2Fbook#family-group");
  });

  it("shows the booker's quick-add in its added (✓) state when self is pre-selected", () => {
    const self: FamilyMember = {
      id: "member-self",
      firstName: "Sam",
      lastName: "Skier",
      ageTier: "ADULT",
      relationship: "self",
      canBeBooked: true,
    };
    const child: FamilyMember = {
      id: "member-child",
      firstName: "Casey",
      lastName: "Skier",
      ageTier: "CHILD",
      relationship: "dependent",
      canBeBooked: true,
    };
    const seededSelf: GuestData = {
      firstName: "Sam",
      lastName: "Skier",
      ageTier: "ADULT",
      isMember: true,
      memberId: "member-self",
    };

    renderGuestsStep({ familyMembers: [self, child], guests: [seededSelf] });

    // The pre-selected booker renders the ✓ added-state button, disabled so it
    // cannot be added twice.
    const selfButton = screen.getByRole("button", { name: "✓ Sam Skier (You)" });
    expect(selfButton).toBeDisabled();

    // A family member not yet in the party still shows the add (+) affordance.
    const childButton = screen.getByRole("button", {
      name: "+ Casey Skier (CHILD)",
    });
    expect(childButton).toBeEnabled();
  });

  describe("member-guest steer (#1942)", () => {
    const bookableChild: FamilyMember = {
      id: "member-child",
      firstName: "Casey",
      lastName: "Skier",
      ageTier: "CHILD",
      relationship: "dependent",
      canBeBooked: true,
    };

    it("suggests switching a typed-in guest that matches a bookable family member", () => {
      const typedMatch: GuestData = {
        // Different case to prove case-insensitive matching.
        firstName: "casey",
        lastName: "SKIER",
        ageTier: "ADULT",
        isMember: false,
      };
      const handleGuestsChange = vi.fn();

      renderGuestsStep({
        familyMembers: [bookableChild],
        guests: [typedMatch],
        handleGuestsChange,
      });

      expect(
        screen.getByText(/Add these as member guests instead/i),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Add as member guest" }),
      );

      expect(handleGuestsChange).toHaveBeenCalledTimes(1);
      const next = handleGuestsChange.mock.calls[0][0] as GuestData[];
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({
        firstName: "Casey",
        lastName: "Skier",
        isMember: true,
        memberId: "member-child",
      });
    });

    it("does not suggest a switch when no family member matches the typed name", () => {
      const typedGuest: GuestData = {
        firstName: "Alex",
        lastName: "Stranger",
        ageTier: "ADULT",
        isMember: false,
      };

      renderGuestsStep({
        familyMembers: [bookableChild],
        guests: [typedGuest],
      });

      expect(
        screen.queryByText(/Add these as member guests instead/i),
      ).not.toBeInTheDocument();
    });

    it("does not suggest a switch for a non-bookable family member match", () => {
      const nonBookable: FamilyMember = {
        id: "member-child",
        firstName: "Casey",
        lastName: "Skier",
        ageTier: "CHILD",
        relationship: "dependent",
        canBeBooked: false,
        pendingRequestStatus: "PENDING",
      };
      const typedMatch: GuestData = {
        firstName: "Casey",
        lastName: "Skier",
        ageTier: "ADULT",
        isMember: false,
      };
      const hold: PriceQuote["nonMemberHoldDecision"] = {
        enabled: true,
        holdDays: 7,
        source: "default",
        daysUntilCheckIn: 30,
        shouldBePending: true,
        status: "PAYMENT_PENDING",
      };

      renderGuestsStep({
        familyMembers: [nonBookable],
        guests: [typedMatch],
        priceQuote: {
          guests: [
            { ageTier: "ADULT", isMember: false, nights: 2, priceCents: 12000 },
          ],
          totalPriceCents: 12000,
          nonMemberHoldDecision: hold,
        },
      });

      expect(
        screen.queryByText(/Add these as member guests instead/i),
      ).not.toBeInTheDocument();
      // The block message gains the provisional consequence when the hold
      // policy applies to the stay.
      expect(
        screen.getByText(/held provisionally/i),
      ).toBeInTheDocument();
    });

    it("warns conditionally for the FIRST non-member add (party has no non-member yet, decision unknown) — FIX 7", () => {
      const nonBookable: FamilyMember = {
        id: "member-child",
        firstName: "Casey",
        lastName: "Skier",
        ageTier: "CHILD",
        relationship: "dependent",
        canBeBooked: false,
        pendingRequestStatus: "PENDING",
      };

      // Empty party (or any all-member party) → the quote can't yet say whether
      // the hold applies, so the consequence is shown with conditional wording
      // instead of being omitted entirely.
      renderGuestsStep({
        familyMembers: [nonBookable],
        guests: [],
        priceQuote: null,
      });

      expect(
        screen.getByText(/awaiting admin approval/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/may be held provisionally/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/depending on how far out your booking is/i),
      ).toBeInTheDocument();
    });

    it("omits the provisional consequence when a non-member is present but the hold does not apply (decision known false) — FIX 7", () => {
      const nonBookable: FamilyMember = {
        id: "member-child",
        firstName: "Casey",
        lastName: "Skier",
        ageTier: "CHILD",
        relationship: "dependent",
        canBeBooked: false,
        pendingRequestStatus: "PENDING",
      };
      const presentNonMember: GuestData = {
        firstName: "Alex",
        lastName: "Stranger",
        ageTier: "ADULT",
        isMember: false,
      };
      const holdInsideWindow: PriceQuote["nonMemberHoldDecision"] = {
        enabled: true,
        holdDays: 7,
        source: "default",
        daysUntilCheckIn: 3,
        shouldBePending: false,
        status: "PAID",
      };

      renderGuestsStep({
        familyMembers: [nonBookable],
        guests: [presentNonMember],
        priceQuote: {
          guests: [
            { ageTier: "ADULT", isMember: false, nights: 2, priceCents: 12000 },
          ],
          totalPriceCents: 12000,
          nonMemberHoldDecision: holdInsideWindow,
        },
      });

      expect(
        screen.getByText(/awaiting admin approval/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/held provisionally/i),
      ).not.toBeInTheDocument();
    });

    it("preserves a guest's per-night selection when switching them to a member guest (#713 / FIX 5)", () => {
      const typedMatch: GuestData = {
        firstName: "casey",
        lastName: "SKIER",
        ageTier: "ADULT",
        isMember: false,
        stayStart: "2026-07-10",
        stayEnd: "2026-07-12",
        nights: ["2026-07-10", "2026-07-11"],
      };
      const handleGuestsChange = vi.fn();

      renderGuestsStep({
        familyMembers: [bookableChild],
        guests: [typedMatch],
        handleGuestsChange,
        perGuestDatesEnabled: true,
        multiDateRangesEnabled: true,
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Add as member guest" }),
      );

      const next = handleGuestsChange.mock.calls[0][0] as GuestData[];
      expect(next[0]).toMatchObject({
        firstName: "Casey",
        lastName: "Skier",
        isMember: true,
        memberId: "member-child",
        stayStart: "2026-07-10",
        stayEnd: "2026-07-12",
        nights: ["2026-07-10", "2026-07-11"],
      });
    });
  });
});
