// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditBookingPanel } from "@/components/edit-booking-panel";

/**
 * #3232's offer, wired into the panel the member actually saves from.
 *
 * TWO PROPERTIES THAT ONLY EXIST HERE, and both of them are about money the
 * member has not agreed to.
 *
 *  - NO DEFAULT ANSWER, ENFORCED AT SAVE. The prompt preselects nothing, but a
 *    prompt that preselects nothing and a Save button that submits anyway is the
 *    same defect with an extra step: the server would receive no answer, re-prompt,
 *    and the member would be back where they started with no idea why. The panel
 *    refuses the save and says which decision is missing.
 *  - THE OFFER IS RETIRED THE MOMENT THE EDIT CHANGES. The offer carries a PRICE
 *    bound to a specific pair of moves. A member who changes their dates after
 *    reading it must not be looking at a total that has quietly stopped applying,
 *    and must not be able to submit the old answer — its state key would be
 *    refused by the server anyway, but being re-asked is the honest outcome rather
 *    than a rejection they cannot interpret.
 */
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-3232";
const ACCEPT_KEY = `v1:${"a".repeat(64)}`;
const DECLINE_KEY = `v1:${"b".repeat(64)}`;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The complete typed 409. The browser reader fails closed on anything less. */
function linkedMoveOffer(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    error:
      "booking BK-DEPEN at Alpine Lodge (2026-08-10 to 2026-08-12) is relying " +
      "on this booking for adult supervision, so moving this one on its own " +
      "would leave it without. Move both together?",
    code: "SAME_OWNER_COVERAGE_LINKED_MOVE_REQUIRED",
    requiresLinkedMoveChoice: true,
    acceptStateKey: ACCEPT_KEY,
    declineStateKey: DECLINE_KEY,
    linkedMoveAvailable: true,
    feasibility: "AVAILABLE",
    primary: {
      bookingId: BOOKING_ID,
      reference: "BK-3232",
      proposedCheckIn: "2026-09-05",
      proposedCheckOut: "2026-09-06",
      priceDiffCents: 0,
      changeFeeCents: 1_000,
    },
    linkedBookings: [
      {
        bookingId: "bk-dependent-01",
        reference: "BK-DEPEN",
        lodgeName: "Alpine Lodge",
        uncoveredNights: ["2026-08-10", "2026-08-11"],
        currentCheckIn: "2026-08-10",
        currentCheckOut: "2026-08-12",
        proposedCheckIn: "2026-08-20",
        proposedCheckOut: "2026-08-22",
        priceDiffCents: -1_200,
        changeFeeCents: 1_000,
      },
    ],
    combinedPriceDiffCents: -1_200,
    combinedChangeFeeCents: 2_000,
    combinedAmountDueCents: 800,
    combinedRefundCents: 0,
    settlementMethodRequired: false,
    bothChangeFeesCharged: true,
    ...overrides,
  };
}

let modifyResponse: () => Response;
/** Every body this panel PUT to `/modify`, in order. */
let modifyBodies: Array<Record<string, unknown>>;

function installFetch() {
  modifyBodies = [];
  modifyResponse = () => jsonResponse(linkedMoveOffer(), 409);
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      return jsonResponse({
        newTotalPriceCents: 5_000,
        newDiscountCents: 0,
        newPromoAdjustmentCents: 0,
        newFinalPriceCents: 5_000,
        priceDiffCents: 0,
        changeFeeCents: 1_000,
        netChargeCents: 1_000,
        settlementOptions: null,
        capacityAvailable: true,
        minimumStayValid: true,
        minimumStayViolations: [],
        exceptionReview: null,
        promoStillValid: true,
        promoCoverage: null,
        promoValidation: null,
        itemizedChanges: [],
      });
    }
    if (url.endsWith(`/api/bookings/${BOOKING_ID}/modify`)) {
      modifyBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return modifyResponse();
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
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
        priceCents: 5_000,
      },
    ],
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
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
  };
}

/** Move the arrival and wait for Save to become live. */
async function moveArrivalTo(value: string) {
  fireEvent.change(screen.getByLabelText(/Check-in/i), {
    target: { value },
  });
  const saveButton = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(saveButton).not.toBeDisabled(), { timeout: 2500 });
  return saveButton;
}

/** Save once, and land on the offer. */
async function saveIntoTheOffer() {
  const saveButton = await moveArrivalTo("2026-09-05");
  fireEvent.click(saveButton);
  await screen.findByText(
    /Another of your bookings needs an adult on these nights/,
  );
  return saveButton;
}

