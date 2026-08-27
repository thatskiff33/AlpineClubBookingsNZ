// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromoRedemptionsPanel } from "@/app/(admin)/admin/promo-codes/promo-redemptions-panel";

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

const RESPONSE = {
  code: {
    id: "promo-1",
    code: "WINTER20",
    description: "Winter discount",
    type: "PERCENTAGE",
    active: true,
    archived: false,
    internal: false,
    capUsage: { redemptions: 1, uniqueMembers: 2 },
    caps: {
      maxRedemptionsTotal: null,
      maxUniqueMembersTotal: null,
      maxUsesPerMember: null,
      lifetimeFreeNightsCap: null,
    },
  },
  totals: {
    all: {
      redemptions: 1,
      uniqueMembers: 1,
      discountCents: 2000,
      freeNightsUsed: 0,
      benefitFreeRedemptions: 0,
    },
    filtered: {
      redemptions: 1,
      uniqueMembers: 1,
      discountCents: 2000,
      freeNightsUsed: 0,
      benefitFreeRedemptions: 0,
    },
  },
  pagination: { page: 1, pageSize: 50, total: 1 },
  rows: [
    {
      id: "redemption-1",
      createdAt: "2026-07-01T10:00:00.000Z",
      member: { id: "member-1", name: "Jane Doe", email: "jane@example.test" },
      booking: {
        id: "booking-1",
        reference: "ABC123",
        lodgeId: "lodge-1",
        lodgeName: "Lodge One",
        checkIn: "2026-07-10",
        checkOut: "2026-07-12",
        nights: 2,
      },
      eligibleGuestCount: 2,
      discountCents: 2000,
      priceAdjustmentCents: 0,
      freeNightsUsed: 0,
      gaveBenefit: true,
      memberUseIndex: 1,
      allocations: [
        {
          memberId: "member-1",
          name: "Jane Doe",
          discountCents: 1000,
          freeNightsUsed: 0,
        },
        {
          memberId: "member-2",
          name: "John Doe",
          discountCents: 1000,
          freeNightsUsed: 0,
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PromoRedemptionsPanel Reset", () => {
  it("preserves expanded rows on Reset but collapses them on an ordinary filter change", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => RESPONSE,
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PromoRedemptionsPanel
        promo={{
          id: "promo-1",
          code: "WINTER20",
          description: "Winter discount",
          type: "PERCENTAGE",
          archived: false,
        }}
        onBack={() => undefined}
      />,
    );

    await screen.findByText("ABC123");
    fireEvent.change(screen.getByLabelText("Redeemed from"), {
      target: { value: "2026-07-01" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Show member split" }));
    expect(screen.getByText("Per-member split (2 members)")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Per-member split (2 members)")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Redeemed to"), {
      target: { value: "2026-07-31" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(screen.queryByText("Per-member split (2 members)")).toBeNull();
  });
});
