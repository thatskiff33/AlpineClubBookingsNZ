// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import { CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE } from "@/lib/booking-change-request-guests";
import { REPLY_SPEEDS, expectToHoldFocus, replyDelay } from "@/lib/__tests__/helpers/focus";

// #2124: on an in-progress stay the change-dates UI must keep the original
// (past) check-in fixed and let the member extend the check-out night by night
// from the editable-from date, with copy that explains the minimum-stay rule
// applies to the whole stay (not the added nights).

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-2124";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(quoteOverrides: Record<string, unknown> = {}) {
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
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

// In-progress booking: check-in 2026-08-14 is in the past, editable-from is
// tomorrow (2026-08-16), so the member can only extend the check-out forward.
function inProgressBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-08-14",
    checkOut: "2026-08-18",
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
        priceCents: 30000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 30000,
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    editPolicy: {
      mode: "in-progress" as const,
      today: "2026-08-15",
      editableFrom: "2026-08-16",
      checkInEditable: false,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
    ...overrides,
  };
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — in-progress date extension (#2124)", () => {
  it("sends the edited dates with the card quote and the same proposal on submission (#4090)", async () => {
    const baseFetch = global.fetch;
    let quoted: Record<string, unknown> | undefined;
    let submitted: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/modify-quote")) {
        return jsonResponse({ error: "This booking is locked" }, 400);
      }
      if (url.endsWith("/change-requests/quote")) {
        quoted = JSON.parse(String(init?.body));
        return jsonResponse({ error: CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE }, 400);
      }
      if (url.endsWith("/change-requests")) {
        submitted = JSON.parse(String(init?.body));
        return jsonResponse({ error: CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE }, 400);
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    render(<EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Check-out"), { target: { value: "2026-08-19" } });
    await screen.findByText("This booking is locked");
    const card = within(screen.getByText("Admin Request").parentElement!.parentElement!);
    fireEvent.change(card.getByLabelText("First name"), { target: { value: "Ari" } });
    fireEvent.change(card.getByLabelText("Last name"), { target: { value: "Visitor" } });
    fireEvent.change(card.getByLabelText("Age"), { target: { value: "CHILD" } });
    fireEvent.click(card.getByRole("button", { name: "Add guest" }));
    await card.findByText(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE);
    expect(quoted).toMatchObject({
      editorChanges: { checkOut: "2026-08-19" },
      addGuests: [{ firstName: "Ari", stayStart: "2026-08-14", stayEnd: "2026-08-18" }],
    });
    expect(card.queryByText(/Estimated price for these guests/)).not.toBeInTheDocument();

    fireEvent.click(card.getByRole("button", { name: "Request Admin Review" }));
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({ checkOut: "2026-08-19", addGuests: quoted!.addGuests });
  });

  // #5442: the request button is disabled while the request runs, which drops
  // its focus to <body>; a refusal leaves it in place, so focus goes back.
  it.each(REPLY_SPEEDS)("keeps focus on Request Admin Review when the request is refused ($speed reply)", async ({ delayMs }) => {
    const baseFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/modify-quote")) {
        return jsonResponse({ error: "This booking is locked" }, 400);
      }
      if (url.endsWith("/change-requests")) {
        await replyDelay(delayMs);
        return jsonResponse({ error: "The club could not take that request." }, 400);
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    render(<EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Check-out"), { target: { value: "2026-08-19" } });
    await screen.findByText("This booking is locked");
    const button = screen.getByRole("button", { name: "Request Admin Review" });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });

    await screen.findByText("The club could not take that request.");
    await expectToHoldFocus(button, "Request Admin Review");
  });

  it.each(REPLY_SPEEDS)("keeps focus on Save changes when the save is refused ($speed reply)", async ({ delayMs }) => {
    const baseFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/modify")) {
        await replyDelay(delayMs);
        return jsonResponse({ error: "The club could not save that change." }, 400);
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    render(<EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Check-out"), { target: { value: "2026-08-19" } });
    const button = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(button).toBeEnabled());
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });

    await screen.findByText("The club could not save that change.");
    await expectToHoldFocus(button, "Save changes");
  });

  it("renders the check-in fixed at the original past date", () => {
    render(
      <EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />,
    );

    const checkIn = screen.getByLabelText("Check-in") as HTMLInputElement;
    expect(checkIn).toBeDisabled();
    expect(checkIn.value).toBe("2026-08-14");
  });

  it("lets the check-out extend forward from the editable-from date", () => {
    render(
      <EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />,
    );

    const checkOut = screen.getByLabelText("Check-out") as HTMLInputElement;
    expect(checkOut).not.toBeDisabled();
    // The earliest selectable check-out is the editable-from (tomorrow) date,
    // so today and earlier stay locked.
    expect(checkOut.min).toBe("2026-08-16");
    expect(checkOut.value).toBe("2026-08-18");
  });

  it("explains that the check-in is fixed and minimum-stay applies to the whole stay", () => {
    render(
      <EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />,
    );

    expect(
      screen.getByText(/check-in date stays fixed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/minimum-stay rules apply to your whole stay/i),
    ).toBeInTheDocument();
  });

  it("renders the advisory warning when a quote flags the whole stay under a minimum", async () => {
    // #2124 review: the verdict must be VISIBLE to the member. It is advisory
    // only — Save is not gated on it (pinned below), matching the future-edit
    // semantics; the hard block lives on the create path.
    installFetch({
      minimumStayValid: false,
      minimumStayViolations: [
        { message: "Stays including a Friday or Saturday night must be at least 2 nights." },
      ],
    });
    render(
      <EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />,
    );

    const checkOut = screen.getByLabelText("Check-out") as HTMLInputElement;
    // Shorten to the earliest allowed check-out to trigger a fresh quote.
    fireEvent.change(checkOut, { target: { value: "2026-08-16" } });

    expect(
      await screen.findByText(
        /leave your stay under a minimum-stay rule/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/at least 2 nights/i),
    ).toBeInTheDocument();
    // Advisory only: Save stays enabled despite the flagged minimum.
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeEnabled();
  });
});
