// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #2770 D2 (INV-MOD-026). A club that runs a group discount may switch it off
// for later edits. The nights this edit adds are then charged at the ordinary
// rate, and the person looking at that number is owed the reason — so
// `POST /api/bookings/[id]/modify-quote` returns it as `groupDiscountEditNotice`,
// worded server-side and derived from the same mapper that decided the price.
//
// Two properties are pinned here, and neither is visible in the render code
// alone: the panel renders the server's sentence VERBATIM (it does not rebuild
// the copy, so it can never say "not discounted" about a quote that was), and
// the notice is read straight off `quote`, so it cannot outlive the quote it
// arrived on. Both mirror the #2543 subscription notice beside it.

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2770";

// Deliberately not the production wording: a sentence the client could not have
// produced proves the copy came from the server.
const SERVER_NOTICE =
  "Group discount is not applied to nights added after booking at this club.";

let quoteEditNotice: string | null | undefined;
let quoteRefusal: { body: unknown; status: number } | null = null;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quotePayload() {
  return {
    newTotalPriceCents: 12000,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents: 12000,
    priceDiffCents: 2000,
    changeFeeCents: 0,
    netChargeCents: 2000,
    settlementOptions: null,
    capacityAvailable: true,
    promoStillValid: true,
    promoCoverage: null,
    promoValidation: null,
    itemizedChanges: [],
    groupDiscountEditNotice: quoteEditNotice,
  };
}

function installFetch() {
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      return quoteRefusal
        ? jsonResponse(quoteRefusal.body, quoteRefusal.status)
        : jsonResponse(quotePayload());
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
    // Fixed against the frozen clock (2026-07-01): permanently a future stay, so
    // the panel is always in "future" edit mode.
    checkIn: "2026-09-04",
    checkOut: "2026-09-06",
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
}

async function setCheckOut(value: string) {
  fireEvent.change(screen.getByLabelText(/Check-out/i), {
    target: { value },
  });
  const saveButton = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(saveButton).not.toBeDisabled(), { timeout: 2500 });
  return saveButton;
}

beforeEach(() => {
  quoteEditNotice = undefined;
  quoteRefusal = null;
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — group discount edit notice (#2770)", () => {
  it("renders the server's sentence verbatim beside the price", async () => {
    quoteEditNotice = SERVER_NOTICE;
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    const saveButton = await setCheckOut("2026-09-07");

    const notice = await waitFor(
      () => screen.getByTestId("group-discount-edit-notice"),
      { timeout: 2500 },
    );
    expect(notice).toHaveTextContent(SERVER_NOTICE);
    expect(notice).toHaveAttribute("role", "status");
    // Explanatory, never a gate: the club's own policy cannot block the edit it
    // is describing.
    expect(saveButton).not.toBeDisabled();
  });

  it("drops the notice when a later quote carries none", async () => {
    quoteEditNotice = SERVER_NOTICE;
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await setCheckOut("2026-09-07");
    await waitFor(() => screen.getByTestId("group-discount-edit-notice"), {
      timeout: 2500,
    });

    // The admin switched it back on between quotes. A notice held in its own
    // state would have survived this and contradicted the new number.
    quoteEditNotice = null;
    await setCheckOut("2026-09-08");

    await waitFor(
      () =>
        expect(
          screen.queryByTestId("group-discount-edit-notice"),
        ).not.toBeInTheDocument(),
      { timeout: 2500 },
    );
  });

  it("drops the notice when a later quote is refused outright", async () => {
    quoteEditNotice = SERVER_NOTICE;
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await setCheckOut("2026-09-07");
    await waitFor(() => screen.getByTestId("group-discount-edit-notice"), {
      timeout: 2500,
    });

    // A refusal clears the whole quote, so an explanation of a price nobody is
    // being offered goes with it.
    quoteRefusal = {
      status: 409,
      body: {
        error:
          "This booking needs at least one paid-up adult member staying on it.",
        code: "PAID_UP_ADULT_MEMBER_REQUIRED",
      },
    };
    await setCheckOut("2026-09-09");

    await waitFor(
      () =>
        expect(
          screen.queryByTestId("group-discount-edit-notice"),
        ).not.toBeInTheDocument(),
      { timeout: 2500 },
    );
  });

  it("renders nothing when the quote omits the field, which is every club whose switch is on", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await setCheckOut("2026-09-07");

    await waitFor(
      () => expect(screen.getByText("New price")).toBeInTheDocument(),
      { timeout: 2500 },
    );
    expect(
      screen.queryByTestId("group-discount-edit-notice"),
    ).not.toBeInTheDocument();
  });
});
