// @vitest-environment jsdom

// #2664, create-side sibling. The requested-room EDITOR was fixed by pointing it
// at a booking-scoped read; the booking WIZARD is the other surface that offers a
// "Preferred room (optional)" choice, and it kept the shape the issue described.
//
// `/api/bookings/rooms` has two modes. With `lodgeId` it scopes to that lodge;
// with no `lodgeId` it lists every ACTIVE ROOM the caller's booking restrictions
// do not exclude (the `else` branch of the scoping block in
// `src/app/api/bookings/rooms/route.ts`). When #2664 was filed that branch did
// not consult the lodge's own `active` flag either, so an unrestricted member
// got rooms from every lodge, archived ones included; #2727 has since added the
// `Lodge.active` filter there and `INV-INT-016` pins it. That does not touch
// what this file covers — the mode is still cross-lodge, and a wizard booking
// ONE lodge must not offer another's rooms. The wizard used to ask that question
// whenever `lodgeId` was still null, which is every mount, because `lodgeId`
// starts null and only becomes concrete once `LodgeSelect` normalises the
// fetched lodge list.
//
// That alone would be a transient blip. What made it a defect is that the effect
// had no cancellation guard, so the LAST response to land won. A reply arriving
// after the reply that superseded it left the wrong lodge's rooms in `roomOptions`
// permanently — nothing refetches until the member switches lodge again — and
// `review-step.tsx:653-679` renders them in the picker. Choosing one produced a
// create that `resolveBookingLodgeId` refuses ("Requested room belongs to a
// different lodge", `booking-create.ts:167-170`), i.e. a control that simply does
// not work, which is the member-facing symptom in #2664.
//
// The four cases below pin the two halves of the fix independently, which matters
// because a first draft of this file pinned only the first half — every case still
// passed with the cancellation guard deleted. Case 1 and case 4 kill the unscoped
// call; case 2 kills the guard by holding a SCOPED reply open across a lodge
// switch, which is the only ordering that can still race once no unscoped call is
// ever made; case 3 pins the switch itself.

import { act, renderHook, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// A two-lodge club by default, which is the only shape in which "the wrong
// lodge's rooms" is expressible. Mutable so case 4 can model the empty list a
// failed or fully-inactive `/api/lodges` produces. `renderHook` does not render
// `LodgeSelect`, so these tests drive `handleLodgeChange` directly — which is
// exactly what that component's normalising effect calls.
let lodgeOptions: Array<{ id: string; name: string }> = [];

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: lodgeOptions, loading: false }),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

// One distinct room per lodge, so which lodge answered is visible in the state
// rather than inferred. `room-cedar` exists ONLY in the unscoped answer below.
const ROOMS_BY_LODGE: Record<string, Array<{ id: string; name: string; bedCount: number }>> = {
  "lodge-a": [{ id: "room-alpine", name: "Alpine", bedCount: 4 }],
  "lodge-b": [{ id: "room-birch", name: "Birch", bedCount: 2 }],
};

// What the UNSCOPED mode answers a member with no booking restrictions: rooms
// from both lodges plus `room-cedar`, which is reachable from nowhere else in this
// file. Any assertion that finds Cedar proves the wizard asked the cross-lodge
// question and kept the answer — a reproduction of the defect rather than a
// restatement of a fixture.
const EVERY_LODGE_ROOMS = {
  enabled: true,
  rooms: [
    ...ROOMS_BY_LODGE["lodge-a"],
    ...ROOMS_BY_LODGE["lodge-b"],
    { id: "room-cedar", name: "Cedar", bedCount: 6 },
  ],
};

type RoomStubOptions = {
  /** Lodge whose SCOPED reply is held open until the test releases it. */
  deferScopedLodgeId?: string;
};

function stubFetch(options: RoomStubOptions = {}) {
  const deferred: Array<() => void> = [];
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [] });
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
    if (u.startsWith("/api/bookings/rooms")) {
      const match = /lodgeId=([^&]+)/.exec(u);
      if (!match) {
        // The cross-lodge mode, kept live so asking it has a visible consequence.
        return jsonResponse(EVERY_LODGE_ROOMS);
      }
      const lodgeId = decodeURIComponent(match[1]);
      const body = { enabled: true, rooms: ROOMS_BY_LODGE[lodgeId] ?? [] };
      if (options.deferScopedLodgeId === lodgeId) {
        return new Promise<Response>((resolve) => {
          deferred.push(() => resolve(jsonResponse(body)));
        });
      }
      return jsonResponse(body);
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, deferred };
}

/**
 * Every room request the wizard made that carried no lodge scope. Matched by
 * "starts with the path and has no `lodgeId=`" rather than by exact string, so a
 * regression that reintroduced the cross-lodge call with some other query
 * parameter on it is still caught.
 */
function unscopedRoomCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/bookings/rooms") && !url.includes("lodgeId="));
}

function scopedRoomCalls(fetchMock: ReturnType<typeof vi.fn>, lodgeId: string): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith(`/api/bookings/rooms?lodgeId=${lodgeId}`));
}

function roomIds(options: Array<{ id: string }>): string[] {
  return options.map((room) => room.id);
}

/** Let a released promise chain and the state update it causes settle. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("booking wizard room options are scoped to the lodge being booked (#2664)", () => {
  beforeEach(() => {
    lodgeOptions = [
      { id: "lodge-a", name: "Alpine Lodge" },
      { id: "lodge-b", name: "Cedar Lodge" },
    ];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("never asks the cross-lodge room list, even before a lodge is selected", async () => {
    const { fetchMock } = stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    // The mount window is the whole point: `lodgeId` is null here, and the old
    // code fired the unscoped request immediately. The subscription effect is
    // declared directly after the rooms effect, so once its call is on the mock
    // the rooms call would be too.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes("/api/member/subscription-status"),
        ),
      ).toBe(true),
    );
    expect(result.current.lodgeId).toBeNull();
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
    expect(result.current.roomOptions).toEqual([]);
    expect(result.current.roomRequestEnabled).toBe(false);

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });

    await waitFor(() => expect(result.current.roomOptions).toHaveLength(1));
    expect(roomIds(result.current.roomOptions)).toEqual(["room-alpine"]);
    expect(result.current.roomRequestEnabled).toBe(true);
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
    expect(scopedRoomCalls(fetchMock, "lodge-a")).toHaveLength(1);
  });

  it("a superseded reply cannot put the previous lodge's room back in the picker", async () => {
    // Lodge A's reply is held open. This is the race that survives once no
    // unscoped call is ever made, so it is what actually pins the `cancelled`
    // guard: delete the guard and lodge A's late reply overwrites lodge B's list.
    const { fetchMock, deferred } = stubFetch({ deferScopedLodgeId: "lodge-a" });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await waitFor(() => expect(scopedRoomCalls(fetchMock, "lodge-a")).toHaveLength(1));
    expect(deferred).toHaveLength(1);
    // Still in flight, so nothing has been applied yet.
    expect(result.current.roomOptions).toEqual([]);

    // Switch to lodge B. Its reply is immediate, so it lands FIRST and wins.
    await act(async () => {
      result.current.handleLodgeChange("lodge-b");
    });
    await waitFor(() => expect(roomIds(result.current.roomOptions)).toEqual(["room-birch"]));

    // Now let lodge A's superseded reply land.
    await act(async () => {
      deferred.forEach((release) => release());
    });
    await flush();

    // The member-facing symptom: a room from a lodge this booking is not at.
    expect(roomIds(result.current.roomOptions)).not.toContain("room-alpine");
    expect(roomIds(result.current.roomOptions)).toEqual(["room-birch"]);
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
  });

  it("switching lodge asks for the new lodge and never widens the question", async () => {
    const { fetchMock } = stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await waitFor(() => expect(roomIds(result.current.roomOptions)).toEqual(["room-alpine"]));

    await act(async () => {
      result.current.handleLodgeChange("lodge-b");
    });

    await waitFor(() => expect(roomIds(result.current.roomOptions)).toEqual(["room-birch"]));
    expect(scopedRoomCalls(fetchMock, "lodge-b")).toHaveLength(1);
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
    // Cedar lives only in the unscoped answer, so its absence is the assertion
    // that the widened question was never asked on the way here.
    expect(roomIds(result.current.roomOptions)).not.toContain("room-cedar");
  });

  it("offers nothing at all when the club reports no bookable lodge", async () => {
    // `/api/lodges` filters `active: true`, so an outage, or a club whose only
    // Lodge row is inactive, yields an empty list — and `LodgeSelect` then leaves
    // the selection null (`lodge-select.tsx:44-47` calls nothing when the sole id
    // and the current value are both null). Before this fix the wizard answered
    // that state with the cross-lodge list, which happened to be right for a
    // one-lodge club and wrong for every other. It now offers nothing, which is
    // a deliberate, disclosed behaviour change: the client cannot know which lodge
    // the server will stamp on the booking, so it must not guess.
    lodgeOptions = [];
    const { fetchMock } = stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes("/api/member/subscription-status"),
        ),
      ).toBe(true),
    );
    await flush();

    expect(result.current.lodgeId).toBeNull();
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/bookings/rooms")),
    ).toEqual([]);
    expect(result.current.roomOptions).toEqual([]);
    // The picker's render gate is `roomRequestEnabled && roomOptions.length > 0`
    // (`review-step.tsx:653`), so this is the control being absent rather than
    // present and empty.
    expect(result.current.roomRequestEnabled).toBe(false);
  });
});
