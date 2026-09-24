// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditBookingPanel } from "@/components/edit-booking-panel";
// #2690: imported from the module that owns the narrowing rather than through a
// re-export on the panel. The panel is a shell now; a symbol re-exported from it
// solely so a test can reach it is the compatibility facade the split was
// supposed to remove.
import { exceptionRequestPayloadFromModification } from "@/components/edit-booking/exception-request-payload";

/**
 * #2562 — the modification half of the member-facing exception workflow.
 *
 * The owner's decision is that the action appears ONLY where the server confirms
 * every blocking failure is exception-eligible. On this path there are TWO refusal
 * points and they behave differently, so both are exercised: the quote (which
 * answers 409 PAID_UP_ADULT_MEMBER_REQUIRED instead of a quote) and the save (which
 * hard-blocks a minimum-stay breach with a 400 carrying the frozen review). A hard
 * failure must open nothing.
 */

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2562";

const MIN_STAY_VIOLATION = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-weekend",
  policyVersion: 3,
  policyName: "Weekend minimum",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-1" },
  affectedNights: ["2026-09-04"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Bookings including a Friday night require a minimum stay of 2 nights.",
  triggerDay: "Friday",
  minimumNights: 2,
  actualNights: 1,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 2,
    actualNights: 1,
    triggerDays: [5],
  },
};