beforeEach(() => {
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — the linked-move offer (#3232)", () => {
  it("shows the offer with no arm chosen for the member", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await saveIntoTheOffer();

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio).not.toBeChecked();
    expect(
      screen.getByText(
        /Choose whether to move both bookings or only this one, then save again/,
      ),
    ).toBeVisible();
    // The edit was not applied, so the panel stays open on the member's change.
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("refuses to save again until an arm is chosen, and sends nothing", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    const saveButton = await saveIntoTheOffer();
    expect(modifyBodies).toHaveLength(1);

    fireEvent.click(saveButton);

    await screen.findByText(
      /Choose whether to move both bookings or only this one\./,
    );
    // Not "no request was sent" by absence — every PUT body is recorded, and the
    // recorded list is what proves the second click sent none.
    expect(modifyBodies).toHaveLength(1);
  });

  it("sends the ACCEPT key when the member chooses to move both", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    const saveButton = await saveIntoTheOffer();
    modifyResponse = () => jsonResponse({ booking: { id: BOOKING_ID } });

    fireEvent.click(screen.getByRole("radio", { name: /Move both bookings/ }));
    fireEvent.click(saveButton);

    await waitFor(() => expect(modifyBodies).toHaveLength(2));
    expect(modifyBodies[1]?.hostingCoverageLinkedMove).toEqual({
      choice: "MOVE_BOTH",
      acknowledged: true,
      stateKey: ACCEPT_KEY,
    });
    // The dates the member asked for still travel with it.
    expect(modifyBodies[1]?.checkIn).toBe("2026-09-05");
  });

  it("sends the DECLINE key when the member chooses to move only this booking", async () => {
    // The two arms bind different things — a hazard, and a price — so the key
    // comes off the prompt rather than being picked by the panel.
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    const saveButton = await saveIntoTheOffer();
    modifyResponse = () => jsonResponse({ booking: { id: BOOKING_ID } });

    fireEvent.click(
      screen.getByRole("radio", { name: /Move only this booking/ }),
    );
    fireEvent.click(saveButton);

    await waitFor(() => expect(modifyBodies).toHaveLength(2));
    expect(modifyBodies[1]?.hostingCoverageLinkedMove).toEqual({
      choice: "LEAVE_UNCOVERED",
      acknowledged: true,
      stateKey: DECLINE_KEY,
    });
  });

  it("retires the offer the moment the member changes the edit again", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await saveIntoTheOffer();
    expect(screen.getAllByRole("radio")).toHaveLength(2);

    // A different proposal: the price on screen no longer describes it.
    fireEvent.change(screen.getByLabelText(/Check-out/i), {
      target: { value: "2026-09-07" },
    });

    await waitFor(() =>
      expect(
        screen.queryByText(
          /Another of your bookings needs an adult on these nights/,
        ),
      ).toBeNull(),
    );
    expect(screen.queryAllByRole("radio")).toEqual([]);
  });

  it("does not carry a chosen arm across to a different proposal", async () => {
    // A member who ticked "move both" at one price has not agreed to move both at
    // another. The choice is cleared with the offer, so the next save is an
    // ordinary first submission rather than a stale acceptance.
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    const saveButton = await saveIntoTheOffer();
    fireEvent.click(screen.getByRole("radio", { name: /Move both bookings/ }));

    fireEvent.change(screen.getByLabelText(/Check-out/i), {
      target: { value: "2026-09-07" },
    });
    await waitFor(() => expect(screen.queryAllByRole("radio")).toEqual([]));

    modifyResponse = () => jsonResponse({ booking: { id: BOOKING_ID } });
    await waitFor(() => expect(saveButton).not.toBeDisabled(), {
      timeout: 2500,
    });
    fireEvent.click(saveButton);

    await waitFor(() => expect(modifyBodies).toHaveLength(2));
    expect("hostingCoverageLinkedMove" in (modifyBodies[1] ?? {})).toBe(false);
  });

  it("offers only the warn-and-continue arm where there are not beds for both", async () => {
    modifyResponse = () =>
      jsonResponse(
        linkedMoveOffer({
          linkedMoveAvailable: false,
          feasibility: "NO_CAPACITY",
          error:
            "booking BK-DEPEN at Alpine Lodge (2026-08-10 to 2026-08-12) is " +
            "relying on this booking for adult supervision, so moving this one " +
            "on its own would leave it without. There are not enough beds free " +
            "on the new nights to move both.",
        }),
        409,
      );
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await saveIntoTheOffer();

    expect(
      screen.getByRole("radio", { name: /Move both bookings/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: /Move only this booking/ }),
    ).not.toBeDisabled();
    // And that arm is answerable: the member is never left with no way forward.
    modifyResponse = () => jsonResponse({ booking: { id: BOOKING_ID } });
    fireEvent.click(
      screen.getByRole("radio", { name: /Move only this booking/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(modifyBodies).toHaveLength(2));
    expect(modifyBodies[1]?.hostingCoverageLinkedMove).toEqual({
      choice: "LEAVE_UNCOVERED",
      acknowledged: true,
      stateKey: DECLINE_KEY,
    });
  });

  it("falls back to the plain refusal when the 409 is not a complete offer", async () => {
    // Fail closed: a half-read body would put a price in front of the member that
    // the server never quoted, or a Move-both button whose key is missing.
    modifyResponse = () => {
      const partial = linkedMoveOffer();
      delete partial.acceptStateKey;
      return jsonResponse(partial, 409);
    };
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    const saveButton = await moveArrivalTo("2026-09-05");
    fireEvent.click(saveButton);

    await screen.findByText(/is relying on this booking for adult supervision/);
    expect(screen.queryAllByRole("radio")).toEqual([]);
  });
});
