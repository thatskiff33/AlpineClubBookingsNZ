import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { parseDateOnly } from "@/lib/date-only";

// Route-level serialisation test for issue #155: on a whole-lodge-held night
// the response must report occupiedBeds === lodgeCapacity (mirroring
// getMonthAvailability's pin, ADR-001 decision 6), so
// occupiedBeds + availableBeds === lodgeCapacity on every night. checkCapacity
// itself is unit-tested in src/lib/__tests__/capacity.test.ts ("whole-lodge
// exclusive hold — capacity engine"); this file only proves the route passes
// the engine's pinned values through unchanged.
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  isMemberEligibleToBookLodge: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  checkCapacity: vi.fn(),
  getLodgeCapacity: vi.fn(),
  lodgeFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/lodge-access", () => ({
  isMemberEligibleToBookLodge: h.isMemberEligibleToBookLodge,
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacity: h.checkCapacity,
  getLodgeCapacity: h.getLodgeCapacity,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findUnique: h.lodgeFindUnique },
  },
}));

import { GET } from "@/app/api/availability/check/route";

const TEST_LODGE_CAPACITY = 20;

function makeRequest(params: Record<string, string>) {
  const search = new URLSearchParams(params).toString();
  return new NextRequest(`http://localhost/api/availability/check?${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "member-1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.isMemberEligibleToBookLodge.mockResolvedValue(true);
  h.getDefaultLodgeId.mockResolvedValue("lodge-a");
  h.getLodgeCapacity.mockResolvedValue(TEST_LODGE_CAPACITY);
});

describe("GET /api/availability/check — held-night occupiedBeds pinning (issue #155)", () => {
  it("a held-but-not-full night serialises occupiedBeds === lodgeCapacity and availableBeds === 0", async () => {
    // checkCapacity (engine-level, issue #155) already pins occupiedBeds to
    // lodgeCapacity on a held night; this asserts the route passes that
    // pinned value through unchanged rather than re-deriving it.
    h.checkCapacity.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [
        {
          date: parseDateOnly("2026-08-10"),
          occupiedBeds: TEST_LODGE_CAPACITY,
          availableBeds: 0,
          wholeLodgeHeld: true,
        },
      ],
    });

    const res = await GET(
      makeRequest({ checkIn: "2026-08-10", checkOut: "2026-08-11" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nightDetails).toEqual([
      { date: "2026-08-10", occupiedBeds: TEST_LODGE_CAPACITY, availableBeds: 0 },
    ]);
    // #2930: the lodge's own effective capacity is stated rather than left to be
    // reconstructed from a night row that may not exist.
    expect(body.lodgeCapacity).toBe(TEST_LODGE_CAPACITY);
    for (const night of body.nightDetails) {
      expect(night.occupiedBeds + night.availableBeds).toBe(TEST_LODGE_CAPACITY);
    }
  });

  it("held first night: occupiedBeds + availableBeds === lodgeCapacity (fixes admin resolvedCapacity reconstruction, issue #155)", async () => {
    h.checkCapacity.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [
        {
          date: parseDateOnly("2026-08-10"),
          occupiedBeds: TEST_LODGE_CAPACITY,
          availableBeds: 0,
          wholeLodgeHeld: true,
        },
        {
          date: parseDateOnly("2026-08-11"),
          occupiedBeds: TEST_LODGE_CAPACITY,
          availableBeds: 0,
          wholeLodgeHeld: true,
        },
      ],
    });

    const res = await GET(
      makeRequest({ checkIn: "2026-08-10", checkOut: "2026-08-12" }),
    );

    const body = await res.json();
    const [firstNight] = body.nightDetails;
    const resolvedCapacity = firstNight.occupiedBeds + firstNight.availableBeds;
    expect(resolvedCapacity).toBe(TEST_LODGE_CAPACITY);
    // The reconstruction and the stated field must agree (#2930). They are two
    // routes to one number, which is exactly why only one of them is now read
    // by a client (`INV-SSOT-001`).
    expect(body.lodgeCapacity).toBe(resolvedCapacity);
  });

  it("unheld nights: response is unchanged (real occupiedBeds passed through as-is)", async () => {
    h.checkCapacity.mockResolvedValue({
      available: true,
      minAvailable: TEST_LODGE_CAPACITY - 3,
      nightDetails: [
        {
          date: parseDateOnly("2026-08-10"),
          occupiedBeds: 3,
          availableBeds: TEST_LODGE_CAPACITY - 3,
          wholeLodgeHeld: false,
        },
      ],
    });

    const res = await GET(
      makeRequest({ checkIn: "2026-08-10", checkOut: "2026-08-11" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      lodgeCapacity: TEST_LODGE_CAPACITY,
      minAvailable: TEST_LODGE_CAPACITY - 3,
      nightDetails: [
        { date: "2026-08-10", occupiedBeds: 3, availableBeds: TEST_LODGE_CAPACITY - 3 },
      ],
    });
  });

  /**
   * #2930 — hold privacy IN THE PAYLOAD SHAPE, not only in the numbers.
   *
   * The settled owner contract says a whole-lodge hold must be
   * indistinguishable from ordinary fullness in member wording, in the night
   * list AND in the payload. The first two are copy; this is the one a member
   * can inspect directly with the network tab, and a privacy property that
   * holds in the copy while leaking in the JSON has not held at all.
   */
  describe("hold privacy: a held night and a genuinely full night serialise identically", () => {
    const heldNight = {
      date: parseDateOnly("2026-08-10"),
      occupiedBeds: TEST_LODGE_CAPACITY,
      availableBeds: 0,
      // The engine knows. The member must not find out.
      wholeLodgeHeld: true,
    };
    const genuinelyFullNight = {
      date: parseDateOnly("2026-08-10"),
      occupiedBeds: TEST_LODGE_CAPACITY,
      availableBeds: 0,
      wholeLodgeHeld: false,
    };

    async function bodyFor(night: Record<string, unknown>) {
      h.checkCapacity.mockResolvedValue({
        available: false,
        minAvailable: 0,
        nightDetails: [night],
      });
      const res = await GET(
        makeRequest({ checkIn: "2026-08-10", checkOut: "2026-08-11" }),
      );
      expect(res.status).toBe(200);
      return res.json();
    }

    it("produces byte-identical JSON for the two cases", async () => {
      const held = await bodyFor(heldNight);
      const full = await bodyFor(genuinelyFullNight);
      // Not `toEqual` on the parsed objects alone: serialising both and
      // comparing the STRINGS also catches a key that is present-but-undefined
      // on one side and absent on the other, which `toEqual` forgives and a
      // reader of the raw response would not.
      expect(JSON.stringify(held)).toBe(JSON.stringify(full));
    });

    it("never projects the hold flag under any name", async () => {
      const held = await bodyFor(heldNight);
      const serialised = JSON.stringify(held);
      expect(serialised).not.toContain("wholeLodgeHeld");
      expect(serialised.toLowerCase()).not.toContain("held");
      expect(serialised.toLowerCase()).not.toContain("hold");
      expect(serialised.toLowerCase()).not.toContain("exclusive");
      for (const night of held.nightDetails) {
        expect(Object.keys(night).sort()).toEqual([
          "availableBeds",
          "date",
          "occupiedBeds",
        ]);
      }
    });
  });
});
