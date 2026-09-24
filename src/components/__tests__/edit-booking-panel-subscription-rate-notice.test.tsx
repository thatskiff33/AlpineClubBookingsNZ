// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #2543. Under the club's NON_MEMBER_PRICING lockout mode a member whose season
// subscription is unpaid is re-rated at non-member rates, and the club owes them
// an explanation for the figure. `POST /api/bookings/[id]/modify-quote` returns
// that explanation as `subscriptionMemberRateNotice`, already worded server-side.
//
// Two properties matter here and neither is obvious from the render code alone:
// the panel renders the server's sentence VERBATIM, and the notice is read
// straight off `quote` rather than copied into its own state — so it can never
// outlive the quote it arrived on.

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2543";

// Deliberately not the real wording. The panel must render whatever the server
// sends, so a sentence the client could not have produced proves it is not
// rebuilding the copy locally.
const SERVER_RATE_NOTICE =
  "One person on this booking has an unpaid 2026/2027 membership subscription, so member rates aren't available for their nights.";

// What the next /modify-quote response carries. The stub reads it at call time,
// so a test can change the server's answer between two edits. `undefined` is the
// older-cached-response case: JSON.stringify drops the key entirely, so the
// response genuinely omits the field rather than sending null.
let quoteRateNotice: string | null | undefined;
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
    subscriptionMemberRateNotice: quoteRateNotice,
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
    // Fixed dates relative to the frozen test clock (2026-07-01): the stay is
    // permanently in the future, so the panel is always in "future" edit mode.
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
  fireEvent.change(screen.getByLabelText(/Check-out/i), { target: { value } });
  const saveButton = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(saveButton).not.toBeDisabled(), { timeout: 2500 });
  return saveButton;
}

beforeEach(() => {
  quoteRateNotice = undefined;
  quoteRefusal = null;
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — subscription member-rate notice (#2543)", () => {
  it("renders the server's sentence verbatim when the modify-quote carries one", async () => {
    quoteRateNotice = SERVER_RATE_NOTICE;
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    const saveButton = await setCheckOut("2026-09-07");

    const notice = await waitFor(
      () => screen.getByTestId("subscription-member-rate-notice"),
      { timeout: 2500 },
    );
    expect(notice).toHaveTextContent(SERVER_RATE_NOTICE);
    // Advisory, exactly like the minimum-stay warning beside it: the server is
    // authoritative on the money, so an explanation never gates Save.
    expect(saveButton).not.toBeDisabled();
    expect(notice).toHaveAttribute("role", "status");
  });

  it("drops the notice when a later quote returns null", async () => {
    quoteRateNotice = SERVER_RATE_NOTICE;
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await setCheckOut("2026-09-07");
    await waitFor(
      () => screen.getByTestId("subscription-member-rate-notice"),
      { timeout: 2500 },
    );

    // The subscription was paid (or the repriced guest left the edit): the next
    // quote for a fresh set of dates carries no notice at all. A notice held in
    // its own state would have survived this.
    quoteRateNotice = null;
    await setCheckOut("2026-09-08");

    await waitFor(
      () =>
        expect(
          screen.queryByTestId("subscription-member-rate-notice"),
        ).not.toBeInTheDocument(),
      { timeout: 2500 },
    );
  });

  it("drops the notice when a later quote is refused outright", async () => {
    quoteRateNotice = SERVER_RATE_NOTICE;
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await setCheckOut("2026-09-07");
    await waitFor(
      () => screen.getByTestId("subscription-member-rate-notice"),
      { timeout: 2500 },
    );

    // A refusal clears the whole quote (`setQuote(null)`), so the notice goes
    // with it rather than being left beside an error that contradicts it. This is
    // also the shape the paid-up-adult rule takes on this path: modify-quote
    // answers 409 PAID_UP_ADULT_MEMBER_REQUIRED instead of returning a quote.
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
          screen.queryByTestId("subscription-member-rate-notice"),
        ).not.toBeInTheDocument(),
      { timeout: 2500 },
    );
    // The refusal itself is what the member now reads.
    expect(
      screen.getByText(/needs at least one paid-up adult member/i),
    ).toBeInTheDocument();
  });

  it("renders no notice when the quote omits the field (older cached response)", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await setCheckOut("2026-09-07");

    // Absent behaves exactly as null.
    await waitFor(() => expect(screen.getByText("New price")).toBeInTheDocument(), {
      timeout: 2500,
    });
    expect(
      screen.queryByTestId("subscription-member-rate-notice"),
    ).not.toBeInTheDocument();
  });
});
