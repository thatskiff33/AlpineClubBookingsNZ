/**
 * The kiosk day list's dietary/allergy payload, tier by tier (#3029,
 * `INV-PRIV-022`, `INV-PRIV-015`/`016`).
 *
 * The route is driven end to end with a mocked database. The authorised tiers
 * (`admin`, `hut-leader` — including a hut leader's PIN session on the lodge
 * device) receive each present guest's value; every other tier, and an admin's
 * read-only preview of a kiosk account, receives guests with NO
 * `dietaryRequirements` key at all — absent from the serialised payload, not
 * hidden in JSX — and the route never even asks the database for the column.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dateOnlyFromParts } from "@/lib/date-only";

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  settingsFindUnique: vi.fn(),
  checkLodgeAuth: vi.fn(),
  assignmentCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany },
    bookingGuest: { findMany: mocks.bookingGuestFindMany },
    memberFieldsSettings: { findUnique: mocks.settingsFindUnique },
    hutLeaderAssignment: { count: mocks.assignmentCount },
  },
}));
vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: mocks.checkLodgeAuth,
  getLodgeAuthActorMemberId: (auth: { pinSession?: { memberId: string } | null }) =>
    auth.pinSession?.memberId ?? "actor-1",
  resolveKioskLodgeId: vi.fn(async () => "lodge-1"),
  kioskLodgeAuthErrorResponse: vi.fn(() => null),
}));
vi.mock("@/lib/kiosk-group-trip", () => ({
  attachKioskGroupTrip: vi.fn(async (cards: unknown[]) => cards),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { routeParams } from "@/lib/__tests__/helpers/requests";

const VALUE = "Tree-nut allergy";
const day = (d: number) => dateOnlyFromParts(2026, 7, d);

function oneBooking() {
  return [
    {
      id: "booking-1",
      checkIn: day(10),
      checkOut: day(12),
      expectedArrivalTime: null,
      requiresAdminReview: false,
      adminReviewStatus: null,
      memberId: "member-1",
      member: { firstName: "Aroha", lastName: "Owner" },
      organisation: null,
      guests: [
        {
          id: "guest-1",
          firstName: "Aroha",
          lastName: "Owner",
          ageTier: "ADULT",
          isMember: true,
          arrivedAt: null,
          departedAt: null,
          member: null,
          stayStart: day(10),
          stayEnd: day(12),
          nights: [{ stayDate: day(10) }, { stayDate: day(11) }],
        },
      ],
    },
  ];
}

async function guestsFor(auth: Record<string, unknown>) {
  mocks.checkLodgeAuth.mockResolvedValue({ error: null, status: null, ...auth });
  const { GET } = await import("@/app/api/lodge/guests/[date]/route");
  const res = await GET(
    new Request("http://localhost/api/lodge/guests/2026-08-10") as never,
    routeParams({ date: "2026-08-10" }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.bookings.flatMap((b: { guests: unknown[] }) => b.guests) as Array<
    Record<string, unknown>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFindMany.mockResolvedValue(oneBooking());
  mocks.bookingGuestFindMany.mockResolvedValue([
    { id: "guest-1", dietaryRequirements: VALUE },
  ]);
  mocks.settingsFindUnique.mockResolvedValue({ showDietaryRequirements: true });
  mocks.assignmentCount.mockResolvedValue(1);
});

describe("kiosk day list dietary payload (INV-PRIV-022)", () => {
  it("the admin tier and a hut leader (assignment or PIN session) receive the value", async () => {
    for (const auth of [
      { tier: "admin", session: { user: { id: "admin-1" } } },
      { tier: "hut-leader", session: { user: { id: "leader-1" } } },
      {
        tier: "hut-leader",
        session: { user: { id: "kiosk-account" } },
        pinSession: { memberId: "leader-1" },
      },
    ]) {
      const [guest] = await guestsFor(auth);
      expect(guest?.dietaryRequirements, String(auth.tier)).toBe(VALUE);
    }
  });

  it("the lodge wall, a staying guest, none and an admin preview get NO key and trigger no read", async () => {
    for (const auth of [
      { tier: "lodge", session: { user: { id: "kiosk-account" } } },
      { tier: "staying-guest", session: { user: { id: "member-2" } } },
      { tier: "none", session: { user: { id: "member-3" } } },
      {
        tier: "admin",
        session: { user: { id: "admin-1" } },
        preview: { actorMemberId: "admin-1", targetMemberId: "kiosk", targetEmail: "k@x" },
      },
    ]) {
      const guests = await guestsFor(auth);
      expect(guests).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(guests[0], "dietaryRequirements"), String(auth.tier)).toBe(
        false,
      );
    }
    expect(mocks.bookingGuestFindMany).not.toHaveBeenCalled();
  });

  it("an own-account hut leader with no assignment at THIS lodge on THIS day gets no key (#3029 S1)", async () => {
    mocks.assignmentCount.mockResolvedValue(0);
    const [guest] = await guestsFor({ tier: "hut-leader", session: { user: { id: "leader-1" } } });
    expect(Object.prototype.hasOwnProperty.call(guest, "dietaryRequirements")).toBe(false);
    expect(mocks.assignmentCount).toHaveBeenCalledWith({
      where: expect.objectContaining({ memberId: "actor-1", lodgeId: "lodge-1" }),
    });
    expect(mocks.bookingGuestFindMany).not.toHaveBeenCalled();
  });

  it("with the field OFF even a hut leader gets no key", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ showDietaryRequirements: false });
    const [guest] = await guestsFor({ tier: "hut-leader", session: { user: { id: "leader-1" } } });
    expect(Object.prototype.hasOwnProperty.call(guest, "dietaryRequirements")).toBe(false);
    expect(mocks.bookingGuestFindMany).not.toHaveBeenCalled();
  });

  it("asks only for that day's present guests", async () => {
    await guestsFor({ tier: "hut-leader", session: { user: { id: "leader-1" } } });
    expect(mocks.bookingGuestFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["guest-1"] } },
      select: { id: true, dietaryRequirements: true },
    });
  });
});
