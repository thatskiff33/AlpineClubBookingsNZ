// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #2104: the member edit panel must collect the "no adult on the booking"
// justification the modify route requires — proactively when the client-side
// predicate trips, and reactively when the server returns the
// REVIEW_JUSTIFICATION_REQUIRED code (client/server drift).

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2104";

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_QUOTE = {
  newTotalPriceCents: 5000,
  newDiscountCents: 0,
  newPromoAdjustmentCents: 0,
  newFinalPriceCents: 5000,
  priceDiffCents: 0,
  changeFeeCents: 0,
  netChargeCents: 0,
  settlementOptions: null,
  capacityAvailable: true,
  promoStillValid: true,
  promoValidation: null,
  itemizedChanges: [],
};

// modifyResponse lets each test decide what PUT /modify returns.
let modifyResponse: () => Response;

function installFetch() {
  fetchCalls = [];
  modifyResponse = () => jsonResponse({ ok: true });
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    fetchCalls.push({ url, method, body: parsedBody });

    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      return jsonResponse(OK_QUOTE);
    }
    if (url.endsWith(`/api/bookings/${BOOKING_ID}/modify`)) {
      return modifyResponse();
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

type GuestSeed = {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember?: boolean;
};

function makeBooking(
  guests: GuestSeed[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: guests.map((g) => ({
      id: g.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember ?? true,
      memberId: null,
      stayStart: null,
      stayEnd: null,
      nights: null,
      priceCents: 5000,
    })),
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
    ...overrides,
  };
}

const JUSTIFICATION_LABEL = /Reason for leaving no adult on the booking/i;

function reviewField() {
  return screen.queryByLabelText(JUSTIFICATION_LABEL);
}

function removeButtons() {
  return screen.getAllByRole("button", { name: "Remove" });
}

async function waitForSaveEnabled() {
  const saveButton = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(saveButton).not.toBeDisabled(), { timeout: 2500 });
  return saveButton;
}

function modifyPutCalls() {
  return fetchCalls.filter(
    (c) => c.method === "PUT" && c.url.endsWith(`/api/bookings/${BOOKING_ID}/modify`),
  );
}

