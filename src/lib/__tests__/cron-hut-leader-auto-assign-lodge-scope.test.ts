import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auto-assign cron runs per (lodge, night), never club-wide (#2915).
 *
 * Both cases below failed SILENTLY before the fix — no error, just a lodge that
 * never got a leader — which is why they are pinned here rather than left to the
 * broader operational-presence suite.
 */

const { mockPrisma, mockFlags, mockLookahead } = vi.hoisted(() => ({
  mockPrisma: {
    lodge: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    // #3818: the already-covered probe reads the assigned leaders' stays.
    bookingGuest: { findMany: vi.fn() },
    hutLeaderAssignment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    // #2887: the create runs inside a transaction holding the lodge's capacity
    // key, so the double needs the interactive transaction and the advisory
    // lock statement. It hands back the same object, so every assertion below
    // still observes the same `hutLeaderAssignment` mocks.
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  },
  mockFlags: vi.fn(),
  mockLookahead: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("./prisma", () => ({ prisma: mockPrisma }));
// Partial: `admin-modules` (reached through the capacity counter since the
// #3817 one-space rule) reads `normalizeClubModuleSettings` at import time.
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: mockFlags,
}));
vi.mock("./module-settings", () => ({ loadEffectiveModuleFlags: mockFlags }));
vi.mock("@/lib/lodge-settings", () => ({
  loadHutLeaderLookaheadDays: mockLookahead,
}));
vi.mock("./lodge-settings", () => ({
  loadHutLeaderLookaheadDays: mockLookahead,
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { autoAssignHutLeaders } from "@/lib/cron-hut-leader-auto-assign";

/** One PAID booking at `lodgeId` carrying exactly one operationally present adult. */
function bookingWithOneAdult(memberId: string) {
  return {
    guests: [
      {
        memberId,
        stayStart: new Date("2026-07-01"),
        stayEnd: new Date("2026-07-02"),
        member: { id: memberId, active: true },
      },
    ],
  };
}

describe("autoAssignHutLeaders lodge scoping (#2915)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlags.mockResolvedValue({ hutLeaders: true });
    // A single night in the window keeps the assertions about counts unambiguous.
    mockLookahead.mockResolvedValue(0);
    mockPrisma.hutLeaderAssignment.findFirst.mockResolvedValue(null);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "assignment-1" });
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.bookingGuest.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: typeof mockPrisma) => unknown)(mockPrisma)
        : arg,
    );
  });

  it("does not let one lodge's existing assignment silence another lodge", async () => {
    mockPrisma.lodge.findMany.mockResolvedValue([{ id: "lodge-a" }, { id: "lodge-b" }]);
    // Lodge A is already covered; lodge B is not. Modelled the way the database
    // would answer: only a query asking for lodge B misses. An UNSCOPED query
    // still finds lodge A's row — which is precisely the bug, so the mock must
    // return it rather than nothing, or this test passes without the guard.
    // #3818: the probe is the shared presence-aware helper, so lodge A's leader
    // is staying at lodge A that night too.
    const night = new Date("2026-07-01T00:00:00.000Z");
    const morningAfter = new Date("2026-07-02T00:00:00.000Z");
    mockPrisma.hutLeaderAssignment.findMany.mockImplementation(
      async ({ where }: { where: { lodgeId?: string } }) =>
        where.lodgeId === "lodge-b"
          ? []
          : [
              {
                id: "existing-a",
                memberId: "leader-a",
                lodgeId: "lodge-a",
                startDate: night,
                endDate: night,
                source: "MANUAL",
                bedId: null,
              },
            ],
    );
    mockPrisma.bookingGuest.findMany.mockResolvedValue([
      {
        memberId: "leader-a",
        stayStart: night,
        stayEnd: morningAfter,
        nights: [],
        booking: { lodgeId: "lodge-a", checkIn: night, checkOut: morningAfter },
      },
    ]);
    mockPrisma.booking.findMany.mockImplementation(
      async ({ where }: { where: { lodgeId?: string } }) =>
        where.lodgeId === "lodge-b" ? [bookingWithOneAdult("member-b")] : [],
    );

    await autoAssignHutLeaders();

    expect(mockPrisma.hutLeaderAssignment.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.hutLeaderAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: "member-b",
          lodgeId: "lodge-b",
          // #2926: provenance is stamped by the writer that creates the row. A
          // CRON row is an ordinary assignment — it blocks and is blocked like a
          // MANUAL one — but leaving it unstamped would make the column's
          // meaning depend on which writer remembered to fill it in.
          source: "CRON",
        }),
      }),
    );
  });

  it("assigns at BOTH lodges when each has exactly one adult that night", async () => {
    // The pooled-count bug: one adult at each of two lodges summed to two, so
    // the "exactly one adult member" rule rejected both and neither lodge got a
    // leader — the rule cancelling itself out.
    mockPrisma.lodge.findMany.mockResolvedValue([{ id: "lodge-a" }, { id: "lodge-b" }]);
    mockPrisma.booking.findMany.mockImplementation(
      async ({ where }: { where: { lodgeId?: string } }) => [
        bookingWithOneAdult(where.lodgeId === "lodge-a" ? "member-a" : "member-b"),
      ],
    );

    await autoAssignHutLeaders();

    expect(mockPrisma.hutLeaderAssignment.create).toHaveBeenCalledTimes(2);
    const assigned = mockPrisma.hutLeaderAssignment.create.mock.calls.map(
      ([call]) => (call as { data: { memberId: string; lodgeId: string } }).data,
    );
    expect(assigned).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memberId: "member-a", lodgeId: "lodge-a" }),
        expect.objectContaining({ memberId: "member-b", lodgeId: "lodge-b" }),
      ]),
    );
  });

  it("scopes the overlap veto to the lodge being assigned", async () => {
    mockPrisma.lodge.findMany.mockResolvedValue([{ id: "lodge-a" }]);
    mockPrisma.booking.findMany.mockResolvedValue([bookingWithOneAdult("member-a")]);

    await autoAssignHutLeaders();

    expect(mockPrisma.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lodgeId: "lodge-a" }),
      }),
    );
  });

  it("skips archived lodges entirely", async () => {
    mockPrisma.lodge.findMany.mockResolvedValue([{ id: "lodge-a" }]);
    mockPrisma.booking.findMany.mockResolvedValue([bookingWithOneAdult("member-a")]);

    await autoAssignHutLeaders();

    expect(mockPrisma.lodge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } }),
    );
  });
});
