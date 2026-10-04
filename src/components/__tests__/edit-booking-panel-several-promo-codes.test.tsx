// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #3828 (review E1): a booking carrying several promo codes reaches the panel
// as `promo: null` plus `promoLines`. The one-code card would read that as "no
// code — apply one", and applying would send the legacy one-code request, which
// replaces every code on the booking. The card is locked instead, and the
// codes are shown read-only — unless (#3492) the club's `multiPromoCodes`
// switch is on, where the list editor edits the codes through `promoCodes`,
// the one field the server never refuses on such a booking.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type Captured = { url: string; body: Record<string, unknown> };
let quoteBodies: Captured[] = [];
let saveBodies: Captured[] = [];

/** `multiPromoCodes`: the guest-code lookup's answer; `"pending"` never answers. */
function installFetch(multiPromoCodes: boolean | "pending") {
  quoteBodies = [];
  saveBodies = [];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT" && url.includes("/modify")) {
      saveBodies.push({ url, body: JSON.parse(String(init.body)) });
      return jsonResponse({ booking: { id: "bk-3828" } });
    }
    if (url.includes("/modify-quote")) {
      quoteBodies.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({
        newTotalPriceCents: 12000,
        newDiscountCents: 5000,
        newPromoAdjustmentCents: -3000,
        newFinalPriceCents: 9000,
        priceDiffCents: 2000,
        changeFeeCents: 0,
        netChargeCents: 2000,
        settlementOptions: null,
        availableCreditCents: 0,
        capacityAvailable: true,
        minimumStayValid: true,
        minimumStayViolations: [],
        promoStillValid: true,
        promoValidation: null,
        itemizedChanges: [],
      });
    }
    if (url.includes("/api/promo-codes/guest-codes")) {
      if (multiPromoCodes === "pending") return new Promise<Response>(() => {});
      return jsonResponse({ multiPromoCodes, guests: [] });
    }
    if (url.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

beforeEach(() => installFetch(false));

const SEVERAL = {
  promo: null,
  promoLines: [
    { code: "SPRING10", type: "PERCENTAGE", description: null, amountCents: -3000 },
    { code: "GUESTFREE", type: "FREE_NIGHTS", description: null, amountCents: -2000 },
  ],
};

/** No request this panel sent carries a one-code field. */
function expectNoOneCodeField(bodies: Captured[]) {
  for (const { body } of bodies) {
    expect(body).not.toHaveProperty("promoCode");
    expect(body).not.toHaveProperty("removePromoCode");
  }
}

function makeBooking(promo: {
  promo: { code: string; type: string; description: string | null } | null;
  promoLines?: Array<{ code: string; type: string; description: string | null; amountCents: number }>;
}) {
  return {
    id: "bk-3828",
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: [
      {
        id: "g1",
        firstName: "Ann",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-ann",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 7000,
    totalPriceCents: 12000,
    discountCents: 5000,
    promoAdjustmentCents: -5000,
    ...promo,
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: true,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
  };
}

describe("EditBookingPanel on a several-code booking (#3828)", () => {
  it.each([
    ["the club's multiPromoCodes switch is off", false],
    ["the switch has not answered yet", "pending"],
  ] as const)("locks the one-code controls and shows the codes read-only when %s", async (_label, mode) => {
    installFetch(mode);
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);

    expect(await screen.findByText(/can't be added, removed or swapped here/)).toBeInTheDocument();
    expect(screen.getByText("Promo Codes")).toBeInTheDocument();
    expect(screen.getByText("SPRING10")).toBeInTheDocument();
    expect(screen.getByText("GUESTFREE")).toBeInTheDocument();
    // No one-code card: nothing to apply, remove or replace a code with.
    expect(screen.queryByText("Promo Code")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /promo/i })).not.toBeInTheDocument();
  });

  it("keeps a one-code booking's card as it was", async () => {
    render(
      <EditBookingPanel
        booking={makeBooking({
          promo: { code: "SPRING10", type: "PERCENTAGE", description: null },
        })}
        onDone={vi.fn()}
      />,
    );

    expect(await screen.findByText("Promo Code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByText("Promo Codes")).not.toBeInTheDocument();
  });
});

describe("EditBookingPanel on a several-code booking with the switch on (#3492)", () => {
  beforeEach(() => installFetch(true));

  it("offers the list editor instead of the lock, with no one-code control", async () => {
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Remove SPRING10" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove GUESTFREE" })).toBeInTheDocument();
    expect(screen.queryByText(/can't be added, removed or swapped here/)).not.toBeInTheDocument();
    expect(screen.queryByText("Promo Code")).not.toBeInTheDocument();
  });

  it("removes one code by sending the list, keeping the other code", async () => {
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove SPRING10" }));

    await waitFor(() =>
      expect(quoteBodies.at(-1)?.body.promoCodes).toEqual([{ code: "GUESTFREE" }]),
    );
    const save = await screen.findByRole("button", { name: /save changes/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(saveBodies).toHaveLength(1));
    expect(saveBodies[0].body.promoCodes).toEqual([{ code: "GUESTFREE" }]);
    expectNoOneCodeField([...quoteBodies, ...saveBodies]);
  });

  it("reorders the codes by sending the whole list in its new order", async () => {
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Move GUESTFREE earlier" }));

    await waitFor(() =>
      expect(quoteBodies.at(-1)?.body.promoCodes).toEqual([
        { code: "GUESTFREE" },
        { code: "SPRING10" },
      ]),
    );
    expectNoOneCodeField(quoteBodies);
  });
});
