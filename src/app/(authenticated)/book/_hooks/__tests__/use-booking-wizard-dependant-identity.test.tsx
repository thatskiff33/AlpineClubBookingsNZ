// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestData } from "@/components/guest-form";
import { DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE } from "@/lib/booking-dependant-identity";

/*
  #2721 — the wizard must stop an own recorded dependant BEFORE the guest split
  (`INV-GUEST-019`), not let the member fill in the rest of the wizard and meet
  the server's refusal on the review step.

  "Before the split" is what these cases assert mechanically: the step does not
  advance, and `/api/bookings/quote` — the first request that prices the party as
  member nights plus a deferred non-member guest portion — is never sent.
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

const SELF = {
  id: "member-1",
  firstName: "Jo",
  lastName: "Member",
  ageTier: "ADULT",
  relationship: "self" as const,
  canLogin: true,
  canBeBooked: true,
  missingFields: [],
};

const SAM = {
  id: "dep-sam",
  firstName: "Sam",
  lastName: "Smith",
  ageTier: "CHILD",
  relationship: "dependent" as const,
  canLogin: false,
  canBeBooked: true,
  missingFields: [],
};

const OWN_DEPENDANTS = [
  { id: "dep-sam", firstName: "Sam", lastName: "Smith" },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function stubFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/members/family")) {
      return jsonResponse({
        familyMembers: [SELF, SAM],
        ownDependants: OWN_DEPENDANTS,
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
    if (u.includes("/api/bookings/rooms"))
      return jsonResponse({ enabled: false, rooms: [] });
    if (u.includes("/api/bookings/quote")) {
      return jsonResponse({ guests: [], totalPriceCents: 1000 });
    }
    if (u.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (u.includes("/api/work-parties/active")) return jsonResponse({ events: [] });
    if (u.endsWith("/api/bookings") && init?.method === "POST") {
      return jsonResponse({ id: "b-1", status: "PAID", amountCents: 1000 });
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Dates relative to the frozen clock (2026-07-01), never the real calendar. */
const CHECK_IN = "2026-08-01";
const CHECK_OUT = "2026-08-03";

const SAM_AS_FREE_TEXT: GuestData = {
  firstName: "Sam",
  lastName: "Smith",
  ageTier: "CHILD",
  isMember: false,
};

async function seatedWizard() {
  const fetchMock = stubFetch();
  const { result } = renderHook(() => useBookingWizard());
  // The booker is seeded as a member row by #1680; wait for it so the party has
  // a real member on it, as a family booking would.
  await waitFor(() => expect(result.current.guests).toHaveLength(1));
  act(() => result.current.handleLodgeChange("lodge-1"));
  await act(async () => {
    await result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
  });
  return { result, fetchMock };
}

function quoteCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter((call) =>
    String(call[0]).includes("/api/bookings/quote"),
  );
}

