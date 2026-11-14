// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

/*
  #4924 (`INV-MOD-062`): an edit settles only the figures the member was shown.

  The panel sends the last preview's `quotedFigures` back unchanged on Save.
  When the save answers 409 EDIT_PRICE_CHANGED, the edit stays open, the panel
  names the amount the member approved and what it is now, and re-runs the
  preview so the next Save carries the fresh figures.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-4924";

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];
// What the preview answers: the figures move only once the save has refused.
let currentQuote: Record<string, unknown>;
let modifyResponses: Array<() => Response>;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PREVIEWED = {
  newFinalPriceCents: 5000,
  priceDiffCents: -5000,
  changeFeeCents: 0,
  netChargeCents: -5000,
};
const FRESH = { ...PREVIEWED, changeFeeCents: 2500, netChargeCents: -2500 };

function quote(figures: typeof PREVIEWED) {
  return {
    newTotalPriceCents: figures.newFinalPriceCents,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    ...figures,
    settlementOptions: null,
    capacityAvailable: true,
    promoStillValid: true,
    promoValidation: null,
    itemizedChanges: [],
    quotedFigures: figures,
  };
}

function installFetch() {
  fetchCalls = [];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ url, method: init?.method ?? "GET", body });

    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/modify-quote")) {
      return jsonResponse(currentQuote);
    }
    if (url.endsWith(`/api/bookings/${BOOKING_ID}/modify`)) {
      return (modifyResponses.shift() ?? (() => jsonResponse({ ok: true })))();
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
}

function guest(id: string, firstName: string) {
  return {
    id,
    firstName,
    lastName: "Adult",
    ageTier: "ADULT",
    isMember: true,
    memberId: null,
    stayStart: null,
    stayEnd: null,
    nights: null,
    priceCents: 5000,
  };
}

const booking = {
  id: BOOKING_ID,
  checkIn: "2026-09-01",
  checkOut: "2026-09-03",
  guests: [guest("g1", "Ada"), guest("g2", "Bee")],
  viewerRole: "MEMBER",
  finalPriceCents: 10000,
  totalPriceCents: 10000,
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
    adminOverrideAvailable: false,
  },
  requiresAdminReview: false,
  adminReviewStatus: null,
};

const modifyCalls = () =>
  fetchCalls.filter((c) => c.url.endsWith(`/api/bookings/${BOOKING_ID}/modify`));
const quoteCalls = () => fetchCalls.filter((c) => c.url.includes("/modify-quote"));

async function removeGuestAndSave() {
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
  const save = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 3000 });
  fireEvent.click(save);
}

beforeEach(() => {
  currentQuote = quote(PREVIEWED);
  modifyResponses = [];
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — the save binds the previewed figures (#4924)", () => {
  it("sends the last preview's figures back unchanged", async () => {
    const onDone = vi.fn();
    render(<EditBookingPanel booking={booking} onDone={onDone} />);
    await removeGuestAndSave();

    await waitFor(() => expect(modifyCalls()).toHaveLength(1));
    expect(modifyCalls()[0].body).toMatchObject({ quotedFigures: PREVIEWED });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("on EDIT_PRICE_CHANGED keeps the edit open, names old and new amounts, and re-previews", async () => {
    let quotesAtRefusal = 0;
    modifyResponses = [
      () => {
        currentQuote = quote(FRESH);
        quotesAtRefusal = quoteCalls().length;
        return jsonResponse(
          {
            code: "EDIT_PRICE_CHANGED",
            error: "The price changed since you previewed it. Review and save again.",
            figures: FRESH,
          },
          409,
        );
      },
    ];
    const onDone = vi.fn();
    render(<EditBookingPanel booking={booking} onDone={onDone} />);
    await removeGuestAndSave();

    expect(
      await screen.findByText(
        "The price changed since you previewed it: a reduction of $50.00 is now a reduction of $25.00. Review the new figures and save again.",
      ),
    ).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    await waitFor(() => expect(quoteCalls().length).toBeGreaterThan(quotesAtRefusal));

    // The re-run preview's figures are what the next Save carries.
    const save = screen.getByRole("button", { name: "Save Changes" });
    await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(save);
    await waitFor(() => expect(modifyCalls()).toHaveLength(2));
    expect(modifyCalls()[1].body).toMatchObject({ quotedFigures: FRESH });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("a Save pressed before the latest edit is priced prices it instead of sending the old figures", async () => {
    const SECOND = { ...PREVIEWED, newFinalPriceCents: 4000, priceDiffCents: -6000, netChargeCents: -6000 };
    const threeGuests = { ...booking, guests: [...booking.guests, guest("g3", "Cy")] };
    render(<EditBookingPanel booking={threeGuests} onDone={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[2]);
    const save = screen.getByRole("button", { name: "Save Changes" });
    await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 3000 });
    const quotesBefore = quoteCalls().length;

    // A second edit, then Save inside the debounce: the quote on screen is
    // still the first edit's.
    currentQuote = quote(SECOND);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    fireEvent.click(save);

    await waitFor(() => expect(quoteCalls().length).toBeGreaterThan(quotesBefore));
    expect(modifyCalls()).toHaveLength(0);
    // The press is answered, not swallowed: the member is told to check the new price.
    expect(screen.getByText(/Updating the price for your latest change/)).toBeInTheDocument();
    await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(save);
    await waitFor(() => expect(modifyCalls()).toHaveLength(1));
    expect(modifyCalls()[0].body).toMatchObject({ quotedFigures: SECOND });
  });
});
