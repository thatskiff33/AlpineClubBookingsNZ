import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * CT-4 (#2870): the hut-leader assignment window is bounded on club time.
 *
 * This route decides who may read a lodge's operational documents — door codes
 * and emergency access among them — from `endDate >= today`. Two separate things
 * about that bound were wrong, and this file pins both:
 *
 *  - **whose "today"?** The club's, from the persisted `ClubTimeSettings.timeZone`
 *    (INV-CONFIG-002, INV-DATE-019) — not the container's `TZ`, which is what
 *    `getTodayDateOnly()` read. A club in Colorado whose server sits in Auckland
 *    lost a hut leader's access half a day early.
 *  - **on what frame?** `HutLeaderAssignment.endDate` is `@db.Date`, so a Prisma
 *    bound against it must be that calendar day at **UTC midnight**
 *    (INV-DATE-026). Hand the adapter a club-LOCAL midnight and it narrows to
 *    the PREVIOUS day, with nothing to warn you — the assignment that ends today
 *    silently stops matching.
 *
 * Asserting the bound VALUE rather than the route's answer is deliberate: a
 * status-code assertion cannot tell 30 June at UTC midnight from 30 June at
 * Denver midnight, and those two are exactly the pair INV-DATE-026 is about.
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — the answer the replaced
 * helper would have given — and the persisted zone is `America/Denver`, so the
 * two disagree about what day it is under the frozen clock. Nothing here reads
 * the host's `TZ`: the mock supplies `APP_TIME_ZONE`, and a persisted row is
 * always present so `getClubTimeZone`'s environment seed is never reached.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";

const {
  mockRequireActiveSession,
  mockCanRead,
  mockGetSanitized,
  mockGetDefaultLodgeId,
  mockAssignmentFindMany,
  mockClubTimeSettingsFindUnique,
} = vi.hoisted(() => ({
  mockRequireActiveSession: vi.fn(),
  mockCanRead: vi.fn(),
  mockGetSanitized: vi.fn(),
  mockGetDefaultLodgeId: vi.fn(),
  mockAssignmentFindMany: vi.fn(),
  mockClubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: (...args: unknown[]) => mockRequireActiveSession(...args),
}));
vi.mock("@/lib/lodge-instructions", () => ({
  canReadLodgeInstructions: (...args: unknown[]) => mockCanRead(...args),
  getSanitizedLodgeInstructions: (...args: unknown[]) => mockGetSanitized(...args),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...args: unknown[]) => mockGetDefaultLodgeId(...args),
}));
/*
  The `clubTimeSettings` delegate is load-bearing on this mock. `getClubTimeZone`
  degrades silently to the environment when the delegate is missing, when the
  query throws and when the row is absent, so a prisma mock without it would let
  this file pass for the very reason it exists to rule out.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    hutLeaderAssignment: { findMany: (...a: unknown[]) => mockAssignmentFindMany(...a) },
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
  },
}));

import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { APP_TIME_ZONE } from "@/config/operational";
import { GET } from "@/app/api/lodge-instructions/route";

function todayIn(zone: string) {
  return clubToday(requireClubTimeZone(zone));
}

/** The `endDate` bound the route handed Prisma. */
function boundFromLastCall(): Date {
  const call = mockAssignmentFindMany.mock.calls.at(-1)?.[0] as {
    where: { endDate: { gte: Date } };
  };
  return call.where.endDate.gte;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireActiveSession.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } },
  });
  mockCanRead.mockResolvedValue(true);
  mockGetSanitized.mockResolvedValue([]);
  mockAssignmentFindMany.mockResolvedValue([{ lodgeId: "lodge-a" }]);
  mockClubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: PERSISTED_ZONE,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

async function get() {
  return GET(new NextRequest("http://localhost/api/lodge-instructions"));
}

describe("the hut-leader window is bounded on club time (CT-4, #2870)", () => {
  it("PREMISE: the persisted zone and the environment's give different days", () => {
    // The ANSWERS have to differ, not merely the identifiers — two zones with
    // different names and the same offset would make every case below vacuous.
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(todayIn(ENVIRONMENT_ZONE)).toBe("2026-07-01");
    expect(todayIn(PERSISTED_ZONE)).toBe("2026-06-30");
  });

  it("bounds on the PERSISTED club day, at UTC midnight", async () => {
    // Two mutants at once, and the exact millisecond is what separates them:
    //   - `getTodayDateOnly()` (the environment) gives 2026-07-01T00:00:00Z;
    //   - a club-LOCAL midnight bound gives 2026-06-30T06:00:00Z, which Prisma
    //     narrows to 29 June against a `@db.Date` column (INV-DATE-026).
    // Only "the club's day, encoded at UTC midnight" produces this value.
    await get();

    expect(boundFromLastCall().toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it("moves the bound when the persisted zone moves, and nothing else changes", async () => {
    // Kills "ignore the persisted row" in every form — a hard-coded default, a
    // `process.env` read, a value cached across requests. Same request, same
    // clock; only the stored zone differs.
    mockClubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Auckland",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await get();

    expect(boundFromLastCall().toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("really asks the ClubTimeSettings row for the zone", async () => {
    await get();

    expect(mockClubTimeSettingsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });
});
