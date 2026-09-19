// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestData } from "@/components/guest-form";
import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  DEPENDANT_IDENTITY_UNANSWERABLE_MESSAGE,
  DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
} from "@/lib/booking-dependant-identity";
import type { FamilyMember } from "@/app/(authenticated)/book/_components/types";

/*
  #2721 review — THE REFUSAL HANDLER, driven against a STALE client list.

  The refusal exists precisely for the case where the wizard's own picture is
  out of date, so every one of these starts with the wizard believing there is
  no collision and the server saying there is. Nothing in the original suite
  drove that path, which is how a comment claiming "the collisions are recomputed
  from `/api/members/family` on that step" survived while the family fetch ran
  once on mount and never again.

  Two reachable dead ends are pinned here: the member sent to a step that renders
  no question, and the mirror case that rebuilds the same refused declaration
  forever. In both the only escapes used to be a full page reload or deleting the
  guest, and the copy suggested neither.
*/

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
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
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

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

const SELF: FamilyMember = {
  id: "member-1",
  firstName: "Jo",
  lastName: "Member",
  ageTier: "ADULT",
  relationship: "self",
  canLogin: true,
  canBeBooked: true,
  missingFields: [],
};

const SAM: FamilyMember = {
  id: "dep-sam",
  firstName: "Sam",
  lastName: "Smith",
  ageTier: "CHILD",
  relationship: "dependent",
  canLogin: false,
  canBeBooked: true,
  missingFields: [],
};

const SAM_AS_FREE_TEXT: GuestData = {
  firstName: "Sam",
  lastName: "Smith",
  ageTier: "CHILD",
  isMember: false,
};

/** Dates relative to the frozen clock (2026-07-01), never the real calendar. */
const CHECK_IN = "2026-08-01";
const CHECK_OUT = "2026-08-03";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

/**
 * The family endpoint and the create endpoint are both mutable here: every case
 * needs the family list to say one thing before the submit and another after it,
 * which is the staleness these tests exist for.
 */
type Scenario = {
  /** What `/api/members/family` answers. `null` = the request fails. */
  family: { familyMembers: FamilyMember[]; ownDependants: unknown } | null;
  /** What `POST /api/bookings` answers. `null` = an ordinary success. */
  createRefusal: { code: string; error: string } | null;
};

