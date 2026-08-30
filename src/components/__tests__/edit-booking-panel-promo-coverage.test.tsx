// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import {
  promoChangeNotAppliedHeading,
  promoChangeNotAppliedMessage,
} from "@/lib/promo-change-not-applied";

// #2390 — a promotion that no longer reaches everybody must be explained AT the
// edit, not discovered on an invoice.
//
// The preview reads the promotion's counters unlocked; the save re-reads them
// under the promo row lock. Another booking can take the last slot in between,
// and then the price the member is charged is not the price the panel explained.
// The save response carries the server's own coverage sentence for exactly that
// case — reading only the error codes out of it and closing the panel is what
// left the member to find out from the email afterwards.

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2390";

const PREVIEW_MESSAGE =
  "Promo code SUMMER25 has reached its limit, so it stays with Ann Hughes, " +
  "who already had it, and does not extend to Cal Hughes — Cal Hughes is " +
  "priced at the normal rate. The total shown already includes this.";
const SAVE_MESSAGE =
  "Promo code SUMMER25 has reached its limit, so it stays with Ann Hughes, " +
  "who already had it, and does not extend to Bob Hughes and Cal Hughes — " +
  "Bob Hughes and Cal Hughes are priced at the normal rate. The total shown " +
  "already includes this.";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// #3179 — the OTHER sentence this panel can be handed, and the reason it lives
// in this file rather than a new one: it is composed onto the same two places
// (the price summary before Save, the panel body after it), and the interesting
// behaviour is precisely how it DIFFERS from the coverage notice above. A
// coverage split the preview already explained is not news and the panel closes;
// a dropped promo-code change is the member's own request not happening, so it
// is always held.
const PROMO_CHANGE_PREVIEW = promoChangeNotAppliedMessage({
  requested: "apply",
  reason: "AMOUNT_UNDER_REVIEW",
  promoCode: "SUMMER25",
  phase: "preview",
});
const PROMO_CHANGE_SAVED = promoChangeNotAppliedMessage({
  requested: "apply",
  reason: "AMOUNT_UNDER_REVIEW",
  promoCode: "SUMMER25",
  phase: "saved",
});

function quotePayload(coverageMessage: string | null) {
  return {
    newTotalPriceCents: 15000,
    newDiscountCents: 2000,
    newPromoAdjustmentCents: -2000,
    newFinalPriceCents: 13000,
    priceDiffCents: 3000,
    changeFeeCents: 0,
    netChargeCents: 3000,
    settlementOptions: null,
    capacityAvailable: true,
    promoStillValid: true,
    promoCoverage: coverageMessage
      ? {
          promoCode: "SUMMER25",
          coveredNames: ["Ann Hughes"],
          retainedNames: ["Ann Hughes"],
          excludedNames: ["Cal Hughes"],
          message: coverageMessage,
        }
      : null,
    promoChangeNotApplied: quotePromoChangeMessage
      ? {
          requested: "apply" as const,
          reason: "AMOUNT_UNDER_REVIEW" as const,
          promoCode: "SUMMER25",
          message: quotePromoChangeMessage,
        }
      : null,
    promoValidation: null,
    itemizedChanges: [],
  };
}

let quoteCoverageMessage: string | null;
let quotePromoChangeMessage: string | null;
let modifyResponse: () => Response;

function installFetch() {
  quoteCoverageMessage = PREVIEW_MESSAGE;
  quotePromoChangeMessage = null;
  modifyResponse = () => jsonResponse({ ok: true });
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      return jsonResponse(quotePayload(quoteCoverageMessage));
    }
    if (url.endsWith(`/api/bookings/${BOOKING_ID}/modify`)) {
      return modifyResponse();
    }
    void init;
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
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
      {
        id: "g2",
        firstName: "Cal",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-cal",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 10000,
    totalPriceCents: 12000,
    discountCents: 2000,
    promoAdjustmentCents: -2000,
    promo: {
      code: "SUMMER25",
      type: "PERCENTAGE",
      description: "Summer 25% off",
    },
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

async function makeAChangeAndWaitForSave() {
  // A date change is the simplest edit that produces a quote.
  fireEvent.change(screen.getByLabelText(/Check-out/i), {
    target: { value: "2026-09-04" },
  });
  const saveButton = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(saveButton).not.toBeDisabled(), { timeout: 2500 });
  return saveButton;
}

