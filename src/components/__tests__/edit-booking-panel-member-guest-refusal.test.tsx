// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import {
  MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE,
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/member-guest-refusal";

/*
  Finding 3 of the MG3 (#2308) privacy re-review.

  Once a booking carries a cross-family member guest, C1's marking makes every
  date change re-ask the person-night question about that member. So this
  panel's debounced auto-quote can be answered with D-8's collapsed refusal —
  "This member can't be added to this booking right now." — on a request whose
  body has no `addGuests` at all. The booker moved two dates and is told they
  failed to add somebody, about a person referenced nowhere on their screen.

  It reads as a bug, and the natural response to a bug is to try again, which is
  the behaviour #2388's throttle is least able to tell apart from probing — and
  now that the whole-party charge bills every such preview, those retries spend
  the honest booker's own budget.

  WHAT MUST NOT CHANGE, and is asserted here alongside: the SERVER's answer. The
  collapse exists so two refusals cannot be told apart, and varying the server's
  reply by anything at all would undo it. What the panel may safely do is
  describe its OWN request more accurately — nothing is disclosed by a browser
  telling its user what the browser just sent.
*/

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2308";

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Exactly what the server sends for a collapsed cross-family refusal. */
const COLLAPSED_REFUSAL = {
  code: MEMBER_GUEST_NOT_ADDABLE_CODE,
  error: MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
};

function installFetch(quoteResponse: () => Response) {
  fetchCalls = [];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let parsedBody: unknown;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    fetchCalls.push({ url, method: init?.method ?? "GET", body: parsedBody });

    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/modify-quote")) return quoteResponse();
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: [
      {
        id: "g1",
        firstName: "Bea",
        lastName: "Booker",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m-booker",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
      {
        // The member guest added weeks ago. The booker can see they are on the
        // booking; what they may not see is where ELSE that person is booked.
        id: "g2",
        firstName: "Dana",
        lastName: "Doe",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m-outsider",
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
    ...overrides,
  };
}

function quoteCalls() {
  return fetchCalls.filter((call) => call.url.includes("/modify-quote"));
}

/** Move the check-out date — a change that adds nobody. */
function changeCheckOut(to: string) {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="date"]'),
  );
  const target = inputs[inputs.length - 1];
  expect(target).toBeTruthy();
  fireEvent.change(target, { target: { value: to } });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EditBookingPanel — the collapsed member-guest refusal (#2308 finding 3)", () => {
  it("does NOT say 'can't be added' when the request added nobody", async () => {
    installFetch(() => jsonResponse(COLLAPSED_REFUSAL, 403));
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    changeCheckOut("2026-09-05");
    await vi.advanceTimersByTimeAsync(600);

    await waitFor(() => expect(quoteCalls().length).toBeGreaterThan(0));
    // The request really did add nobody — the premise of the whole finding.
    expect(quoteCalls()[0].body).not.toHaveProperty("addGuests");

    await waitFor(() =>
      expect(screen.getByText(MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE)).toBeInTheDocument(),
    );
    // The wording that names an act the booker did not perform is gone, and so
    // is any reference to a person they cannot see on this screen.
    expect(screen.queryByText(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE)).toBeNull();
    expect(screen.queryByText(/can't be added/i)).toBeNull();
  });

  it("keeps the server's own wording verbatim for any OTHER refusal", async () => {
    // Only the collapsed member-guest code is re-worded. An ordinary refusal is
    // shown exactly as sent, or the panel starts inventing errors.
    installFetch(() =>
      jsonResponse({ error: "No season rate found for the requested dates" }, 400),
    );
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    changeCheckOut("2026-09-05");
    await vi.advanceTimersByTimeAsync(600);

    await waitFor(() =>
      expect(
        screen.getByText("No season rate found for the requested dates"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE)).toBeNull();
  });

  it("repeated date-change quotes never change what the SERVER was asked", async () => {
    // The debounce sequence the finding is about: several date tweaks in a row
    // on a booking that carries a cross-family member guest. Each one is a fresh
    // quote adding nobody, each is refused, and the panel's wording is the same
    // accurate sentence every time — it never degrades back into "can't be
    // added" once the booker keeps going.
    //
    // The audit side of this sequence — at most ONE severity-`important`
    // repeated-refusal row per actor/target per window, with every individual
    // refusal row preserved — is pinned server-side in
    // `member-guest-probe-guard.test.ts`, which drives the same eight-refusal
    // run against `recordMemberGuestAddRefusal`.
    installFetch(() => jsonResponse(COLLAPSED_REFUSAL, 403));
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    for (const day of ["2026-09-05", "2026-09-06", "2026-09-07"]) {
      changeCheckOut(day);
      await vi.advanceTimersByTimeAsync(600);
    }

    await waitFor(() => expect(quoteCalls().length).toBeGreaterThanOrEqual(2));
    for (const call of quoteCalls()) {
      expect(call.body).not.toHaveProperty("addGuests");
    }
    await waitFor(() =>
      expect(screen.getByText(MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/can't be added/i)).toBeNull();
  });
});
