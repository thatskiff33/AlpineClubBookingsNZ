// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
  `addMemberGuest` and the member-guest error branches (MG3 #2308).

  WHY THIS FILE EXISTS. The correctness review found that the wizard half of MG3
  had NO test of any kind: `addMemberGuest` appeared only as a `vi.fn()` prop, no
  source-scanning contract covered `use-booking-wizard.ts`, and the e2e spec is
  API-only. Two mutations survived — deleting `setUseCredit(false)`, and deleting
  BOTH add guards — and, worse, the entire `MEMBER_GUEST_NOT_ADDABLE` branch was
  unasserted, which is how a silent failure on the review step shipped.

  The invalidation test below deliberately asserts `addMemberGuest` AGAINST
  `addFamilyMemberAsGuest` rather than against a hard-coded list of setters. That
  is plan §9.2's own wording and it is the point: a member guest changes the party
  in exactly the ways a family member does, so if the family path ever learns to
  reset a sixth thing, this test fails until the member-guest path learns it too.
*/

// #2562: the wizard reads `?replaceRequest=<id>` so a member can replace an open
// exception request from their own request list. Stubbed as an empty query here —
// these cases are not about that path.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
  useClubIdentity: () => ({ lodgeCapacity: 3 }),
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-1", name: "Alpine Lodge" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";
import { MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE } from "@/lib/member-guest-refusal";

const SELF = {
  id: "member-1",
  firstName: "Jo",
  lastName: "Member",
  ageTier: "ADULT",
  relationship: "self",
  canLogin: true,
  canBeBooked: true,
  missingFields: [],
};

const SIBLING = {
  id: "member-2",
  firstName: "Mia",
  lastName: "Member",
  ageTier: "CHILD",
  relationship: "child",
  canLogin: false,
  canBeBooked: true,
  missingFields: [],
};

const STRANGER = {
  memberId: "member-9",
  firstName: "Sam",
  lastName: "Whittaker",
  ageTier: "ADULT" as const,
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

type QuoteAnswer = () => Response;

function stubFetch(options: {
  quote?: QuoteAnswer;
  create?: QuoteAnswer;
  memberGuestConfig?: Record<string, unknown>;
  familyOk?: boolean;
}) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/lodges")) {
      return jsonResponse({
        lodges: [{ id: "lodge-1", name: "Alpine Lodge", active: true }],
      });
    }
    // ANSWERED, since #2930. This stub used to have no arm for it, so every
    // mount in this file fell through to the catch-all refusal — and the party
    // ceiling then came from the club-identity seed, which is some OTHER lodge's
    // bed count. A refusal now means the denominator is unknown for the lodge on
    // screen and the client imposes no ceiling at all (settled contract point 3:
    // party-size capacity is advisory, and the server refuses). So the tests
    // below assert a ceiling that the selected lodge actually resolved.
    if (u.includes("/api/availability/check")) {
      return jsonResponse({
        available: true,
        nightDetails: [],
        lodgeCapacity: 3,
      });
    }
    if (u.includes("/api/members/family")) {
      return options.familyOk === false
        ? jsonResponse({}, false, 500)
        : jsonResponse({ familyMembers: [SELF, SIBLING] });
    }
    if (u.includes("/api/members/guest-candidates")) {
      return jsonResponse(
        options.memberGuestConfig ?? {
          enabled: true,
          openSearchEnabled: false,
          approvalRequired: true,
          pendingHoldExpiryDays: 7,
        },
      );
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
    if (u.includes("/api/bookings/rooms"))
      return jsonResponse({ enabled: false, rooms: [] });
    if (u.includes("/api/bookings/quote")) {
      return options.quote
        ? options.quote()
        : jsonResponse({
            totalPriceCents: 1000,
            guests: [],
            nights: 1,
            groupDiscountApplied: false,
          });
    }
    if (u.endsWith("/api/bookings")) {
      return options.create ? options.create() : jsonResponse({ booking: { id: "b1" } });
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function mountedWizard(options: Parameters<typeof stubFetch>[0] = {}) {
  stubFetch(options);
  const { result } = renderHook(() => useBookingWizard());
  await waitFor(() => expect(result.current.guests).toHaveLength(1));
  await waitFor(() => expect(result.current.memberGuestConfig.enabled).toBe(true));
  // `renderHook` does not mount LodgeSelect, whose normalising effect chooses
  // the sole lodge in production. Drive that authoritative choice explicitly
  // before exercising later booking steps.
  act(() => result.current.handleLodgeChange("lodge-1"));
  // AWAITED, and the step asserted: `handleDateSelect` only reaches
  // `setStep("guests")` after two fetches, and the refusal branch under test
  // consults the current step to decide where the message renders.
  await act(async () => {
    await result.current.handleDateSelect("2026-06-11", "2026-06-12");
  });
  await waitFor(() => expect(result.current.step).toBe("guests"));
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("addMemberGuest invalidates exactly what the family path invalidates", () => {
  it("resets the promo, the quote, the credit election and the conflicts — asserted against the family path, not a list", async () => {
    const result = await mountedWizard();

    // Put the wizard into the state both paths must clear: a real priced quote,
    // a promo applied, and credit elected.
    async function dirty() {
      act(() => {
        result.current.handleGuestsChange([
          {
            firstName: "Jo",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: SELF.id,
          },
        ] as never);
      });
      await act(async () => {
        await result.current.handleGuestsDone();
      });
      expect(result.current.priceQuote).not.toBeNull();
      act(() => {
        result.current.setStep("guests");
        result.current.setAppliedPromo({
          code: "SAVE10",
          discountCents: 100,
        } as never);
        result.current.setUseCredit(true);
      });
    }

    const snapshot = () => ({
      appliedPromo: result.current.appliedPromo,
      priceQuote: result.current.priceQuote,
      useCredit: result.current.useCredit,
      memberNightConflicts: result.current.memberNightConflicts,
    });

    await dirty();
    const beforeFamily = snapshot();
    act(() => {
      result.current.addFamilyMemberAsGuest(SIBLING as never);
    });
    const afterFamily = snapshot();
    // The starting state really was dirty, so "both cleared it" is not vacuous.
    expect(beforeFamily).not.toEqual(afterFamily);

    await dirty();
    act(() => {
      result.current.addMemberGuest(STRANGER);
    });

    expect(snapshot()).toEqual(afterFamily);
    expect(result.current.guests.at(-1)).toMatchObject({
      memberId: STRANGER.memberId,
      isMember: true,
      firstName: "Sam",
    });
  });
});

describe("addMemberGuest keeps the family path's two guards", () => {
  it("refuses to add the same member twice", async () => {
    const result = await mountedWizard();
    act(() => {
      result.current.handleGuestsChange([] as never);
    });
    act(() => {
      result.current.addMemberGuest(STRANGER);
    });
    expect(result.current.guests).toHaveLength(1);
    act(() => {
      result.current.addMemberGuest(STRANGER);
    });
    expect(result.current.guests).toHaveLength(1);
  });

  it("refuses to exceed the lodge capacity", async () => {
    const result = await mountedWizard();
    act(() => {
      result.current.handleGuestsChange([
        { firstName: "A", lastName: "One", ageTier: "ADULT", isMember: false },
        { firstName: "B", lastName: "Two", ageTier: "ADULT", isMember: false },
        { firstName: "C", lastName: "Three", ageTier: "ADULT", isMember: false },
      ] as never);
    });
    // Capacity is 3, as `/api/availability/check` resolved it for lodge-1 —
    // not as the club-identity fallback guessed it (#2930).
    act(() => {
      result.current.addMemberGuest(STRANGER);
    });
    expect(result.current.guests).toHaveLength(3);
  });
});

describe("the consent preview", () => {
  it("predicts PENDING for somebody outside the booker's family", async () => {
    const result = await mountedWizard();
    act(() => {
      result.current.handleGuestsChange([] as never);
    });
    act(() => {
      result.current.addMemberGuest(STRANGER);
    });
    expect(result.current.guests[0]).toMatchObject({
      memberGuestConsentPreview: "PENDING",
    });
  });

  it("predicts NOTHING for the booker's own family member found by email", async () => {
    const result = await mountedWizard();
    act(() => {
      result.current.handleGuestsChange([] as never);
    });
    act(() => {
      result.current.addMemberGuest({
        memberId: SIBLING.id,
        firstName: SIBLING.firstName,
        lastName: SIBLING.lastName,
        ageTier: "CHILD",
      });
    });
    expect(
      result.current.guests[0].memberGuestConsentPreview,
    ).toBeUndefined();
  });

  it("predicts NOTHING when the family list could not be loaded at all", async () => {
    // The guard the correctness review asked for: a failed `/api/members/family`
    // leaves an empty list, which would otherwise make the booker's own child
    // look beyond-family and promise an email that is never sent.
    stubFetch({ familyOk: false });
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.memberGuestConfig.enabled).toBe(true));
    act(() => {
      result.current.addMemberGuest({
        memberId: SIBLING.id,
        firstName: SIBLING.firstName,
        lastName: SIBLING.lastName,
        ageTier: "CHILD",
      });
    });
    expect(
      result.current.guests.at(-1)?.memberGuestConsentPreview,
    ).toBeUndefined();
  });
});

describe("D-8's neutral refusal always renders somewhere (HIGH-1)", () => {
  const REFUSAL = {
    code: "MEMBER_GUEST_NOT_ADDABLE",
    error: MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  };

  it("shows it in the find panel, and NOT in the page banner, on the guests step", async () => {
    const result = await mountedWizard({
      quote: () => jsonResponse(REFUSAL, false, 403),
    });
    await act(async () => {
      await result.current.handleGuestsDone();
    });

    expect(result.current.memberGuestAddError).toBe(
      MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
    );
    // The panel renders it beside the person, so the banner would say the same
    // sentence twice.
    expect(result.current.error).toBe("");
  });

  it("shows it in the page banner from the review step, where the panel is not mounted", async () => {
    // The reachable case, and not a race: /api/bookings/quote never runs the
    // unpaid-subscription check, so a member guest with an unpaid subscription
    // quotes cleanly and is refused only at Confirm — from the review step,
    // where `GuestsStep` (the only renderer of memberGuestAddError) is unmounted.
    const result = await mountedWizard({
      create: () => jsonResponse(REFUSAL, false, 403),
    });
    await act(async () => {
      await result.current.handleGuestsDone();
    });
    await waitFor(() => expect(result.current.step).toBe("review"));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.error).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    // Still set, so stepping back to the guests step shows it in context too.
    expect(result.current.memberGuestAddError).toBe(
      MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
    );
  });
});

describe("the module-off refusal is not shown to a member in the server's words (MEDIUM-4)", () => {
  it("replaces 'Invalid guest member reference' with copy a person can act on", async () => {
    const result = await mountedWizard({
      quote: () =>
        jsonResponse(
          { code: "GUEST_MEMBER_NOT_ALLOWED", error: "Invalid guest member reference" },
          false,
          403,
        ),
    });
    await act(async () => {
      await result.current.handleGuestsDone();
    });

    expect(result.current.error).not.toContain("Invalid guest member reference");
    expect(result.current.error).toContain("can't be added any more");
    expect(result.current.memberGuestAddError).toBeNull();
  });
});
