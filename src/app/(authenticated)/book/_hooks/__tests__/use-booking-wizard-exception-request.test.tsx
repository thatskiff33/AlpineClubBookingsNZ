// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #2562 — the new-booking half of the member-facing exception workflow.
 *
 * The wizard's job is narrow and it is the whole safety story: hold an offer ONLY
 * when the server's own refusal said the blockage is reviewable, and send the SAME
 * payload that was refused. So these cases are about which refusals open the door,
 * when it closes again, and what goes on the wire.
 */

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  // #2562: `/book?replaceRequest=<id>` is how the member's request list sends
  // somebody back here to correct an open request.
  useSearchParams: () => searchParams,
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "member-1", role: "MEMBER", accessRoles: [] } },
  }),
}));

vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: () => false,
  hasAccessRole: () => true,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

/*
  #2701: `useLodgeOptions` now reports `failed`, `forbidden` and `reload`
  alongside `lodges`/`loading`, and the wizard destructures three of the five —
  so a factory that returns only the old two hands its consumer `undefined`
  where it expects a function. Mocked PARTIALLY over the real module so the next
  export the wizard reaches for is already present, and the object is built once
  so `reload` keeps a stable identity across renders.

  The list is no longer empty either. #2701 refuses a submit whose lodge is
  unknown, so an empty list would put every case below into that refusal instead
  of the offer rules it means to exercise.
*/
vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/components/lodge-select");
  const options = {
    lodges: [
      { id: "lodge-1", name: "Alpine Lodge" },
      { id: "lodge-2", name: "Bush Lodge" },
    ],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  };
  return { ...actual, useLodgeOptions: () => options };
});

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn() } }));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

const MIN_STAY_VIOLATION = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-weekend",
  policyVersion: 3,
  policyName: "Weekend minimum",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-1" },
  affectedNights: ["2026-06-11"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Friday nights need a two-night booking.",
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

const MIN_STAY_REFUSAL = {
  error: "Booking does not meet minimum stay requirement",
  details: "Friday nights need a two-night booking.",
  code: "MINIMUM_STAY_VIOLATION",
  violations: [MIN_STAY_VIOLATION],
  exceptionReview: { violations: [MIN_STAY_VIOLATION], capacityMode: "HOLD" },
};

const FROZEN_PROPOSAL = {
  lodgeId: "lodge-1",
  checkIn: "2026-06-11",
  checkOut: "2026-06-12",
  guests: [
    {
      firstName: "Jo",
      lastName: "Member",
      ageTier: "ADULT",
      isMember: true,
      nights: ["2026-06-11"],
    },
  ],
  guestNights: 1,
  baseCheckIn: null,
  baseCheckOut: null,
  baseGuestNights: null,
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

interface Stubs {
  /** What POST /api/bookings answers. */
  create: () => Response;
  /** What POST /api/bookings/exception-requests answers. */
  request: () => Response;
  /** What the date-step policy precheck answers; valid by default. */
  policyCheck?: () => Response;
}

function stubFetch(stubs: Stubs) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/members/family")) {
      return jsonResponse({
        familyMembers: [
          {
            id: "member-1",
            firstName: "Jo",
            lastName: "Member",
            ageTier: "ADULT",
            relationship: "self",
            canLogin: true,
            canBeBooked: true,
            missingFields: [],
          },
        ],
      });
    }
    if (u.includes("/api/payments/options")) {
      return jsonResponse({
        methods: {
          stripe: { enabled: true, default: true },
          internetBanking: { enabled: false },
        },
        groupBookingsEnabled: false,
      });
    }
    if (u.includes("/api/member/subscription-status")) {
      return jsonResponse({
        status: "PAID",
        seasonDisplay: "2026",
        invoiceUrl: null,
        invoiceNumber: null,
      });
    }
    if (u.includes("/api/booking-messages")) return jsonResponse({ messages: {} });
    if (u.includes("/api/bookings/rooms")) {
      return jsonResponse({ enabled: false, rooms: [] });
    }
    if (u.includes("/api/availability/check")) {
      return jsonResponse({ minAvailable: 20, nightDetails: [] });
    }
    if (u.includes("/api/booking-policies/check")) {
      return (
        stubs.policyCheck?.() ??
        jsonResponse({
          valid: true,
          violations: [],
          exceptionReview: { violations: [], capacityMode: null },
          message: null,
        })
      );
    }
    if (u.includes("/api/bookings/quote")) {
      return jsonResponse({
        guests: [{ ageTier: "ADULT", isMember: true, nights: 1, priceCents: 6000 }],
        totalPriceCents: 6000,
      });
    }
    if (u.includes("/api/bookings/exception-requests")) return stubs.request();
    if (u.endsWith("/api/bookings") && init?.method === "POST") return stubs.create();
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seatedWizard(stubs: Stubs) {
  const fetchMock = stubFetch(stubs);
  const { result } = renderHook(() => useBookingWizard());
  await waitFor(() => expect(result.current.guests).toHaveLength(1));
  // The hook owns lodge selection state; mocking useLodgeOptions supplies the
  // choices but does not run LodgeSelect's defaulting effect. Name the lodge
  // these proposal tests mean before exercising any create path (#2701).
  act(() => result.current.handleLodgeChange("lodge-1"));
  await act(async () => {
    await result.current.handleDateSelect("2026-06-11", "2026-06-12");
  });
  expect(result.current.step).toBe("guests");
  await act(async () => {
    await result.current.handleGuestsDone();
  });
  await waitFor(() => expect(result.current.priceQuote).not.toBeNull());
  return { result, fetchMock };
}

const REQUEST_CREATED = () =>
  jsonResponse(
    {
      id: "req-new",
      status: "REQUESTED",
      proposalHash: "abc",
      reasonCodes: ["MINIMUM_STAY"],
      aggregateCapacityMode: "HOLD",
      proposal: FROZEN_PROPOSAL,
      capacityHeld: false,
    },
    true,
    201,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
});