beforeEach(() => {
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — partial promo coverage (#2390)", () => {
  it("shows the preview's coverage sentence, announced to a screen reader", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await makeAChangeAndWaitForSave();

    const notice = await screen.findByTestId("promo-coverage-notice");
    expect(notice).toHaveTextContent("does not extend to Cal Hughes");
    // Appears on its own when the quote comes back, so it must announce itself.
    expect(notice).toHaveAttribute("role", "status");
  });

  it("holds the panel open when the SAVE covers fewer people than the preview did", async () => {
    const onDone = vi.fn();
    modifyResponse = () =>
      jsonResponse({
        promoCoverage: {
          promoCode: "SUMMER25",
          coveredNames: ["Ann Hughes"],
          retainedNames: ["Ann Hughes"],
          excludedNames: ["Bob Hughes", "Cal Hughes"],
          message: SAVE_MESSAGE,
        },
      });

    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);
    const saveButton = await makeAChangeAndWaitForSave();
    fireEvent.click(saveButton);

    const notice = await screen.findByTestId("saved-promo-coverage-notice");
    expect(notice).toHaveTextContent("Your change is saved");
    expect(notice).toHaveTextContent(SAVE_MESSAGE);
    expect(notice).toHaveAttribute("role", "status");
    // The edit HAS been saved, so Save must not be offered a second time.
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("closes as usual when the save says exactly what the preview already said", async () => {
    const onDone = vi.fn();
    modifyResponse = () =>
      jsonResponse({
        promoCoverage: {
          promoCode: "SUMMER25",
          coveredNames: ["Ann Hughes"],
          retainedNames: ["Ann Hughes"],
          excludedNames: ["Cal Hughes"],
          message: PREVIEW_MESSAGE,
        },
      });

    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);
    const saveButton = await makeAChangeAndWaitForSave();
    fireEvent.click(saveButton);

    // Re-showing a sentence the member already read and accepted is not news.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("saved-promo-coverage-notice")).toBeNull();
  });

  it("closes as usual when the save left nobody out", async () => {
    const onDone = vi.fn();
    quoteCoverageMessage = null;
    modifyResponse = () => jsonResponse({ promoCoverage: null });

    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);
    const saveButton = await makeAChangeAndWaitForSave();
    fireEvent.click(saveButton);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("saved-promo-coverage-notice")).toBeNull();
  });
});

/**
 * #3179 — the half of this fix that lives in the browser.
 *
 * The owner accepted a PARTIAL SAVE here, and accepted it on one condition: the
 * wording has to be impossible to miss, because a member who does not read it
 * walks away believing they applied a discount they did not. Everything that
 * condition rests on is in this component — the preview render, the panel being
 * held open, and Save being replaced by Done rather than the panel closing out
 * from under them.
 */
describe("EditBookingPanel — a promo-code change the edit could not carry (#3179)", () => {
  it("shows the preview's sentence, headed, before the member presses Save", async () => {
    quotePromoChangeMessage = PROMO_CHANGE_PREVIEW;
    quoteCoverageMessage = null;

    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await makeAChangeAndWaitForSave();

    const notice = await screen.findByTestId("promo-change-not-applied-notice");
    // The heading is the skim-stopper; the sentence is the server's, verbatim.
    expect(notice).toHaveTextContent(promoChangeNotAppliedHeading("preview"));
    expect(notice).toHaveTextContent(PROMO_CHANGE_PREVIEW);
    // It appears on its own when the quote returns, so it must announce itself.
    expect(notice).toHaveAttribute("role", "status");
  });

  it("holds the panel open after the save EVEN THOUGH the preview said the same thing", async () => {
    // This is the whole difference from the coverage notice above, which the
    // panel deliberately suppresses when the save repeats what the preview
    // already said. Here the edit parks for the same reason both times, so a
    // suppression rule would suppress this notice essentially always and close
    // the member out on a partial save with nothing on screen.
    //
    // The save's own sentence is fed back as the PREVIEW's too, byte for byte.
    // That is deliberate and slightly artificial: in production the two differ
    // by tense alone ("will not be applied" / "was not applied"), which would
    // let a comparison creep in and never fire, so a realistic pair would leave
    // this test passing whether the rule held or not. Identical strings are what
    // make the absence of a comparison observable.
    const onDone = vi.fn();
    quotePromoChangeMessage = PROMO_CHANGE_SAVED;
    quoteCoverageMessage = null;
    modifyResponse = () =>
      jsonResponse({
        promoChangeNotApplied: {
          requested: "apply",
          reason: "AMOUNT_UNDER_REVIEW",
          promoCode: "SUMMER25",
          message: PROMO_CHANGE_SAVED,
        },
      });

    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);
    const saveButton = await makeAChangeAndWaitForSave();
    fireEvent.click(saveButton);

    const notice = await screen.findByTestId(
      "saved-promo-change-not-applied-notice",
    );
    expect(notice).toHaveTextContent(promoChangeNotAppliedHeading("saved"));
    expect(notice).toHaveTextContent(PROMO_CHANGE_SAVED);
    expect(notice).toHaveAttribute("role", "status");
    // The edit IS saved, so Save must not be offered again — the acknowledgement
    // replaces it.
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("closes as usual when the edit carried no promo change to drop — the CONTROL", async () => {
    // Without this, a notice hard-wired on would pass both tests above while
    // holding every ordinary edit open behind a warning about nothing.
    const onDone = vi.fn();
    quotePromoChangeMessage = null;
    quoteCoverageMessage = null;
    modifyResponse = () => jsonResponse({ promoChangeNotApplied: null });

    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);
    const saveButton = await makeAChangeAndWaitForSave();
    expect(screen.queryByTestId("promo-change-not-applied-notice")).toBeNull();
    fireEvent.click(saveButton);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByTestId("saved-promo-change-not-applied-notice"),
    ).toBeNull();
  });
});