beforeEach(() => {
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — no-adult review justification (#2104)", () => {
  it("renders the justification field when removing the last adult leaves minors only", () => {
    render(
      <EditBookingPanel
        booking={makeBooking([
          { id: "g1", firstName: "Ada", lastName: "Adult", ageTier: "ADULT" },
          { id: "g2", firstName: "Kai", lastName: "Kid", ageTier: "CHILD" },
        ])}
        onDone={vi.fn()}
      />,
    );

    expect(reviewField()).toBeNull();
    // Remove the adult (first guest row) -> remaining is the child only.
    fireEvent.click(removeButtons()[0]);
    expect(reviewField()).not.toBeNull();
  });

  it("renders the field when the post-edit set is minors only via an added child", () => {
    render(
      <EditBookingPanel
        booking={makeBooking([
          { id: "g1", firstName: "Ada", lastName: "Adult", ageTier: "ADULT" },
          { id: "g2", firstName: "Bea", lastName: "Adult", ageTier: "ADULT" },
        ])}
        onDone={vi.fn()}
      />,
    );

    expect(reviewField()).toBeNull();

    // Add a non-member CHILD. The control is named "+ Add Non-Member Guest"
    // since MG4 (#2309) put a second, member-guest button beside it in the
    // Guests card header — an unqualified "+ Add Guest" no longer exists on
    // this surface, and on an in-progress edit the same control reads
    // "+ Add Future Non-Member Guest".
    fireEvent.click(screen.getByRole("button", { name: "+ Add Non-Member Guest" }));
    fireEvent.change(screen.getByLabelText("First Name"), {
      target: { value: "Tam" },
    });
    fireEvent.change(screen.getByLabelText("Last Name"), {
      target: { value: "Tot" },
    });
    fireEvent.change(screen.getByLabelText("Age Category"), {
      target: { value: "CHILD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    // Still hidden: two adults remain.
    expect(reviewField()).toBeNull();

    // Remove both adults -> only the added child remains.
    fireEvent.click(removeButtons()[0]);
    fireEvent.click(removeButtons()[0]);
    expect(reviewField()).not.toBeNull();
  });

  it("blocks the save with an inline error and no PUT when the reason is empty", async () => {
    render(
      <EditBookingPanel
        booking={makeBooking([
          { id: "g1", firstName: "Ada", lastName: "Adult", ageTier: "ADULT" },
          { id: "g2", firstName: "Kai", lastName: "Kid", ageTier: "CHILD" },
        ])}
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(removeButtons()[0]);
    const saveButton = await waitForSaveEnabled();

    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(
        screen.getByText(/Please add a reason so an admin can review/i),
      ).toBeTruthy(),
    );
    expect(modifyPutCalls()).toHaveLength(0);
  });

  it("sends memberReviewJustification in the PUT body when a reason is supplied", async () => {
    const onDone = vi.fn();
    render(
      <EditBookingPanel
        booking={makeBooking([
          { id: "g1", firstName: "Ada", lastName: "Adult", ageTier: "ADULT" },
          { id: "g2", firstName: "Kai", lastName: "Kid", ageTier: "CHILD" },
        ])}
        onDone={onDone}
      />,
    );

    fireEvent.click(removeButtons()[0]);
    const saveButton = await waitForSaveEnabled();

    fireEvent.change(screen.getByLabelText(JUSTIFICATION_LABEL), {
      target: { value: "Grandparent is collecting them each night." },
    });
    fireEvent.click(saveButton);

    await waitFor(() => expect(modifyPutCalls()).toHaveLength(1));
    const body = modifyPutCalls()[0].body as Record<string, unknown>;
    expect(body.memberReviewJustification).toBe(
      "Grandparent is collecting them each night.",
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("reveals the field reactively when the server returns REVIEW_JUSTIFICATION_REQUIRED", async () => {
    // Two adults; remove one leaves an adult, so the local predicate does NOT
    // trip and the field starts hidden — only the server response reveals it.
    modifyResponse = () =>
      jsonResponse(
        {
          error:
            "Removing the last adult requires a written reason so an admin can review. Please add a justification and try again.",
          code: "REVIEW_JUSTIFICATION_REQUIRED",
        },
        400,
      );

    render(
      <EditBookingPanel
        booking={makeBooking([
          { id: "g1", firstName: "Ada", lastName: "Adult", ageTier: "ADULT" },
          { id: "g2", firstName: "Bea", lastName: "Adult", ageTier: "ADULT" },
        ])}
        onDone={vi.fn()}
      />,
    );

    expect(reviewField()).toBeNull();
    fireEvent.click(removeButtons()[0]);
    const saveButton = await waitForSaveEnabled();

    // Local predicate did not trip (an adult remains).
    expect(reviewField()).toBeNull();
    fireEvent.click(saveButton);

    await waitFor(() => expect(reviewField()).not.toBeNull());
    expect(
      screen.getByText(/requires a written reason|Please add a reason/i),
    ).toBeTruthy();
  });

  it("never shows the field when acting as an admin", () => {
    render(
      <EditBookingPanel
        booking={makeBooking(
          [
            { id: "g1", firstName: "Ada", lastName: "Adult", ageTier: "ADULT" },
            { id: "g2", firstName: "Kai", lastName: "Kid", ageTier: "CHILD" },
          ],
          { viewerRole: "ADMIN" },
        )}
        canAdminOverride
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(removeButtons()[0]);
    expect(reviewField()).toBeNull();
  });

  it("does not re-prompt when the booking is already flagged for review", () => {
    render(
      <EditBookingPanel
        booking={makeBooking(
          [
            { id: "g1", firstName: "Ada", lastName: "Adult", ageTier: "ADULT" },
            { id: "g2", firstName: "Kai", lastName: "Kid", ageTier: "CHILD" },
          ],
          { requiresAdminReview: true, adminReviewStatus: "PENDING" },
        )}
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(removeButtons()[0]);
    expect(reviewField()).toBeNull();
  });
});