const PAID_UP_VIOLATION = {
  reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED",
  policyId: "subscription-lockout",
  policyVersion: 1,
  policyName: "Paid-up adult member required",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-1" },
  affectedNights: ["2026-09-04", "2026-09-05"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "There has to be a paid-up adult member on the booking.",
  requirements: {
    kind: "PAID_UP_ADULT_MEMBER",
    requiredPaidUpAdultMembers: 1,
    repricedUnpaidMemberCount: 1,
    participantCount: 2,
  },
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quotePayload() {
  return {
    newTotalPriceCents: 5000,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents: 5000,
    priceDiffCents: -5000,
    changeFeeCents: 0,
    netChargeCents: -5000,
    settlementOptions: null,
    capacityAvailable: true,
    minimumStayValid: false,
    minimumStayViolations: [MIN_STAY_VIOLATION],
    exceptionReview: { violations: [MIN_STAY_VIOLATION], capacityMode: "HOLD" },
    promoStillValid: true,
    promoCoverage: null,
    promoValidation: null,
    itemizedChanges: [],
  };
}

const FROZEN_PROPOSAL = {
  lodgeId: "lodge-1",
  checkIn: "2026-09-04",
  checkOut: "2026-09-05",
  guests: [
    {
      firstName: "Ann",
      lastName: "Hughes",
      ageTier: "ADULT",
      isMember: true,
      nights: ["2026-09-04"],
    },
  ],
  guestNights: 1,
  baseCheckIn: "2026-09-04",
  baseCheckOut: "2026-09-06",
  baseGuestNights: 2,
};

let quoteResponse: () => Response;
let modifyResponse: () => Response;
let requestResponse: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  quoteResponse = () => jsonResponse(quotePayload());
  modifyResponse = () =>
    jsonResponse(
      {
        error: "These dates do not meet the minimum-stay rules.",
        code: "MINIMUM_STAY_VIOLATION",
        details: "Two nights are required on a Friday.",
        violations: [MIN_STAY_VIOLATION],
        exceptionReview: { violations: [MIN_STAY_VIOLATION], capacityMode: "HOLD" },
      },
      400,
    );
  requestResponse = () =>
    jsonResponse(
      {
        id: "req-new",
        status: "REQUESTED",
        proposalHash: "abc",
        reasonCodes: ["MINIMUM_STAY"],
        aggregateCapacityMode: "HOLD",
        proposal: FROZEN_PROPOSAL,
        capacityHeld: true,
      },
      201,
    );
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/modify-quote")) return quoteResponse();
    if (url.includes("/exception-requests")) return requestResponse();
    if (url.endsWith(`/api/bookings/${BOOKING_ID}/modify`)) return modifyResponse();
    return jsonResponse({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
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

async function shortenStayAndWaitForSave() {
  fireEvent.change(screen.getByLabelText(/Check-out/i), {
    target: { value: "2026-09-05" },
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

describe("EditBookingPanel — when the request action appears", () => {
  it("does not offer it before a refusal has happened", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await shortenStayAndWaitForSave();
    // The quote came back fine (the min-stay banner here is advisory), so nothing
    // is blocking and there is nothing to ask about yet.
    expect(screen.queryByTestId("request-officer-approval")).toBeNull();
  });

  it("offers it after the SAVE is refused for minimum stay", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);

    const card = await screen.findByTestId("request-officer-approval");
    expect(card).toHaveTextContent(/Minimum length of stay/i);
    expect(card).toHaveTextContent(
      "Bookings including a Friday night require a minimum stay of 2 nights.",
    );
  });

  it("offers it when the QUOTE itself is refused for the paid-up-adult rule", async () => {
    quoteResponse = () =>
      jsonResponse(
        {
          error: "There has to be a paid-up adult member on the booking.",
          code: "PAID_UP_ADULT_MEMBER_REQUIRED",
          details: "There has to be a paid-up adult member on the booking.",
          violations: [PAID_UP_VIOLATION],
          exceptionReview: { violations: [PAID_UP_VIOLATION], capacityMode: "HOLD" },
          exceptionRequestPath: "/api/bookings/exception-requests",
        },
        409,
      );
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Check-out/i), {
      target: { value: "2026-09-05" },
    });
    const card = await screen.findByTestId("request-officer-approval", undefined, {
      timeout: 2500,
    });
    expect(card).toHaveTextContent(/paid-up adult member/i);
    // No quote came back, so no figure is invented.
    expect(card).toHaveTextContent(/Worked out at the club's normal rates/i);
  });

  it("offers NOTHING for a hard capacity failure, even with nights listed", async () => {
    modifyResponse = () =>
      jsonResponse(
        {
          error: "Not enough beds available",
          code: "CAPACITY_EXCEEDED",
          fullNights: ["2026-09-04"],
        },
        409,
      );
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);
    expect(await screen.findByText("Not enough beds available")).toBeInTheDocument();
    expect(screen.queryByTestId("request-officer-approval")).toBeNull();
  });

  /**
   * #2562 review — a promo-inclusive figure above "the promo is not included".
   *
   * The quote prices the WHOLE payload (`netChargeCents` derives from
   * `newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents`), and
   * `handleSave` does not clear `quote` on a refusal, so the stale promo-inclusive
   * number was what the card rendered — directly above its own warning that the
   * promo is not part of the request. The two contradicted each other and the
   * number was the wrong one: the frozen proposal prices without the promo.
   */
  it("shows no figure when the request drops something the quote was priced on", async () => {
    const booking = {
      ...makeBooking(),
      promo: {
        code: "SPRING",
        type: "PERCENTAGE",
        description: "Spring special",
        workPartyEventName: null,
      },
      promoAdjustmentCents: -2000,
    };
    render(<EditBookingPanel booking={booking} onDone={vi.fn()} />);

    // Take the promo off AND shorten the stay in one edit — the exact journey.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);

    const card = await screen.findByTestId("request-officer-approval");
    expect(card).toHaveTextContent(/removing the promo code/);
    // The figure is withheld and the honest sentence takes its place.
    expect(card).toHaveTextContent(/Worked out at the club's normal rates/i);
    expect(card).not.toHaveTextContent(/Extra to pay if this is approved/);
    expect(card).not.toHaveTextContent(/Refund due if this is approved/);
  });

  it("still shows the quote's figure when the request carries everything it priced", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);

    const card = await screen.findByTestId("request-officer-approval");
    // A pure date change drops nothing, so the server's own figure stands.
    expect(card).toHaveTextContent(/Refund due if this is approved/);
    expect(card).toHaveTextContent("$50.00");
  });

  /**
   * #2562 RE-REVIEW — the offer, and its price, outliving the proposal.
   *
   * The wizard retires a stale offer by comparing a proposal signature during
   * render. This panel was left relying on the debounced quote effect, which only
   * clears the offer when a NEW quote resolves or the payload empties — so after a
   * refusal the member could move check-out to a stay that no longer breaches and
   * still be reading the old refusal's rule ("Minimum length of stay") and the old
   * payload's figure ("Refund due if this is approved $50.00"), labelled as the
   * club's quote for the proposal as it stands, against nights they had already
   * changed. Every further keystroke restarted the 500ms debounce, so the window
   * lasted as long as they kept editing, and a quote that FAILED cleared the figure
   * but left the offer up indefinitely. Submitting inside it posts the current
   * payload while they read the previous one, and a now-legal proposal answers 400
   * `NoEligiblePolicyExceptionError` — a dead end, because only the two 409s have
   * remedy branches on the card.
   *
   * Asserted with NO `waitFor`: retirement has to happen in the render the change
   * lands in, before the debounce has even fired the next quote.
   */
  it("retires the offer in the same render the proposal changes, before any new quote", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);

    const card = await screen.findByTestId("request-officer-approval");
    expect(card).toHaveTextContent(/Minimum length of stay/i);
    expect(card).toHaveTextContent("$50.00");

    // A stay that no longer breaches the rule. The quote for it has not run — the
    // debounce is still pending — so nothing but the render-time comparison can
    // retire the card.
    fireEvent.change(screen.getByLabelText(/Check-out/i), {
      target: { value: "2026-09-08" },
    });
    expect(screen.queryByTestId("request-officer-approval")).toBeNull();
    // The card carried the offer's figure and its label; both go with it, rather
    // than the figure hanging on under a changed set of nights.
    expect(screen.queryByText(/Refund due if this is approved/i)).toBeNull();
    expect(screen.queryByText(/Minimum length of stay/i)).toBeNull();
  });

  /**
   * The complement, so the retirement is keyed on the PROPOSAL and not on any
   * payload change: a promo removal, a guest name correction or a settlement choice
   * is not part of what an officer would freeze, the card already refuses to show a
   * figure that was priced with it, and retiring the offer for it would send the
   * member back round a refusal they have not resolved.
   */
  it("keeps the offer when the member changes something the proposal does not carry", async () => {
    const booking = {
      ...makeBooking(),
      promo: {
        code: "SPRING",
        type: "PERCENTAGE",
        description: "Spring special",
        workPartyEventName: null,
      },
      promoAdjustmentCents: -2000,
    };
    render(<EditBookingPanel booking={booking} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);
    await screen.findByTestId("request-officer-approval");

    // Same nights, same party — only the promo election moves.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByTestId("request-officer-approval")).toBeInTheDocument();
    expect(screen.getByTestId("request-officer-approval")).toHaveTextContent(
      /removing the promo code/,
    );
  });

  it("retires the offer once a fresh quote comes back clean", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);
    await screen.findByTestId("request-officer-approval");

    // The member changes their mind and puts the night back; the quote succeeds, so
    // the door they no longer need must close.
    quoteResponse = () =>
      jsonResponse({ ...quotePayload(), minimumStayValid: true, minimumStayViolations: [] });
    fireEvent.change(screen.getByLabelText(/Check-out/i), {
      target: { value: "2026-09-06" },
    });
    await waitFor(
      () => expect(screen.queryByTestId("request-officer-approval")).toBeNull(),
      { timeout: 2500 },
    );
  });
});