describe("booking wizard — when a refusal opens the request door", () => {
  it("lets a server-confirmed reviewable date policy reach the exact-party flow without opening the door early", async () => {
    stubFetch({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
      policyCheck: () =>
        jsonResponse({
          valid: false,
          violations: [MIN_STAY_VIOLATION],
          exceptionReview: {
            violations: [MIN_STAY_VIOLATION],
            capacityMode: "HOLD",
          },
          message: "Friday nights need a two-night booking.",
        }),
    });
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.guests).toHaveLength(1));

    act(() => result.current.handleLodgeChange("lodge-1"));
    await act(async () => {
      await result.current.handleDateSelect("2026-06-11", "2026-06-12");
    });

    expect(result.current.step).toBe("guests");
    expect(result.current.error).toBe("");
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("keeps a date policy failure closed when its review is not fully eligible", async () => {
    stubFetch({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
      policyCheck: () =>
        jsonResponse({
          valid: false,
          violations: [MIN_STAY_VIOLATION],
          exceptionReview: { violations: [], capacityMode: null },
          message: "This stay cannot proceed.",
        }),
    });
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.guests).toHaveLength(1));

    act(() => result.current.handleLodgeChange("lodge-1"));
    await act(async () => {
      await result.current.handleDateSelect("2026-06-11", "2026-06-12");
    });

    expect(result.current.step).toBe("dates");
    expect(result.current.error).toBe("This stay cannot proceed.");
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("holds an offer after a minimum-stay refusal, with the server's own violations", async () => {
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).not.toBeNull();
    expect(result.current.exceptionOffer?.code).toBe("MINIMUM_STAY_VIOLATION");
    expect(result.current.exceptionOffer?.violations).toHaveLength(1);
    // The refusal banner is unchanged: the offer is an addition, not a replacement.
    expect(result.current.error).toBe(
      "Booking does not meet minimum stay requirement",
    );
  });

  it("holds NOTHING for a hard capacity refusal", async () => {
    const { result } = await seatedWizard({
      create: () =>
        jsonResponse(
          {
            error: "Not enough beds available",
            code: "CAPACITY_EXCEEDED",
            fullNights: ["2026-06-11"],
          },
          false,
          409,
        ),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("holds NOTHING for a refusal that carries no frozen review", async () => {
    const { result } = await seatedWizard({
      create: () =>
        jsonResponse(
          { error: "Something went wrong", code: "MINIMUM_STAY_VIOLATION" },
          false,
          400,
        ),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("opens the door from a refused DRAFT too — the same rules refuse it", async () => {
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSaveAsDraft();
    });
    expect(result.current.exceptionOffer?.code).toBe("MINIMUM_STAY_VIOLATION");
  });

  it("never opens the door from a refused WAITLIST join", async () => {
    // An exception request creates a BOOKING, so offering it as the answer to a
    // refused waitlist join would answer a different question than the one asked.
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleJoinWaitlist();
    });
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("retires a held offer when the member tries again", async () => {
    let create = () => jsonResponse(MIN_STAY_REFUSAL, false, 400);
    const { result } = await seatedWizard({
      create: () => create(),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).not.toBeNull();

    // A second attempt may carry a different payload, so the previous refusal's
    // offer must not survive it.
    create = () =>
      jsonResponse(
        { error: "Not enough beds available", code: "CAPACITY_EXCEEDED" },
        false,
        409,
      );
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).toBeNull();
  });
});

describe("booking wizard — submitting the exception request", () => {
  it("sends the same dates and party the refused create sent, plus the explanation", async () => {
    const { result, fetchMock } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    let created: { id: string } | undefined;
    await act(async () => {
      created = await result.current.submitExceptionRequest({
        memberMessage: "Driving up after work.",
        supersedeRequestId: null,
      });
    });
    expect(created?.id).toBe("req-new");

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/bookings/exception-requests"),
    );
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      checkIn: "2026-06-11",
      checkOut: "2026-06-12",
      memberMessage: "Driving up after work.",
    });
    expect(body.guests).toHaveLength(1);
    expect(body.supersedeRequestId).toBeUndefined();
  });

  it("returns the frozen proposal and the real hold state from the write", async () => {
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    let created: { capacityHeld: boolean } | undefined;
    await act(async () => {
      created = await result.current.submitExceptionRequest({
        memberMessage: "Please.",
        supersedeRequestId: null,
      });
    });
    // A new-booking request holds nothing, and the server said so rather than the
    // client assuming it from the HOLD capacity mode on the offer.
    expect(created?.capacityHeld).toBe(false);
  });

  it("throws the server's own sentence and code so the card can name the next step", async () => {
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: () =>
        jsonResponse(
          {
            error: "A booking-policy exception request is already open.",
            code: "OPEN_EXCEPTION_REQUEST",
          },
          false,
          409,
        ),
    });
    await expect(
      result.current.submitExceptionRequest({
        memberMessage: "Please.",
        supersedeRequestId: null,
      }),
    ).rejects.toMatchObject({
      message: "A booking-policy exception request is already open.",
      code: "OPEN_EXCEPTION_REQUEST",
    });
  });

  it("reads the request being replaced out of the URL", async () => {
    searchParams = new URLSearchParams("replaceRequest=req-old");
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    expect(result.current.replaceExceptionRequestId).toBe("req-old");
  });

  it("treats a blank replaceRequest as absent", async () => {
    searchParams = new URLSearchParams("replaceRequest=%20%20");
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    expect(result.current.replaceExceptionRequestId).toBeNull();
  });

  it("passes the supersede target through to the create call", async () => {
    const { result, fetchMock } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.submitExceptionRequest({
        memberMessage: "Corrected the dates.",
        supersedeRequestId: "req-old",
      });
    });
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/bookings/exception-requests"),
    );
    expect(
      JSON.parse(String((call?.[1] as RequestInit).body)).supersedeRequestId,
    ).toBe("req-old");
  });
});