function lastCreateBody(fetchMock: ReturnType<typeof stubFetch>) {
  const call = [...fetchMock.mock.calls]
    .reverse()
    .find(
      (entry) =>
        String(entry[0]).endsWith("/api/bookings") &&
        (entry[1] as RequestInit | undefined)?.method === "POST",
    );
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

describe("booking wizard own-dependant identity (#2721)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("raises the question the moment the name is typed", async () => {
    const { result } = await seatedWizard();
    act(() =>
      result.current.handleGuestsChange([
        ...result.current.guests,
        SAM_AS_FREE_TEXT,
      ]),
    );

    await waitFor(() =>
      expect(result.current.dependantIdentityCollisions).toHaveLength(1),
    );
    expect(
      result.current.dependantIdentityCollisions[0]?.dependants.map((d) => d.id),
    ).toEqual(["dep-sam"]);
  });

  it("REFUSES to leave the guests step, and never prices the split party", async () => {
    const { result, fetchMock } = await seatedWizard();
    act(() =>
      result.current.handleGuestsChange([
        ...result.current.guests,
        SAM_AS_FREE_TEXT,
      ]),
    );
    await act(async () => {
      await result.current.handleGuestsDone();
    });

    expect(result.current.step).toBe("guests");
    expect(result.current.error).toBe(DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE);
    expect(quoteCalls(fetchMock)).toHaveLength(0);
  });

  it("moves the row onto the member path when the booker says it is their dependant", async () => {
    const { result } = await seatedWizard();
    act(() =>
      result.current.handleGuestsChange([
        ...result.current.guests,
        SAM_AS_FREE_TEXT,
      ]),
    );
    await waitFor(() =>
      expect(result.current.dependantIdentityCollisions).toHaveLength(1),
    );

    act(() => result.current.bookCollidingGuestAsDependant("sam smith", SAM));

    await waitFor(() =>
      expect(result.current.dependantIdentityCollisions).toHaveLength(0),
    );
    const sam = result.current.guests.find((g) => g.memberId === "dep-sam");
    expect(sam).toMatchObject({
      memberId: "dep-sam",
      isMember: true,
      ageTier: "CHILD",
    });
  });

  it("converts the row that still CARRIES the name, not the row that was at a position", async () => {
    /*
      The positional hazard, exercised. The colliding row is added second; then
      the party is edited so that the row which used to sit at that index is a
      different person entirely. A conversion that remembered "index 1" would put
      Sam's member link on Alex's row — the exact defect a neighbouring surface
      has already produced.
    */
    const { result } = await seatedWizard();
    const alex: GuestData = {
      firstName: "Alex",
      lastName: "Tui",
      ageTier: "ADULT",
      isMember: false,
    };
    act(() =>
      result.current.handleGuestsChange([
        ...result.current.guests,
        SAM_AS_FREE_TEXT,
        alex,
      ]),
    );
    await waitFor(() =>
      expect(result.current.dependantIdentityCollisions).toHaveLength(1),
    );
    // Sam moves from index 1 to index 0 as the booker removes themselves.
    act(() =>
      result.current.handleGuestsChange([SAM_AS_FREE_TEXT, alex]),
    );

    act(() => result.current.bookCollidingGuestAsDependant("sam smith", SAM));

    expect(result.current.guests).toHaveLength(2);
    expect(result.current.guests[0]).toMatchObject({
      memberId: "dep-sam",
      isMember: true,
    });
    // Alex is untouched, and still a non-member guest.
    expect(result.current.guests[1]).toMatchObject({
      firstName: "Alex",
      lastName: "Tui",
      isMember: false,
    });
    expect(result.current.guests[1]?.memberId).toBeUndefined();
  });

  it("continues, and sends the declaration, when the booker says it is somebody else", async () => {
    const { result, fetchMock } = await seatedWizard();
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
    expect(result.current.step).toBe("review");

    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(lastCreateBody(fetchMock).dependantIdentityDeclarations).toEqual([
      {
        kind: "different_person_same_name",
        dependantMemberId: "dep-sam",
        normalizedName: "sam smith",
      },
    ]);
  });

  it("never POSTs a declaration whose collision the booker has since edited away", async () => {
    // A stale declaration is refused by the server, so a wizard that kept
    // sending one would turn an ordinary name correction into a dead end.
    const { result, fetchMock } = await seatedWizard();
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

    // The guest turns out to be somebody else entirely.
    act(() =>
      result.current.handleGuestsChange([
        ...result.current.guests.slice(0, -1),
        { ...SAM_AS_FREE_TEXT, lastName: "Ngata" },
      ]),
    );
    await waitFor(() =>
      expect(result.current.declaredDependantMemberIds).toEqual([]),
    );

    await act(async () => {
      await result.current.handleGuestsDone();
    });
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(
      lastCreateBody(fetchMock).dependantIdentityDeclarations,
    ).toBeUndefined();
  });

  it("takes an answer back when the booker changes their mind", async () => {
    const { result } = await seatedWizard();
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
    act(() =>
      result.current.withdrawDependantDeclaration(collision, "dep-sam"),
    );

    await waitFor(() =>
      expect(result.current.declaredDependantMemberIds).toEqual([]),
    );
    await act(async () => {
      await result.current.handleGuestsDone();
    });
    expect(result.current.step).toBe("guests");
  });

  it("asks nothing of a party that names nobody's dependant", async () => {
    const { result, fetchMock } = await seatedWizard();
    act(() =>
      result.current.handleGuestsChange([
        ...result.current.guests,
        { firstName: "Kiri", lastName: "Ngata", ageTier: "ADULT", isMember: false },
      ]),
    );

    await act(async () => {
      await result.current.handleGuestsDone();
    });
    expect(result.current.dependantIdentityCollisions).toEqual([]);
    expect(result.current.step).toBe("review");
    expect(quoteCalls(fetchMock)).toHaveLength(1);
  });
});
