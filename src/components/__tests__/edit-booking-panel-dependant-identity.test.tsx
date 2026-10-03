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

type Handler = (body: Record<string, unknown>) => Response;

function installFetch(
  familyResponses: Array<Record<string, unknown>>,
  handlers: { modify?: Handler; exceptionRequest?: Handler } = {},
) {
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
    if (url.includes("/exception-requests") && handlers.exceptionRequest) {
      return handlers.exceptionRequest(parsedBody as Record<string, unknown>);
    }
    if (url.endsWith("/modify") && handlers.modify) {
      return handlers.modify(parsedBody as Record<string, unknown>);
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

  describe("an existing guest RENAMED onto the dependant's name", () => {
    const ALEX = {
      id: "g2",
      firstName: "Alex",
      lastName: "Brown",
      ageTier: "CHILD",
      isMember: false,
      memberId: null,
      stayStart: null,
      stayEnd: null,
      nights: null,
      priceCents: 3000,
    };

    function bookingWithAlex() {
      const booking = makeBooking();
      return { ...booking, guests: [...booking.guests, ALEX] };
    }

    function renameAlexToSam() {
      fireEvent.change(document.getElementById("guest-g2-first") as HTMLElement, {
        target: { value: "Sam" },
      });
      fireEvent.change(document.getElementById("guest-g2-last") as HTMLElement, {
        target: { value: "Smith" },
      });
    }

    it("asks, and resends the rename with the 'different person' answer", async () => {
      installFetch([FAMILY]);
      render(<EditBookingPanel booking={bookingWithAlex()} onDone={vi.fn()} />);
      await waitFor(() =>
        expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
      );

      renameAlexToSam();
      await vi.advanceTimersByTimeAsync(600);

      expect(
        await screen.findByText("Is this your own family member?"),
      ).toBeInTheDocument();
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
      expect(
        (lastQuoteBody() as { guestUpdates?: unknown[] } | undefined)?.guestUpdates,
      ).toEqual([{ guestId: "g2", firstName: "Sam", lastName: "Smith" }]);
    });

    it("replaces the renamed row with the dependant as a member when it IS them", async () => {
      installFetch([FAMILY]);
      render(<EditBookingPanel booking={bookingWithAlex()} onDone={vi.fn()} />);
      await waitFor(() =>
        expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
      );

      renameAlexToSam();
      fireEvent.click(
        await screen.findByRole("button", {
          name: /This is my dependant — book them as a member/,
        }),
      );
      await vi.advanceTimersByTimeAsync(600);

      await waitFor(() => {
        const body = lastQuoteBody() as
          | (AddGuestBody & { removeGuestIds?: string[]; guestUpdates?: unknown[] })
          | undefined;
        expect(body?.removeGuestIds).toEqual(["g2"]);
        expect(body?.addGuests?.[0]).toMatchObject({ memberId: SAM.id, isMember: true });
        expect(body?.guestUpdates).toBeUndefined();
      });
      expect(screen.queryByText("Is this your own family member?")).toBeNull();
    });
  });

  describe("the answers on a Booking Officer request (#3451 review)", () => {
    const MIN_STAY_VIOLATION = {
      reasonCode: "MINIMUM_STAY",
      policyId: "policy-weekend",
      policyVersion: 3,
      policyName: "Weekend minimum",
      resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-1" },
      affectedNights: ["2026-09-01"],
      exceptionEligible: true,
      capacityMode: "HOLD",
      message: "Two nights are required.",
      minimumNights: 2,
      actualNights: 1,
      requirements: { kind: "MINIMUM_STAY", minimumNights: 2, actualNights: 1, triggerDays: [1] },
    };
    const minStayRefusal = () =>
      jsonResponse(
        {
          error: "These dates do not meet the minimum-stay rules.",
          code: "MINIMUM_STAY_VIOLATION",
          violations: [MIN_STAY_VIOLATION],
          exceptionReview: { violations: [MIN_STAY_VIOLATION], capacityMode: "HOLD" },
        },
        400,
      );
    const created = () =>
      jsonResponse(
        {
          id: "req-1",
          status: "REQUESTED",
          proposalHash: "abc",
          reasonCodes: ["MINIMUM_STAY"],
          aggregateCapacityMode: "NO_HOLD",
          proposal: {
            lodgeId: "lodge-1",
            checkIn: "2026-09-01",
            checkOut: "2026-09-03",
            guests: [
              { firstName: "Pat", lastName: "Smith", ageTier: "ADULT", isMember: true, nights: ["2026-09-01", "2026-09-02"] },
            ],
            guestNights: 2,
            baseCheckIn: "2026-09-01",
            baseCheckOut: "2026-09-03",
            baseGuestNights: 2,
          },
          capacityHeld: false,
        },
        201,
      );

    async function saveThenRequest() {
      const save = screen.getByRole("button", { name: "Save Changes" });
      await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 2500 });
      fireEvent.click(save);
      await screen.findByTestId("request-officer-approval");
      fireEvent.change(screen.getByLabelText(/Why are you asking/i), {
        target: { value: "Please." },
      });
      fireEvent.click(
        screen.getByRole("button", { name: /Request Booking Officer approval/i }),
      );
    }

    function requestBodies() {
      return fetchCalls
        .filter((call) => call.url.includes("/exception-requests"))
        .map((call) => call.body as Record<string, unknown>);
    }

    it("does not carry an answer about a RENAMED row, which the request cannot carry", async () => {
      installFetch([FAMILY], {
        modify: minStayRefusal,
        // The server's half: an answer naming nobody the request adds is refused.
        exceptionRequest: (body) =>
          body.dependantIdentityDeclarations
            ? jsonResponse({ code: "DEPENDANT_IDENTITY_DECLARATION_INVALID", error: "x" }, 400)
            : created(),
      });
      const booking = makeBooking();
      render(
        <EditBookingPanel
          booking={{
            ...booking,
            guests: [
              ...booking.guests,
              { id: "g2", firstName: "Alex", lastName: "Brown", ageTier: "CHILD", isMember: false, memberId: null, stayStart: null, stayEnd: null, nights: null, priceCents: 3000 },
            ],
          }}
          onDone={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
      );
      fireEvent.change(document.getElementById("guest-g2-first") as HTMLElement, { target: { value: "Sam" } });
      fireEvent.change(document.getElementById("guest-g2-last") as HTMLElement, { target: { value: "Smith" } });
      fireEvent.click(
        await screen.findByRole("button", { name: "This is a different person with the same name" }),
      );
      await vi.advanceTimersByTimeAsync(600);

      await saveThenRequest();

      await waitFor(() => expect(requestBodies()).toHaveLength(1));
      expect(requestBodies()[0].dependantIdentityDeclarations).toBeUndefined();
      // The request went through.
      expect(await screen.findByTestId("exception-request-sent")).toBeInTheDocument();
    });

    it("puts the question back when the request is refused over an answer", async () => {
      installFetch([FAMILY], {
        modify: minStayRefusal,
        exceptionRequest: () =>
          jsonResponse({ code: "DEPENDANT_IDENTITY_DECLARATION_INVALID", error: "stale answer" }, 400),
      });
      render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
      await waitFor(() =>
        expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
      );
      await typeInGuest("Sam", "Smith");
      fireEvent.click(
        await screen.findByRole("button", { name: "This is a different person with the same name" }),
      );
      await vi.advanceTimersByTimeAsync(600);
      const familyReadsBefore = fetchCalls.filter((call) =>
        call.url.includes("/api/members/family"),
      ).length;

      await saveThenRequest();

      await waitFor(() => expect(requestBodies()).toHaveLength(1));
      expect(requestBodies()[0].dependantIdentityDeclarations).toHaveLength(1);
      // The answer is cleared (the question is asked again) and the list re-read.
      expect(
        await screen.findByRole("button", { name: "This is a different person with the same name" }),
      ).toBeInTheDocument();
      expect(
        fetchCalls.filter((call) => call.url.includes("/api/members/family")).length,
      ).toBeGreaterThan(familyReadsBefore);
    });
  });

  it("asks an officer on their OWN booking in the member's words (ownership, not role)", async () => {
    installFetch([FAMILY]);
    render(
      <EditBookingPanel
        booking={makeBooking({ viewerRole: "ADMIN", viewerIsBookingOwner: true })}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(fetchCalls.some((call) => call.url.includes("/eligible-family"))).toBe(true),
    );

    await typeInGuest("Sam", "Smith");

    expect(await screen.findByText("Is this your own family member?")).toBeInTheDocument();
    expect(screen.queryByText("Is this Pat's own family member?")).toBeNull();
  });

  it("announces the question through a polite live region", async () => {
    installFetch([FAMILY]);
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await waitFor(() =>
      expect(fetchCalls.some((call) => call.url.includes("/api/members/family"))).toBe(true),
    );
    await typeInGuest("Sam", "Smith");
    const question = await screen.findByText("Is this your own family member?");
    const region = question.closest('[role="status"]');
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "polite");
  });
});