/**
 * #2562 review — an offer belongs to ONE proposal.
 *
 * Nothing retired a stale offer when the member changed their mind. `handleSubmit`,
 * `handleJoinWaitlist` and `handleSaveAsDraft` cleared it, and no effect watched the
 * dates, the lodge or the party — so a member refused for a one-night Saturday could
 * press Back, extend to two nights (now compliant), return to Review, and still be
 * shown "Ask a Booking Officer to allow this" naming the OLD rule and the OLD
 * affected night above a booking they could make instantly. Clicking it answered 400
 * "This proposal does not trip any reviewable booking-policy exception" — a dead end
 * the card has no remedy branch for. The quieter variant is worse to read: a
 * DIFFERENT short stay kept the previous refusal's nights on screen while the
 * payload that would be frozen was the new one.
 */
describe("booking wizard — an offer belongs to the proposal it was refused for", () => {
  it("retires the offer when the member changes the nights", async () => {
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).not.toBeNull();

    // Back, then extend the stay to two nights. The old refusal describes nights
    // that are no longer being proposed.
    await act(async () => {
      await result.current.handleDateSelect("2026-06-11", "2026-06-13");
    });
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("retires the offer for a DIFFERENT short stay, not just a compliant one", async () => {
    // The milder, worse-reading variant: still refusable, but the card would have
    // described the previous refusal's nights.
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).not.toBeNull();

    await act(async () => {
      await result.current.handleDateSelect("2026-06-18", "2026-06-19");
    });
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("retires the offer when the party changes", async () => {
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).not.toBeNull();

    act(() => {
      result.current.handleGuestsChange([
        ...result.current.guests,
        {
          firstName: "Pat",
          lastName: "Visitor",
          ageTier: "ADULT",
          isMember: false,
        },
      ]);
    });
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("retires the offer when the member changes lodge", async () => {
    // The lodge is part of the proposal's identity. Since #2701 the member must
    // already hold one before submitting, so switching buildings also restarts
    // date selection; either way the old lodge's refusal cannot survive.
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.exceptionOffer).not.toBeNull();

    await act(async () => {
      result.current.handleLodgeChange("lodge-2");
    });
    expect(result.current.checkIn).toBeNull();
    expect(result.current.exceptionOffer).toBeNull();
  });

  it("keeps the offer while the proposal is untouched", async () => {
    // The mirror of the rule: retiring on any re-render at all would take the
    // member's only remedy away from them.
    const { result } = await seatedWizard({
      create: () => jsonResponse(MIN_STAY_REFUSAL, false, 400),
      request: REQUEST_CREATED,
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    act(() => {
      result.current.setNotes("Arriving late.");
    });
    expect(result.current.exceptionOffer?.code).toBe("MINIMUM_STAY_VIOLATION");
  });
});
