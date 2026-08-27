import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #3123: the seasonal membership-type preview takes the club's day as a value,
 * and a bulk preview reads the club's zone ONCE.
 *
 * `getSeasonalMembershipChangePreview` bounds every "still to come" query it
 * reports on — three booking reads (`checkOut > today`) and the linked-guest read
 * (`stayEnd > today`) — so the day decides which bookings an admin is warned a
 * membership-type change would affect. That day used to default to
 * `getTodayDateOnly()`, the ENVIRONMENT's answer.
 *
 * ## Why a plain `await` in there would have been the wrong fix
 *
 * Every caller of this function is a LOOP: the bulk membership-type preview
 * route walks up to 100 selected members, and the Xero member import walks its
 * matched candidates. This file's own history says what that costs — the sibling
 * `clubCurrentSeasonYear` parameter exists because "a fifty-member preview made
 * fifty of them, and a preview straddling club midnight on a season boundary
 * could judge two members' age tiers in two different seasons" (#2870). Resolving
 * the zone inside the preview would have re-created exactly that, one layer
 * along.
 *
 * So both `now` and `clubCurrentSeasonYear` are REQUIRED parameters, and the
 * preview performs NO `ClubTimeSettings` query on any path. That is the property
 * the first case below pins: not "usually once", but never — which is what makes
 * once-per-bulk structural rather than a convention a future caller can drop.
 *
 * ## What makes the club-day cases discriminating
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — the answer the replaced
 * default gave AND this codebase's own fallback, so it is the one value a wrong
 * fix could still pass under. The PERSISTED zone is `America/Denver`, behind
 * Greenwich. Under the frozen clock (`2026-07-01T00:00:00.000Z`) the club's day
 * is 30 June and the environment's is 1 July.
 *
 * THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THE PRISMA MOCK.
 * `getClubTimeZone` degrades silently to the environment when the delegate is
 * missing, when the query throws, and when the row is absent — so a mock without
 * it would let this file pass for the very reason it exists to rule out.
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
const MEMBER_IDS = ["m1", "m2", "m3"];

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  membershipTypeFindUnique: vi.fn(),
  assignmentFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    member: {
      findMany: (...a: unknown[]) => mocks.memberFindMany(...a),
      findUnique: (...a: unknown[]) => mocks.memberFindUnique(...a),
    },
    membershipType: {
      findUnique: (...a: unknown[]) => mocks.membershipTypeFindUnique(...a),
    },
    seasonalMembershipAssignment: {
      findUnique: (...a: unknown[]) => mocks.assignmentFindUnique(...a),
    },
    booking: { findMany: (...a: unknown[]) => mocks.bookingFindMany(...a) },
    bookingGuest: {
      findMany: (...a: unknown[]) => mocks.bookingGuestFindMany(...a),
    },
    memberSubscription: {
      findMany: (...a: unknown[]) => mocks.subscriptionFindMany(...a),
    },
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { POST } from "@/app/api/admin/members/bulk-membership-type/preview/route";

function dayIn(zone: string) {
  return clubToday(requireClubTimeZone(zone));
}

/** Every distinct `checkOut > X` bound the preview handed Prisma. */
function checkOutBounds(): string[] {
  return Array.from(
    new Set(
      mocks.bookingFindMany.mock.calls.map((call) => {
        const where = (call[0] as { where: { checkOut: { gt: Date } } }).where;
        return where.checkOut.gt.toISOString();
      }),
    ),
  );
}

async function bulkPreview() {
  return POST(
    new NextRequest(
      "http://localhost/api/admin/members/bulk-membership-type/preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: MEMBER_IDS,
          seasonYear: 2026,
          membershipTypeId: "type-associate",
        }),
      },
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "seasonal-preview-club-day-test-secret";
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: PERSISTED_ZONE,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  mocks.memberFindMany.mockResolvedValue(
    MEMBER_IDS.map((id) => ({
      id,
      firstName: "A",
      lastName: id,
      email: `${id}@example.test`,
      archivedAt: null,
    })),
  );
  mocks.memberFindUnique.mockResolvedValue({
    id: "m1",
    ageTier: "ADULT",
    dateOfBirth: null,
    role: "MEMBER",
    canLogin: true,
    accessRoles: [{ role: "USER" }],
  });
  mocks.membershipTypeFindUnique.mockResolvedValue({
    id: "type-associate",
    key: "ASSOCIATE",
    name: "Associate",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    ageTierExemption: null,
    allowedAgeTiers: [{ ageTier: "ADULT" }],
  });
  mocks.assignmentFindUnique.mockResolvedValue(null);
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.bookingGuestFindMany.mockResolvedValue([]);
  mocks.subscriptionFindMany.mockResolvedValue([]);
});

describe("the bulk seasonal preview reads the club's zone once (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's disagree about the day", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(dayIn(PERSISTED_ZONE)).toBe("2026-06-30");
    expect(dayIn(ENVIRONMENT_ZONE)).toBe("2026-07-01");
  });

  it("reads ClubTimeSettings ONCE for a three-member batch, not once per member", async () => {
    const response = await bulkPreview();
    expect(response.status).toBe(200);

    // Three members previewed - proved by the per-member reads, so a batch that
    // silently previewed nobody cannot satisfy this case.
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(MEMBER_IDS.length);
    // ...and exactly ONE settings read for the whole batch. This is the defect
    // the file's own `clubCurrentSeasonYear` docblock records: fifty members once
    // meant fifty uncached reads.
    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledTimes(1);
  });

  it("gives every member in the batch the SAME club day", async () => {
    await bulkPreview();
    // One distinct bound across all three members' booking queries. Two would
    // mean a batch straddling club midnight could report two members under two
    // different days.
    expect(checkOutBounds()).toEqual(["2026-06-30T00:00:00.000Z"]);
  });

  it("bounds on the CLUB's day and not the environment's", async () => {
    await bulkPreview();
    expect(checkOutBounds()).not.toContain("2026-07-01T00:00:00.000Z");
  });

  it("MOVES with the persisted zone, which kills a hard-coded Pacific/Auckland", async () => {
    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Kiritimati",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await bulkPreview();
    expect(checkOutBounds()).toEqual(["2026-07-01T00:00:00.000Z"]);

    vi.clearAllMocks();
    beforeEachReset();
    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Pago_Pago",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await bulkPreview();
    expect(checkOutBounds()).toEqual(["2026-06-30T00:00:00.000Z"]);
  });
});

/** The `beforeEach` fixtures, re-applied after a mid-test `clearAllMocks`. */
function beforeEachReset() {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.memberFindMany.mockResolvedValue(
    MEMBER_IDS.map((id) => ({
      id,
      firstName: "A",
      lastName: id,
      email: `${id}@example.test`,
      archivedAt: null,
    })),
  );
  mocks.memberFindUnique.mockResolvedValue({
    id: "m1",
    ageTier: "ADULT",
    dateOfBirth: null,
    role: "MEMBER",
    canLogin: true,
    accessRoles: [{ role: "USER" }],
  });
  mocks.membershipTypeFindUnique.mockResolvedValue({
    id: "type-associate",
    key: "ASSOCIATE",
    name: "Associate",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    ageTierExemption: null,
    allowedAgeTiers: [{ ageTier: "ADULT" }],
  });
  mocks.assignmentFindUnique.mockResolvedValue(null);
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.bookingGuestFindMany.mockResolvedValue([]);
  mocks.subscriptionFindMany.mockResolvedValue([]);
}