describe("EditBookingPanel — submitting the request", () => {
  it("sends the refused delta, narrowed to the proposal, with the explanation", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);
    await screen.findByTestId("request-officer-approval");

    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "Have to be back for work on Saturday." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request Booking Officer approval/i }),
    );

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/exception-requests"),
      );
      expect(call).toBeDefined();
      expect(String(call?.[0])).toBe(
        `/api/bookings/${BOOKING_ID}/exception-requests`,
      );
      const body = JSON.parse(String((call?.[1] as RequestInit).body));
      // The change that was refused: the shortened check-out, and nothing invented.
      expect(body).toMatchObject({
        checkOut: "2026-09-05",
        memberMessage: "Have to be back for work on Saturday.",
      });
      expect(body.supersedeRequestId).toBeUndefined();
    });
  });

  it("shows the SERVER's frozen proposal and its real hold after sending", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);
    await screen.findByTestId("request-officer-approval");
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "Please." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request Booking Officer approval/i }),
    );

    const sent = await screen.findByTestId("exception-request-sent");
    expect(sent).toHaveTextContent("Exactly what the Booking Officer will decide");
    expect(sent).toHaveTextContent("1 guest nights");
    // `capacityHeld: true` came back from the write, so the wording says the beds
    // are held — and it came from the write, not from the policy's mode.
    expect(sent).toHaveTextContent(/held while it waits/i);
  });

  it("passes the request being replaced through as the supersede target", async () => {
    render(
      <EditBookingPanel
        booking={makeBooking()}
        replaceExceptionRequestId="req-old"
        onDone={vi.fn()}
      />,
    );
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);
    await screen.findByTestId("request-officer-approval");
    fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
      target: { value: "Corrected the dates." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Replace my request/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/exception-requests"),
      );
      const body = JSON.parse(String((call?.[1] as RequestInit).body));
      expect(body.supersedeRequestId).toBe("req-old");
    });
  });

  it("names the parts of the edit a request cannot carry", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Check-out/i), {
      target: { value: "2026-09-05" },
    });
    // A guest name correction rides along with the date change. It is not part of a
    // proposal, so an approval will not apply it and the member has to be told.
    const nameInput = screen.queryByDisplayValue("Ann");
    if (nameInput) fireEvent.change(nameInput, { target: { value: "Anne" } });
    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    await waitFor(() => expect(saveButton).not.toBeDisabled(), { timeout: 2500 });
    fireEvent.click(saveButton);
    await screen.findByTestId("request-officer-approval");

    if (nameInput) {
      expect(screen.getByText(/are NOT included/i)).toHaveTextContent(
        "guest name corrections",
      );
    }
  });
});

