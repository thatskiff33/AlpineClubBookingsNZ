// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import {
  DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
  DIFFERENT_PERSON_SAME_NAME,
} from "@/lib/booking-dependant-identity";

/*
  #3451 — the edit panel ASKS (`INV-GUEST-019`; owner decision 1 Oct 2026,
  option C, "ask in place on add-guest").

  A member adding a typed guest to an existing booking whose name is one of their
  own recorded dependants used to get a second, provisional person for that
  child, silently. The panel now draws the create wizard's own question beside
  the added row, and each answer changes what the NEXT quote asks the server:
  "this is my dependant" moves the row onto the member path, "a different person"
  sends the declaration the server re-checks. The fetch double plays the server's
  part — it refuses the unanswered party with the guard's own body — so the
  assertions are about the requests the panel actually sends.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-3451";
const OWNER = "m-owner";
const SAM = { id: "dep-sam", firstName: "Sam", lastName: "Smith" };

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_QUOTE = {
  newTotalPriceCents: 8000,
  newDiscountCents: 0,
  newPromoAdjustmentCents: 0,
  newFinalPriceCents: 8000,
  priceDiffCents: 3000,
  changeFeeCents: 0,
  netChargeCents: 3000,
  settlementOptions: null,
  capacityAvailable: true,
  promoStillValid: true,
  promoValidation: null,
  itemizedChanges: [],
};

type AddGuestBody = {
  addGuests?: Array<{ firstName: string; lastName: string; memberId?: string }>;
  dependantIdentityDeclarations?: unknown[];
};

/** The server's half, reduced to the guard: refuse an unanswered Sam Smith. */
function guardedQuote(body: AddGuestBody) {
  const unanswered = (body.addGuests ?? []).some(
    (guest) =>
      !guest.memberId &&
      `${guest.firstName} ${guest.lastName}`.toLowerCase() === "sam smith",
  );
  if (unanswered && !body.dependantIdentityDeclarations?.length) {
    return jsonResponse(
      {
        code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
        error: DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
      },
      409,
    );
  }
  return jsonResponse(OK_QUOTE);
}

function installFetch(familyResponses: Array<Record<string, unknown>>) {
  fetchCalls = [];
  let familyCall = 0;
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

    if (
      url.includes("/api/members/family") ||
      url.includes("/eligible-family")
    ) {
      const response =
        familyResponses[Math.min(familyCall, familyResponses.length - 1)];
      familyCall += 1;
      return jsonResponse(response);
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/modify-quote")) {
      return guardedQuote(parsedBody as AddGuestBody);
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
}

const FAMILY = {
  familyMembers: [
    { id: OWNER, firstName: "Pat", lastName: "Smith", ageTier: "ADULT", relationship: "self", canBeBooked: true },
    { id: SAM.id, firstName: "Sam", lastName: "Smith", ageTier: "CHILD", relationship: "dependent", canBeBooked: true },
  ],
  partnerSharingCandidates: [],
  ownDependants: [SAM],
};

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    memberId: OWNER,
    guests: [
      {
        id: "g1",
        firstName: "Pat",
        lastName: "Smith",
        ageTier: "ADULT",
        isMember: true,
        memberId: OWNER,
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 5000,
    totalPriceCents: 5000,
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

function quoteBodies(): AddGuestBody[] {
  return fetchCalls
    .filter((call) => call.url.includes("/modify-quote"))
    .map((call) => call.body as AddGuestBody);
}

function lastQuoteBody(): AddGuestBody | undefined {
  return quoteBodies().at(-1);
}

async function typeInGuest(firstName: string, lastName: string) {
  fireEvent.click(screen.getByRole("button", { name: /Add Non-Member Guest/ }));
  fireEvent.change(screen.getByLabelText("First Name"), {
    target: { value: firstName },
  });
  fireEvent.change(screen.getByLabelText("Last Name"), {
    target: { value: lastName },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await vi.advanceTimersByTimeAsync(600);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EditBookingPanel — an added guest named as the owner's dependant (#3451)", () => {
  it("asks, shows the server's refusal, and resends with the 'different person' answer", async () => {
    installFetch([FAMILY]);
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await waitFor(() =>
      expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
    );

    await typeInGuest("sam", "Smith");

    // The question is on screen beside the added row...
    expect(
      await screen.findByText("Is this your own family member?"),
    ).toBeInTheDocument();
    // ...and the server refused the unanswered party with the guard's sentence.
    await waitFor(() =>
      expect(screen.getByText(DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE)).toBeInTheDocument(),
    );
    expect(lastQuoteBody()?.dependantIdentityDeclarations).toBeUndefined();

    fireEvent.click(
      screen.getByRole("button", {
        name: "This is a different person with the same name",
      }),
    );
    await vi.advanceTimersByTimeAsync(600);

    await waitFor(() =>
      expect(lastQuoteBody()?.dependantIdentityDeclarations).toEqual([
        {
          kind: DIFFERENT_PERSON_SAME_NAME,
          dependantMemberId: SAM.id,
          normalizedName: "sam smith",
        },
      ]),
    );
    // The row stays a non-member guest; only the answer travels with it.
    expect(lastQuoteBody()?.addGuests?.[0]?.memberId).toBeUndefined();
    await waitFor(() =>
      expect(screen.queryByText(DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE)).toBeNull(),
    );
  });

  it("moves the row onto the member path when the member says it is their dependant", async () => {
    installFetch([FAMILY]);
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await waitFor(() =>
      expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
    );

    await typeInGuest("Sam", "Smith");
    fireEvent.click(
      await screen.findByRole("button", {
        name: /This is my dependant — book them as a member/,
      }),
    );
    await vi.advanceTimersByTimeAsync(600);

    await waitFor(() =>
      expect(lastQuoteBody()?.addGuests?.[0]).toMatchObject({
        memberId: SAM.id,
        isMember: true,
      }),
    );
    expect(lastQuoteBody()?.dependantIdentityDeclarations).toBeUndefined();
    expect(screen.queryByText("Is this your own family member?")).toBeNull();
  });

  it("asks nothing about a name that is nobody's dependant", async () => {
    installFetch([FAMILY]);
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await waitFor(() =>
      expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
    );

    await typeInGuest("Alex", "Brown");

    await waitFor(() => expect(quoteBodies().length).toBeGreaterThan(0));
    expect(screen.queryByText("Is this your own family member?")).toBeNull();
    expect(lastQuoteBody()?.dependantIdentityDeclarations).toBeUndefined();
  });

  it("re-reads a stale family list when the server refuses a collision the panel could not see", async () => {
    // The first load predates the dependant being recorded; the server knows.
    installFetch([{ ...FAMILY, ownDependants: [] }, FAMILY]);
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await waitFor(() =>
      expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
    );

    await typeInGuest("Sam", "Smith");

    expect(
      await screen.findByText("Is this your own family member?"),
    ).toBeInTheDocument();
    expect(
      fetchCalls.filter((call) => call.url.includes("/api/members/family")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("asks an officer about the OWNER's dependant, in the officer's words", async () => {
    installFetch([FAMILY]);
    render(
      <EditBookingPanel
        booking={makeBooking({ viewerRole: "ADMIN" })}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(fetchCalls.some((call) => call.url.includes("/eligible-family"))).toBe(true),
    );

    await typeInGuest("Sam", "Smith");

    expect(
      await screen.findByText("Is this Pat's own family member?"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "This is a different person with the same name",
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() =>
      expect(lastQuoteBody()?.dependantIdentityDeclarations).toHaveLength(1),
    );
  });
});
