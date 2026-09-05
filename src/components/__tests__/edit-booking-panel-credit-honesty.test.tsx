// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #2266 review fixes — the panel's money honesty:
//
// MED-3: an UNTOUCHED stored credit election is never silently rewritten by an
//        unrelated save just because the member's live balance happens to be
//        low — the stored value follows only the booking-local price (the
//        balance clamp lives at the pay-time consumer, #2265/#2319).
// MED-5: the "Account credit applied" line shows the figure the server will
//        actually keep after the F20 clamp, and names the refund to balance
//        when the clamp reduces it.
// LOW-6: "Remaining to pay" includes the late-notice change fee (its own line
//        keeps the sum transparent), so it matches what the invoice will say.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-2266-credit";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type CapturedPut = { url: string; body: Record<string, unknown> };

function installFetch(
  quoteOverrides: Record<string, unknown> = {},
  capturedPuts: CapturedPut[] = [],
) {
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT" && url.includes("/modify")) {
      capturedPuts.push({ url, body: JSON.parse(String(init.body)) });
      return jsonResponse({ booking: { id: BOOKING_ID } });
    }
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/promo-codes/available")) {
      return jsonResponse([]);
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      return jsonResponse({
        newTotalPriceCents: 30000,
        newDiscountCents: 0,
        newPromoAdjustmentCents: 0,
        newFinalPriceCents: 30000,
        priceDiffCents: 0,
        changeFeeCents: 0,
        netChargeCents: 0,
        settlementOptions: null,
        availableCreditCents: 200,
        capacityAvailable: true,
        minimumStayValid: true,
        minimumStayViolations: [],
        promoStillValid: true,
        promoValidation: null,
        itemizedChanges: [],
        ...quoteOverrides,
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function futureBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-14",
    checkOut: "2026-09-18",
    guests: [
      {
        id: "g1",
        firstName: "Mel",
        lastName: "Member",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 20000,
      },
      {
        id: "g2",
        firstName: "Nora",
        lastName: "Nonmember",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 10000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 30000,
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: false,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-15",
      editableFrom: "2026-09-14",
      checkInEditable: true,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MED-3 — an untouched stored election is never rewritten for a balance dip", () => {
  it("leaves the stored value byte-unchanged on an unrelated edit while the balance sits below it", async () => {
    const capturedPuts: CapturedPut[] = [];
    // Stored election $5.00; live balance only $2.00. The unrelated edit (a
    // guest-name fix) must NOT send applyCreditCents at all — the old min()
    // would have rewritten the stored 500 to 200 forever.
    installFetch({ availableCreditCents: 200 }, capturedPuts);
    render(
      <EditBookingPanel
        booking={futureBooking({
          credit: { availableCents: 200, electionCents: 500, appliedCents: 0 },
        })}
        onDone={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("First Name"), {
      target: { value: "Norah" },
    });

    const save = await screen.findByRole("button", { name: /save changes/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(capturedPuts).toHaveLength(1));
    expect(capturedPuts[0].body).not.toHaveProperty("applyCreditCents");
    expect(capturedPuts[0].body.guestUpdates).toEqual([
      { guestId: "g2", firstName: "Norah", lastName: "Nonmember" },
    ]);
  });

  it("tells the member the balance is currently below the saved choice, without touching it", async () => {
    installFetch({ availableCreditCents: 200 });
    render(
      <EditBookingPanel
        booking={futureBooking({
          credit: { availableCents: 200, electionCents: 500, appliedCents: 0 },
        })}
        onDone={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/below this saved choice/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The choice stays saved in full/i),
    ).toBeInTheDocument();
  });

  it("still follows a reprice of this very edit (price cap), ignoring the balance", async () => {
    const capturedPuts: CapturedPut[] = [];
    // The edit itself reprices the booking to $3.00 uncovered, below the
    // stored $5.00 election: reprice-follow clamps to the PRICE (300), never
    // to the $2.00 balance.
    installFetch(
      { newFinalPriceCents: 300, newTotalPriceCents: 300, availableCreditCents: 200 },
      capturedPuts,
    );
    render(
      <EditBookingPanel
        booking={futureBooking({
          credit: { availableCents: 200, electionCents: 500, appliedCents: 0 },
        })}
        onDone={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Check-out"), {
      target: { value: "2026-09-17" },
    });

    const save = await screen.findByRole("button", { name: /save changes/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(capturedPuts).toHaveLength(1));
    expect(capturedPuts[0].body.applyCreditCents).toBe(300);
  });
});

describe("MED-5 — the applied-credit line shows what the server will keep", () => {
  it("clamps the displayed applied credit to the new price and names the refund to balance", async () => {
    // $80.00 applied, but this edit reprices the booking to $60.00: the save
    // clamps the applied slice to $60.00 (F20) and refunds $20.00 to balance.
    installFetch({
      newFinalPriceCents: 6000,
      newTotalPriceCents: 6000,
      priceDiffCents: -24000,
      netChargeCents: -24000,
      availableCreditCents: 0,
    });
    render(
      <EditBookingPanel
        booking={futureBooking({
          credit: { availableCents: 0, electionCents: null, appliedCents: 8000 },
        })}
        onDone={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Check-out"), {
      target: { value: "2026-09-15" },
    });

    expect(await screen.findByText("Account credit applied")).toBeInTheDocument();
    expect(screen.getByText("-$60.00")).toBeInTheDocument();
    expect(
      screen.getByText(/\$20\.00 returns to your account credit/i),
    ).toBeInTheDocument();
    // Nothing left to pay: price is fully covered by the clamped credit.
    const remainingRow = screen.getByText("Remaining to pay").closest("div");
    expect(remainingRow).toHaveTextContent("$0.00");
  });

  it("shows the full applied credit, and no refund line, when the price still covers it", async () => {
    installFetch({
      newFinalPriceCents: 26000,
      newTotalPriceCents: 26000,
      priceDiffCents: -4000,
      netChargeCents: -4000,
      availableCreditCents: 0,
    });
    render(
      <EditBookingPanel
        booking={futureBooking({
          credit: { availableCents: 0, electionCents: null, appliedCents: 8000 },
        })}
        onDone={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Check-out"), {
      target: { value: "2026-09-17" },
    });

    expect(await screen.findByText("Account credit applied")).toBeInTheDocument();
    expect(screen.getByText("-$80.00")).toBeInTheDocument();
    expect(
      screen.queryByText(/returns to your account credit/i),
    ).not.toBeInTheDocument();
    // 26000 - 8000 = 18000 remaining.
    const remainingRow = screen.getByText("Remaining to pay").closest("div");
    expect(remainingRow).toHaveTextContent("$180.00");
  });
});

describe("LOW-6 — the change fee is part of what remains to pay", () => {
  it("adds the fee as its own line and includes it in Remaining to pay", async () => {
    installFetch({
      newFinalPriceCents: 30000,
      newTotalPriceCents: 30000,
      changeFeeCents: 1500,
      priceDiffCents: 0,
      netChargeCents: 1500,
      availableCreditCents: 0,
      itemizedChanges: [
        { label: "Late-notice change fee", amountCents: 1500 },
      ],
    });
    render(
      <EditBookingPanel
        booking={futureBooking({
          credit: { availableCents: 0, electionCents: null, appliedCents: 1000 },
        })}
        onDone={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Check-in"), {
      target: { value: "2026-09-15" },
    });

    expect(await screen.findByText("Remaining to pay")).toBeInTheDocument();
    // The totals block carries its own fee line (the itemised list above the
    // totals shows it too), so the sum below is transparent.
    expect(screen.getAllByText("Late-notice change fee").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+$15.00").length).toBeGreaterThan(0);
    // 30000 - 1000 + 1500 = 30500.
    const remainingRow = screen.getByText("Remaining to pay").closest("div");
    expect(remainingRow).toHaveTextContent("$305.00");
  });
});