describe("exceptionRequestPayloadFromModification", () => {
  it("keeps exactly the five fields a proposal is made of", () => {
    const { payload } = exceptionRequestPayloadFromModification({
      checkIn: "2026-09-04",
      checkOut: "2026-09-05",
      addGuests: [{ firstName: "Bo" }],
      removeGuestIds: ["g2"],
      guestStayRanges: [{ guestId: "g1" }],
    });
    expect(Object.keys(payload).sort()).toEqual([
      "addGuests",
      "checkIn",
      "checkOut",
      "guestStayRanges",
      "removeGuestIds",
    ]);
  });

  it("reports everything else as omitted, in words a member can read", () => {
    const { payload, omittedChanges } = exceptionRequestPayloadFromModification({
      checkOut: "2026-09-05",
      guestUpdates: [{ guestId: "g1", firstName: "Anne" }],
      promoCode: "SPRING",
      applyCreditCents: 5000,
      linkGuestToMember: [{ guestId: "g1", memberId: "m-9" }],
    });
    expect(payload).toEqual({ checkOut: "2026-09-05" });
    expect(omittedChanges).toEqual([
      "guest name corrections",
      "linking a placeholder guest to a member",
      "the promo code",
      "using account credit",
    ]);
  });

  it("reports an UNKNOWN key by its own name rather than dropping it silently", () => {
    // A key added to the payload builder later must appear on screen — an ugly word
    // is recoverable; a change the member believes they submitted is not.
    const { omittedChanges } = exceptionRequestPayloadFromModification({
      checkOut: "2026-09-05",
      someFutureField: true,
    });
    expect(omittedChanges).toEqual(["someFutureField"]);
  });

  it("omits nothing for a pure date-and-party change", () => {
    const { omittedChanges } = exceptionRequestPayloadFromModification({
      checkOut: "2026-09-05",
      removeGuestIds: ["g2"],
    });
    expect(omittedChanges).toEqual([]);
  });

  it("does not carry an undefined value through as a key", () => {
    const { payload } = exceptionRequestPayloadFromModification({
      checkIn: undefined,
      checkOut: "2026-09-05",
    });
    expect(Object.keys(payload)).toEqual(["checkOut"]);
  });

  /**
   * #2562 review — which omissions make the quote's figure the WRONG figure.
   *
   * `modify-quote` prices the whole payload the member typed: `netChargeCents` is
   * built from `newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents`,
   * so a promo in the payload is baked in. The card was printing that number
   * directly above its own warning that the promo is not included — the two
   * contradicted each other and the number was the one no approval could produce.
   */
  it("flags a dropped promo, credit or member link as price-affecting", () => {
    for (const key of [
      "promoCode",
      "removePromoCode",
      "promoGuestIds",
      "promoAddedGuestIndexes",
      "applyCreditCents",
      "partnerSharedGuests",
      "linkGuestToMember",
      "adminOverride",
      "pricingMode",
    ]) {
      const { omitsPricedChange } = exceptionRequestPayloadFromModification({
        checkOut: "2026-09-05",
        [key]: "whatever",
      });
      expect(omitsPricedChange, key).toBe(true);
    }
  });

  it("does not flag omissions that change how a change is recorded, not its price", () => {
    for (const key of [
      "guestUpdates",
      "settlementMethod",
      "memberReviewJustification",
      "confirmOverCapacity",
    ]) {
      const { omitsPricedChange } = exceptionRequestPayloadFromModification({
        checkOut: "2026-09-05",
        [key]: "whatever",
      });
      expect(omitsPricedChange, key).toBe(false);
    }
    // And a payload that drops nothing at all keeps its figure.
    expect(
      exceptionRequestPayloadFromModification({
        checkOut: "2026-09-05",
        removeGuestIds: ["g2"],
      }).omitsPricedChange,
    ).toBe(false);
  });

  it("treats an UNKNOWN dropped key as price-affecting", () => {
    // Fail safe. Suppressing a figure costs the member a sentence about normal
    // rates; showing one no approval can produce costs them the difference.
    expect(
      exceptionRequestPayloadFromModification({
        checkOut: "2026-09-05",
        someFutureField: true,
      }).omitsPricedChange,
    ).toBe(true);
  });
});