function stubFetch(scenario: Scenario) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/members/family")) {
      return scenario.family
        ? jsonResponse(scenario.family)
        : jsonResponse({}, false, 500);
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
      return jsonResponse({ guests: [], totalPriceCents: 1000 });
    }
    if (u.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (u.includes("/api/work-parties/active")) return jsonResponse({ events: [] });
    if (u.endsWith("/api/bookings") && init?.method === "POST") {
      return scenario.createRefusal
        ? jsonResponse(
            scenario.createRefusal,
            false,
            scenario.createRefusal.code ===
              DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE
              ? 400
              : 409,
          )
        : jsonResponse({ id: "b-1", status: "PAID", amountCents: 1000 });
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * A wizard whose family list does NOT yet know about Sam, with Sam typed in as
 * a free-text guest and the party sitting on the review step — exactly the state
 * a tab left open while the dependant was recorded ends up in.
 */
async function wizardBlindToTheDependant(scenario: Scenario) {
  const fetchMock = stubFetch(scenario);
  const { result } = renderHook(() => useBookingWizard());
  await waitFor(() => expect(result.current.guests).toHaveLength(1));
  act(() => result.current.handleLodgeChange("lodge-1"));
  await act(async () => {
    await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
  });
  act(() =>
    result.current.handleGuestsChange([
      ...result.current.guests,
      SAM_AS_FREE_TEXT,
    ]),
  );
  // The client sees no collision, which is the premise of every case here.
  expect(result.current.dependantIdentityCollisions).toEqual([]);
  await act(async () => {
    await result.current.handleGuestsDone();
  });
  expect(result.current.step).toBe("review");
  return { result, fetchMock };
}

function createCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(
    (call) =>
      String(call[0]).endsWith("/api/bookings") &&
      (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

describe("own-dependant refusal against a stale client list (#2721)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("re-reads the family list, so the step it sends the member to can draw the question", async () => {
    const scenario: Scenario = {
      family: { familyMembers: [SELF], ownDependants: [] },
      createRefusal: {
        code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
        error: DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
      },
    };
    const { result } = await wizardBlindToTheDependant(scenario);

    // Sam is recorded as a dependant while this tab sits on the review step.
    scenario.family = {
      familyMembers: [SELF, SAM],
      ownDependants: [{ id: "dep-sam", firstName: "Sam", lastName: "Smith" }],
    };

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.step).toBe("guests");
    // The question the member was just told to answer is now ON the screen.
    await waitFor(() =>
      expect(result.current.dependantIdentityCollisions).toHaveLength(1),
    );
    expect(
      result.current.dependantIdentityCollisions[0]?.dependants.map((d) => d.id),
    ).toEqual(["dep-sam"]);
    expect(result.current.error).toBe(DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE);
  });

  it("and the member can then answer it and get through", async () => {
    const scenario: Scenario = {
      family: { familyMembers: [SELF], ownDependants: [] },
      createRefusal: {
        code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
        error: DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
      },
    };
    const { result } = await wizardBlindToTheDependant(scenario);
    scenario.family = {
      familyMembers: [SELF, SAM],
      ownDependants: [{ id: "dep-sam", firstName: "Sam", lastName: "Smith" }],
    };
    await act(async () => {
      await result.current.handleSubmit();
    });
    await waitFor(() =>
      expect(result.current.dependantIdentityCollisions).toHaveLength(1),
    );

    act(() => result.current.bookCollidingGuestAsDependant("sam smith", SAM));
    await waitFor(() =>
      expect(result.current.dependantIdentityCollisions).toHaveLength(0),
    );
    expect(
      result.current.guests.some((guest) => guest.memberId === "dep-sam"),
    ).toBe(true);
  });

  it("says something the member can act on when the list cannot be re-read", async () => {
    const scenario: Scenario = {
      family: { familyMembers: [SELF], ownDependants: [] },
      createRefusal: {
        code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
        error: DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
      },
    };
    const { result } = await wizardBlindToTheDependant(scenario);
    // One swallowed failure of the family endpoint is all it takes.
    scenario.family = null;

    await act(async () => {
      await result.current.handleSubmit();
    });

    await waitFor(() =>
      expect(result.current.error).toBe(DEPENDANT_IDENTITY_UNANSWERABLE_MESSAGE),
    );
    expect(result.current.dependantIdentityCollisions).toEqual([]);
  });

  it("says the same when the refreshed list still has no question to ask", async () => {
    // A refusal that did not come from this wizard at all — a second device, or
    // a replayed request. Telling this member to answer a question their screen
    // will never render is the dead end.
    const scenario: Scenario = {
      family: { familyMembers: [SELF], ownDependants: [] },
      createRefusal: {
        code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
        error: DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
      },
    };
    const { result } = await wizardBlindToTheDependant(scenario);

    await act(async () => {
      await result.current.handleSubmit();
    });

    await waitFor(() =>
      expect(result.current.error).toBe(DEPENDANT_IDENTITY_UNANSWERABLE_MESSAGE),
    );
  });

  it("clears a refused declaration and re-asks, instead of rebuilding it forever", async () => {
    /*
      The mirror loop. The wizard holds an answer the server has just called
      invalid; keeping it means the next Continue rebuilds the same payload and
      is refused identically. The server does not say WHICH declaration failed,
      so the only terminating answer is to put the question back.
    */
    const scenario: Scenario = {
      family: {
        familyMembers: [SELF, SAM],
        ownDependants: [{ id: "dep-sam", firstName: "Sam", lastName: "Smith" }],
      },
      createRefusal: null,
    };
    const fetchMock = stubFetch(scenario);
    const { result } = renderHook(() => useBookingWizard());
    await waitFor(() => expect(result.current.guests).toHaveLength(1));
    act(() => result.current.handleLodgeChange("lodge-1"));
    await act(async () => {
      await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
    });
    act(() =>
      result.current.handleGuestsChange([
        ...result.current.guests,
        SAM_AS_FREE_TEXT,
      ]),
    );
    await waitFor(() =>
      expect(result.current.dependantIdentityCollisions).toHaveLength(1),
    );
    const collision = result.current.dependantIdentityCollisions[0]!;
    act(() =>
      result.current.declareDependantDifferentPerson(collision, "dep-sam"),
    );
    await waitFor(() =>
      expect(result.current.declaredDependantMemberIds).toEqual(["dep-sam"]),
    );
    await act(async () => {
      await result.current.handleGuestsDone();
    });

    scenario.createRefusal = {
      code: DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
      error: "no longer matches this booking",
    };
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.step).toBe("guests");
    // The answer is gone and the question is back, so Continue has something to
    // refuse on rather than a payload to replay.
    await waitFor(() =>
      expect(result.current.declaredDependantMemberIds).toEqual([]),
    );
    expect(result.current.dependantIdentityCollisions).toHaveLength(1);

    const createsBefore = createCalls(fetchMock).length;
    await act(async () => {
      await result.current.handleGuestsDone();
    });
    expect(result.current.step).toBe("guests");
    expect(result.current.error).toBe(DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE);
    expect(createCalls(fetchMock)).toHaveLength(createsBefore);
  });
});
