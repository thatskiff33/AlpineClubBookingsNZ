// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { AdminBookingToolsCard } from "@/components/admin/admin-booking-tools-card";

// #1997: the admin tools sub-controls now derive view-only gating from the
// session matrix via useAdminAreaEditAccess("bookings"). Mock an all-edit admin
// so the existing capacity/exclusive-hold gating assertions hold.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const allFeaturesOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

type CardProps = Partial<ComponentProps<typeof AdminBookingToolsCard>>;

function renderCard(features: FeatureFlags, overrides: CardProps = {}) {
  return render(
    <AdminBookingToolsCard
      bookingId="booking-1"
      memberId="member-1"
      memberName="Aroha Ngata"
      checkIn={new Date("2026-07-01T00:00:00.000Z")}
      checkOut={new Date("2026-07-03T00:00:00.000Z")}
      lodgeId="lodge-1"
      copyProps={{
        sourceCheckIn: "2026-07-01",
        sourceCheckOut: "2026-07-03",
        minCheckIn: "2026-06-01",
      }}
      isDeleted={false}
      paymentId={null}
      showConfirmPendingGuests={false}
      hasSavedPaymentMethod={false}
      finalPriceCents={10000}
      features={features}
      {...overrides}
    />,
  );
}

/** Exclusive-hold state (#121, #173) with sensible non-held defaults. */
function exclusiveHold(
  overrides: Partial<
    NonNullable<ComponentProps<typeof AdminBookingToolsCard>["exclusiveHold"]>
  > = {},
) {
  return {
    wholeLodgeHold: false,
    wholeLodgeHoldAt: null,
    heldByName: null,
    holdsCapacity: true,
    conflicts: [],
    ...overrides,
  };
}

describe("AdminBookingToolsCard", () => {
  // #2649. The repair is offered on exactly one shape, and the page decides it.
  // A button that can only refuse is worse than no button: it invites an
  // operator to act on a booking that is not stranded and reads as a general
  // "un-confirm" tool, which it deliberately is not.
  describe("return to waitlist (#2649)", () => {
    it("offers the repair when the page says the booking is stranded", () => {
      renderCard(allFeaturesOn, { showReturnToWaitlist: true });

      expect(
        screen.getByRole("button", { name: "Return to waitlist" }),
      ).toBeTruthy();
      expect(
        screen.getByText("Waitlist confirmation did not finish"),
      ).toBeTruthy();
    });

    it("renders nothing about it on an ordinary booking", () => {
      renderCard(allFeaturesOn);

      expect(
        screen.queryByRole("button", { name: "Return to waitlist" }),
      ).toBeNull();
      expect(
        screen.queryByText("Waitlist confirmation did not finish"),
      ).toBeNull();
    });

    it("states the consequence for an admin-held booking before the officer presses", async () => {
      // #2649 review S3. The repair releases an admin capacity hold or an
      // exclusive whole-lodge hold along with the status, freeing those nights
      // to the next member. That has to be said in the dialog, not discovered
      // in the audit log afterwards.
      renderCard(allFeaturesOn, {
        showReturnToWaitlist: true,
        returnToWaitlistReleasesHold: true,
      });

      fireEvent.click(screen.getByRole("button", { name: "Return to waitlist" }));

      expect(
        await screen.findByText(/also carries an admin hold on its nights/),
      ).toBeTruthy();
    });

    it("says nothing about a hold when the booking has none", async () => {
      renderCard(allFeaturesOn, { showReturnToWaitlist: true });

      fireEvent.click(screen.getByRole("button", { name: "Return to waitlist" }));

      // The dialog opens either way; only the hold sentence is conditional.
      expect(
        await screen.findByText(/Put this booking back on the waitlist\?/),
      ).toBeTruthy();
      expect(
        screen.queryByText(/also carries an admin hold on its nights/),
      ).toBeNull();
    });
  });

  it("shows the bed allocation link when the module is enabled", () => {
    renderCard(allFeaturesOn);

    const link = screen.getByRole("link", { name: "Bed allocation" });

    expect(link.getAttribute("href")).toContain("/admin/bed-allocation?");
    expect(link.getAttribute("href")).toContain("bookingId=booking-1");
    expect(link.getAttribute("href")).toContain("from=2026-07-01");
    expect(link.getAttribute("href")).toContain("to=2026-07-03");
    // #2678: without the lodge this link opened the board CLUB-WIDE with the
    // booking focused, so its bed pickers offered every lodge's beds for this
    // booking's guests — a choice the writer then refused. The API derives the
    // same lodge from `bookingId`; this keeps the board's own lodge selector
    // agreeing with the scope it was served instead of claiming "all lodges".
    expect(link.getAttribute("href")).toContain("lodgeId=lodge-1");
  });

  it("hides the bed allocation link when the module is disabled", () => {
    renderCard({ ...allFeaturesOn, bedAllocation: false });

    expect(
      screen.queryByRole("link", { name: "Bed allocation" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Member: Aroha Ngata" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Xero activity" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Audit log" })).toBeTruthy();
  });

  // Exclusive whole-lodge hold Set gating (issue #173, H2): the Set control is
  // only offered on capacity-holding bookings — a hold on a non-holding booking
  // blocks nothing (ADR-001 capacity rule) — while clearing an existing hold is
  // always allowed.
  describe("exclusive hold Set gating", () => {
    it("enables Set for a capacity-holding booking with no hold", () => {
      renderCard(allFeaturesOn, {
        exclusiveHold: exclusiveHold({ holdsCapacity: true }),
      });

      const setButton = screen.getByRole("button", {
        name: "Set exclusive hold",
      });
      expect(setButton).toBeTruthy();
      expect((setButton as HTMLButtonElement).disabled).toBe(false);
      expect(
        screen.queryByText(/does not hold lodge capacity/i),
      ).toBeNull();
    });

    it("disables Set with an explanatory hint for a non-capacity-holding booking", () => {
      renderCard(allFeaturesOn, {
        exclusiveHold: exclusiveHold({ holdsCapacity: false }),
      });

      const setButton = screen.getByRole("button", {
        name: "Set exclusive hold",
      });
      expect((setButton as HTMLButtonElement).disabled).toBe(true);
      expect(
        screen.getByText(/does not hold lodge capacity/i),
      ).toBeTruthy();
      expect(
        screen.getByText(/apply an admin capacity hold first/i),
      ).toBeTruthy();
    });

    it("keeps Clear enabled even when the booking is not capacity-holding", () => {
      renderCard(allFeaturesOn, {
        exclusiveHold: exclusiveHold({
          wholeLodgeHold: true,
          holdsCapacity: false,
        }),
      });

      const clearButton = screen.getByRole("button", {
        name: "Clear exclusive hold",
      });
      expect((clearButton as HTMLButtonElement).disabled).toBe(false);
      // No Set control is rendered while a hold is in place.
      expect(
        screen.queryByRole("button", { name: "Set exclusive hold" }),
      ).toBeNull();
    });
  });
});
