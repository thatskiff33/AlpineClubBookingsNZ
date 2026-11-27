// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

/*
  #5238 (`INV-MOD-062`): the save refuses 409 `EDIT_FIGURES_REQUIRED` when it
  carries no figures, so every kind of edit the panel can save must send the
  figures its preview returned. One case per kind of edit, each through the
  panel's real controls: a kind that saved without them would leave the member
  looking at "This page is out of date" on a page that is not.

  The preview's own half (every 200 carries `quotedFigures`) is
  `modify-quote-figures-census.test.ts`; accepting a linked move, whose figures
  come from the offer, is `edit-booking-panel-linked-move.test.tsx`.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-5238";
const FIGURES = { newFinalPriceCents: 7_000, priceDiffCents: -3_000, changeFeeCents: 0, netChargeCents: -3_000 };

type Body = Record<string, unknown>;
let modifyBodies: Body[];
let quoteOverrides: Body;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
  modifyBodies = [];
  quoteOverrides = {};
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/members/family") || url.includes("/eligible-family")) {
      return jsonResponse({
        familyMembers: [],
        partnerSharingCandidates: [
          { id: "m-partner", firstName: "Pat", lastName: "Partner", partnerOfMemberId: "m-ada", partnerOfName: "Ada Adult" },
        ],
      });
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/modify-quote")) {
      return jsonResponse({
        newTotalPriceCents: FIGURES.newFinalPriceCents,
        newDiscountCents: 0,
        newPromoAdjustmentCents: 0,
        ...FIGURES,
        settlementOptions: null,
        capacityAvailable: true,
        promoStillValid: true,
        promoValidation: null,
        itemizedChanges: [],
        quotedFigures: FIGURES,
        ...quoteOverrides,
      });
    }
    if (url.endsWith(`/api/bookings/${BOOKING_ID}/modify`)) {
      modifyBodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
      return jsonResponse({ booking: { id: BOOKING_ID } });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function guest(id: string, firstName: string, isMember: boolean) {
  return {
    id,
    firstName,
    lastName: "Adult",
    ageTier: "ADULT",
    isMember,
    memberId: isMember ? `m-${firstName.toLowerCase()}` : null,
    stayStart: null,
    stayEnd: null,
    nights: null,
    priceCents: 5_000,
  };
}

function makeBooking(overrides: Body = {}) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: [guest("g1", "Ada", true), guest("g2", "Bee", false)],
    viewerRole: "MEMBER",
    finalPriceCents: 10_000,
    totalPriceCents: 10_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: true,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
      adminOverrideAvailable: true,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
    ...overrides,
  };
}

async function pressSave() {
  const save = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 3000 });
  fireEvent.click(save);
}

/** An officer's save asks whether to email the member first. */
async function pressSaveAsOfficer() {
  await pressSave();
  fireEvent.click(await screen.findByRole("button", { name: "Save and email member" }));
}

async function moveOverrideCheckIn(mode: RegExp) {
  fireEvent.click(screen.getByLabelText(/Move locked\/past dates \(admin override\)/i));
  fireEvent.click(screen.getByLabelText(mode));
  fireEvent.change(screen.getByLabelText("Check-in"), { target: { value: "2026-09-02" } });
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — every kind of save carries its preview's figures (#5238)", () => {
  const cases: Array<[string, () => Promise<void>, Body]> = [
    [
      "a member removing a guest",
      async () => {
        render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
        fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
        await pressSave();
      },
      {},
    ],
    [
      "a member correcting a guest's name (identity only)",
      async () => {
        render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
        fireEvent.change(document.getElementById("guest-g2-first")!, { target: { value: "Bea" } });
        await pressSave();
      },
      {},
    ],
    [
      "a spelling correction on a paid booking (name typo)",
      async () => {
        render(<EditBookingPanel booking={makeBooking({ canEditNonMemberGuestNames: false })} onDone={vi.fn()} />);
        fireEvent.change(document.getElementById("guest-g2-first")!, { target: { value: "Bea" } });
        await pressSave();
      },
      {},
    ],
    [
      "a reduction that asks where the money goes",
      async () => {
        quoteOverrides = {
          settlementOptions: {
            basisAmountCents: 3_000,
            cardRefundAmountCents: 3_000,
            cardRefundPercentage: 100,
            accountCreditAmountCents: 3_000,
            accountCreditPercentage: 100,
            daysUntilCheckIn: 30,
            requiresSettlementMethod: true,
            returnsToOrganiser: false,
            organiserRefundByBankTransfer: false,
            refundHeldForDispute: false,
            refundByBankTransfer: false,
          },
        };
        render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
        fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
        fireEvent.click(await screen.findByRole("radio", { name: /^Refund/ }, { timeout: 3000 }));
        await pressSave();
      },
      { settlementMethod: "card" },
    ],
    [
      "an officer's recalculating date override",
      async () => {
        render(<EditBookingPanel booking={makeBooking({ viewerRole: "ADMIN" })} canAdminOverride onDone={vi.fn()} />);
        await moveOverrideCheckIn(/Recalculate price/i);
        await pressSaveAsOfficer();
      },
      { adminOverride: true, pricingMode: "recalculate" },
    ],
    [
      "an officer's date shift",
      async () => {
        render(<EditBookingPanel booking={makeBooking({ viewerRole: "ADMIN" })} canAdminOverride onDone={vi.fn()} />);
        await moveOverrideCheckIn(/Shift dates only/i);
        await pressSaveAsOfficer();
      },
      { adminOverride: true, pricingMode: "shift" },
    ],
    [
      "an officer placing a partner on a shared double",
      async () => {
        render(<EditBookingPanel booking={makeBooking({ viewerRole: "ADMIN" })} onDone={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: /Pat Partner — partner of Ada Adult/ }));
        await pressSaveAsOfficer();
      },
      { partnerSharedGuests: [{ memberId: "m-partner", partnerMemberId: "m-ada" }] },
    ],
  ];

  it.each(cases)("%s", async (_label, saveTheEdit, alsoSent) => {
    await saveTheEdit();

    await waitFor(() => expect(modifyBodies).toHaveLength(1));
    expect(modifyBodies[0]).toMatchObject({ ...alsoSent, quotedFigures: FIGURES });
  });
});
