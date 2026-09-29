// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ONBOARDING_CONFIRMED_EVENT } from "@/lib/member-onboarding-events";
import type { GuestData } from "@/components/guest-form";

// The wizard hook seeds the signed-in booker (relationship === "self") as a
// guest by default (#1680). These tests drive the seed-once / removal-guard
// logic directly against the hook so the party contents are assertable.

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
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

type FamilyMemberPayload = {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  relationship: "self" | "partner" | "dependent";
  canLogin?: boolean;
  canBeBooked?: boolean;
  missingFields?: string[];
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

const bookableSelf: FamilyMemberPayload = {
  id: "member-1",
  firstName: "Jo",
  lastName: "Member",
  ageTier: "ADULT",
  relationship: "self",
  canLogin: true,
  canBeBooked: true,
  missingFields: [],
};

const familyUrl = (u: unknown) => String(u).includes("/api/members/family");

// familyHandler receives the 1-based call count and returns a Response (or a
// pending promise of one, to model a slow/deferred family load).
function stubFetch(
  familyHandler: (callCount: number) => Response | Promise<Response>,
) {
  let familyCalls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/members/family")) {
      familyCalls += 1;
      return familyHandler(familyCalls);
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
    if (u.includes("/api/booking-messages")) {
      return jsonResponse({ messages: {} });
    }
    if (u.includes("/api/bookings/rooms")) {
      return jsonResponse({ enabled: false, rooms: [] });
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("booking wizard pre-selects the booker (#1680)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("seeds a bookable self exactly once as a linked member guest", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ familyMembers: [bookableSelf] }),
    );
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.guests).toHaveLength(1));
    expect(result.current.guests[0]).toMatchObject({
      memberId: "member-1",
      isMember: true,
      firstName: "Jo",
      lastName: "Member",
      ageTier: "ADULT",
    });

    // A family refetch (e.g. onboarding confirmed) re-runs the load path; the
    // seed-once guard must not duplicate self.
    act(() => {
      window.dispatchEvent(new Event(MEMBER_ONBOARDING_CONFIRMED_EVENT));
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => familyUrl(u))).toHaveLength(2),
    );
    expect(result.current.guests).toHaveLength(1);
  });

  it("does not seed a blocked self, then seeds once it flips bookable", async () => {
    stubFetch((n) =>
      jsonResponse({
        familyMembers: [
          n === 1 ? { ...bookableSelf, canBeBooked: false } : bookableSelf,
        ],
      }),
    );
    const { result } = renderHook(() => useBookingWizard());

    // Wait until the BLOCKED self has actually committed to state, so the seed
    // effect has already run against it — only then is an empty party
    // meaningful (a bare guests assertion at dispatch time passes trivially
    // because the family response has not landed yet).
    await waitFor(() =>
      expect(
        result.current.familyMembers.find((m) => m.id === "member-1")?.canBeBooked,
      ).toBe(false),
    );
    expect(result.current.guests).toHaveLength(0);

    // The onboarding-confirmed refetch flips self bookable with the party still
    // empty and no removal recorded, so seeding then is correct and desired.
    act(() => {
      window.dispatchEvent(new Event(MEMBER_ONBOARDING_CONFIRMED_EVENT));
    });

    // Seeding must happen only after the SECOND (bookable) load has committed.
    await waitFor(() =>
      expect(
        result.current.familyMembers.find((m) => m.id === "member-1")?.canBeBooked,
      ).toBe(true),
    );
    await waitFor(() => expect(result.current.guests).toHaveLength(1));
    expect(result.current.guests[0].memberId).toBe("member-1");
  });

  it("does not re-add self after an explicit removal", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ familyMembers: [bookableSelf] }),
    );
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() => expect(result.current.guests).toHaveLength(1));

    // The member X's themselves out of the party.
    act(() => {
      result.current.handleGuestsChange([]);
    });
    expect(result.current.guests).toHaveLength(0);

    // A later family refetch (onboarding confirmed) must not re-seed the booker.
    act(() => {
      window.dispatchEvent(new Event(MEMBER_ONBOARDING_CONFIRMED_EVENT));
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => familyUrl(u))).toHaveLength(2),
    );
    expect(result.current.guests).toHaveLength(0);
  });

  it("leaves an existing party untouched and never late-seeds after it is emptied", async () => {
    let resolveFamily: (value: Response) => void = () => {};
    const familyPromise = new Promise<Response>((resolve) => {
      resolveFamily = resolve;
    });
    // Hold the first family load open so a party can be present before it lands.
    stubFetch((n) =>
      n === 1 ? familyPromise : jsonResponse({ familyMembers: [bookableSelf] }),
    );

    const existingGuest: GuestData = {
      firstName: "Prior",
      lastName: "Draft",
      ageTier: "ADULT",
      isMember: false,
    };

    const { result } = renderHook(() => useBookingWizard());

    // Populate the party before the (still-pending) family load resolves.
    act(() => {
      result.current.handleGuestsChange([existingGuest]);
    });
    expect(result.current.guests).toHaveLength(1);

    // Family data arrives with a bookable self, but the party is non-empty, so
    // self must not be seeded on top of the existing guest — and the one-shot
    // seeding opportunity is consumed on this first arrival.
    await act(async () => {
      resolveFamily(jsonResponse({ familyMembers: [bookableSelf] }));
      await familyPromise;
    });
    await waitFor(() => expect(result.current.familyMembers).toHaveLength(1));
    expect(result.current.guests).toEqual([existingGuest]);

    // The wizard was not fresh when family loaded, so emptying the party
    // mid-session must NOT inject self (the opportunity was already spent).
    act(() => {
      result.current.handleGuestsChange([]);
    });
    expect(result.current.guests).toHaveLength(0);
  });

  it("discards a stale family response that resolves out of order", async () => {
    // Mount load (self blocked) is held open; the onboarding refetch (self
    // bookable) resolves first, then the stale mount load resolves last.
    let resolveMount: () => void = () => {};
    const mountPromise = new Promise<Response>((resolve) => {
      resolveMount = () =>
        resolve(
          jsonResponse({
            familyMembers: [{ ...bookableSelf, canBeBooked: false }],
          }),
        );
    });
    let resolveRefetch: () => void = () => {};
    const refetchPromise = new Promise<Response>((resolve) => {
      resolveRefetch = () =>
        resolve(jsonResponse({ familyMembers: [bookableSelf] }));
    });
    stubFetch((n) => (n === 1 ? mountPromise : refetchPromise));

    const { result } = renderHook(() => useBookingWizard());

    // Kick off the refetch (2nd family fetch) before the mount fetch resolves.
    act(() => {
      window.dispatchEvent(new Event(MEMBER_ONBOARDING_CONFIRMED_EVENT));
    });

    // The newer (bookable) response commits first and seeds self.
    await act(async () => {
      resolveRefetch();
      await refetchPromise;
    });
    await waitFor(() => expect(result.current.guests).toHaveLength(1));

    // The stale mount response (blocked) resolves last and must be discarded —
    // the list keeps the bookable self, so the ✓ button and the amber blocked
    // warning can never render together.
    await act(async () => {
      resolveMount();
      await mountPromise;
    });
    expect(
      result.current.familyMembers.find((m) => m.id === "member-1")?.canBeBooked,
    ).toBe(true);
    expect(result.current.guests).toHaveLength(1);
  });
});
