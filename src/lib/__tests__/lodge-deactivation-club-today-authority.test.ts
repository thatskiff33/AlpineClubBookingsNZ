import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #3123 — a lodge's live dependencies are counted against the CLUB's day.
 *
 * `findLodgeDeactivationRefusal` asks twice: once cheaply before any lock, and
 * again under the config-import singleton and the per-lodge capacity key on the
 * row the transaction re-read. Both asks bound `Booking.checkOut` and
 * `HutLeaderAssignment.endDate` — two `@db.Date` columns — on "today", and both
 * used to take it from `APP_TIME_ZONE`. For a club behind Greenwich that is a
 * day early: a stay or a hut-leader term ending today stops counting as a live
 * dependency, and the lodge is deactivated out from under it.
 *
 * ## Two properties, and the second is the one an authority test usually misses
 *
 * 1. The day is the club's PERSISTED one, not the container's.
 * 2. **Both asks get the SAME day.** The guard exists because the two asks used
 *    to be copies of each other and could drift; resolving "today" twice
 *    reintroduces exactly that, silently, for any request that straddles club
 *    midnight. One read, threaded to both — which is also why the read is in
 *    the route and not in the guard (`INV-LOCK-004`: the locked ask runs inside
 *    the transaction, where a `clubTimeSettings.findUnique` would take a second
 *    pooled connection).
 *
 * ## DISCRIMINATION
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — the answer the replaced
 * helper gave here, and this codebase's own fallback, so it is the one value a
 * fail-soft degradation could still pass under. The persisted club zone is
 * `America/Denver`. Under the frozen clock (`2026-07-01T00:00:00.000Z`) that is
 * 1 July against 30 June.
 *
 * `admin-lodges-route.test.ts` covers the same route and CANNOT see any of
 * this: its prisma mock carries no `clubTimeSettings` delegate, so
 * `getClubTimeZone` degrades to the environment and its F32 assertion passes
 * identically before and after this migration. That is the fail-soft trap
 * `club-time-authority.test.ts` (CT-4) documents, and the reason this is a
 * separate file rather than three more cases there.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  timeline: [] as string[],
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  lodgeFindUnique: vi.fn(),
  lodgeCount: vi.fn(),
  lodgeUpdate: vi.fn(),
  lodgeFindMany: vi.fn(),
  lodgeFindFirst: vi.fn(),
  bookingCount: vi.fn(),
  hutLeaderAssignmentCount: vi.fn(),
  memberLodgeAccessCount: vi.fn(),
  auditLogCreate: vi.fn(),
  executeRaw: vi.fn(),
  acquireConfigImportLock: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: vi.fn(),
}));
vi.mock("@/lib/public-layout-cache", () => ({
  invalidatePublicClubIdentity: vi.fn(),
}));
vi.mock("@/lib/club-identity-settings", () => ({
  primeClubIdentitySync: vi.fn(),
}));
vi.mock("@/lib/config-transfer-lock", () => ({
  acquireConfigImportLock: mocks.acquireConfigImportLock,
}));
vi.mock("@/lib/lodge-capacity-lock", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
}));

/*
  THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL. `getClubTimeZone` is
  fail-soft on a missing delegate, a throwing query and an absent row, and each
  degrades silently to the environment — so a prisma mock without it passes for
  exactly the reason this file exists.
*/
vi.mock("@/lib/prisma", () => {
  const delegates = {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    lodge: {
      findUnique: mocks.lodgeFindUnique,
      findFirst: mocks.lodgeFindFirst,
      findMany: mocks.lodgeFindMany,
      count: mocks.lodgeCount,
      update: mocks.lodgeUpdate,
    },
    booking: { count: mocks.bookingCount },
    hutLeaderAssignment: { count: mocks.hutLeaderAssignmentCount },
    memberLodgeAccess: { count: mocks.memberLodgeAccessCount },
    auditLog: { create: mocks.auditLogCreate },
    $executeRaw: mocks.executeRaw,
  };
  return {
    prisma: {
      ...delegates,
      $transaction: async (run: (tx: unknown) => unknown) => {
        mocks.timeline.push("transaction-open");
        const result = await run(delegates);
        mocks.timeline.push("transaction-close");
        return result;
      },
    },
  };
});

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { PATCH } from "@/app/api/admin/lodges/[id]/route";

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";
const CLUB_DAY = "2026-06-30T00:00:00.000Z";
const ENVIRONMENT_DAY = "2026-07-01T00:00:00.000Z";

const adminSession = {
  user: {
    id: "admin-1",
    role: "ADMIN",
    accessRoles: ["ADMIN"],
    adminPermissionMatrix: {
      overview: "edit",
      bookings: "edit",
      membership: "edit",
      finance: "edit",
      lodge: "edit",
      content: "edit",
      support: "edit",
    },
  },
};

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockImplementation(async () => {
    mocks.timeline.push("club-zone-read");
    return {
      timeZone,
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  });
}

function lodgeRecord(overrides: Record<string, unknown> = {}) {
  const stamp = new Date("2026-07-02T10:00:00.000Z");
  return {
    id: "lodge-1",
    name: "Alpine Lodge",
    slug: "alpine-lodge",
    active: true,
    doorCode: null,
    travelNote: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function deactivateRequest() {
  return new NextRequest("http://localhost/api/admin/lodges/lodge-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
}

const params = { params: Promise.resolve({ id: "lodge-1" }) };

/** Every `checkOut: { gte: … }` bound the dependency counts asked on. */
function bookingCheckOutBounds(): string[] {
  return mocks.bookingCount.mock.calls
    .map(
      (call) =>
        (call[0] as { where: { checkOut?: { gte: Date } } }).where.checkOut,
    )
    .filter((clause): clause is { gte: Date } => clause !== undefined)
    .map((clause) => clause.gte.toISOString());
}

function hutLeaderEndDateBounds(): string[] {
  return mocks.hutLeaderAssignmentCount.mock.calls.map((call) =>
    (
      call[0] as { where: { endDate: { gte: Date } } }
    ).where.endDate.gte.toISOString(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.timeline.length = 0;
  persistClubZone(PERSISTED_ZONE);
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
  mocks.lodgeFindFirst.mockResolvedValue(null);
  mocks.lodgeCount.mockResolvedValue(1);
  mocks.lodgeUpdate.mockResolvedValue(lodgeRecord({ active: false }));
  mocks.lodgeFindMany.mockResolvedValue([
    { name: "Other Lodge", doorCode: null, travelNote: null },
  ]);
  mocks.bookingCount.mockResolvedValue(0);
  mocks.hutLeaderAssignmentCount.mockResolvedValue(0);
  mocks.memberLodgeAccessCount.mockResolvedValue(0);
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.acquireConfigImportLock.mockImplementation(async () => {
    mocks.timeline.push("config-import-lock");
  });
  mocks.acquireLodgeCapacityLock.mockImplementation(async () => {
    mocks.timeline.push("lodge-capacity-lock");
  });
});

describe("a lodge's live dependencies are counted on the club's day (#3123)", () => {
  it("PREMISE: the persisted zone and the container's give different days", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(clubToday(requireClubTimeZone(ENVIRONMENT_ZONE))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_ZONE))).toBe("2026-06-30");
  });

  it("bounds every dependency count on the club's day, not the container's", async () => {
    await PATCH(deactivateRequest(), params);

    // Two asks, and neither may use the environment's day. `@db.Date` columns,
    // so the bound is the club's day at UTC midnight (`INV-DATE-026`) — a
    // club-LOCAL midnight would be 2026-06-30T06:00:00Z, which the adapter
    // narrows to 29 June.
    const checkOutBounds = bookingCheckOutBounds();
    expect(checkOutBounds.length).toBeGreaterThanOrEqual(2);
    for (const bound of checkOutBounds) {
      expect(bound).toBe(CLUB_DAY);
      expect(bound).not.toBe(ENVIRONMENT_DAY);
    }
    for (const bound of hutLeaderEndDateBounds()) {
      expect(bound).toBe(CLUB_DAY);
    }
  });

  it("gives the cheap ask and the LOCKED re-check the very same day", async () => {
    await PATCH(deactivateRequest(), params);

    // The guard exists because the two asks used to be copies that could drift.
    // Two independent reads would put them on different days across club
    // midnight, so the refusal could hold outside the lock and let the race
    // through under it — the exact failure this module was written to remove.
    expect(new Set(bookingCheckOutBounds()).size).toBe(1);
    expect(new Set(hutLeaderEndDateBounds()).size).toBe(1);
  });

  it("moves with the persisted zone — kills a hard-coded Pacific/Auckland", async () => {
    persistClubZone("Pacific/Pago_Pago"); // UTC-11: still 30 June
    await PATCH(deactivateRequest(), params);
    expect(bookingCheckOutBounds()[0]).toBe("2026-06-30T00:00:00.000Z");

    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeFindFirst.mockResolvedValue(null);
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.lodgeUpdate.mockResolvedValue(lodgeRecord({ active: false }));
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "Other Lodge", doorCode: null, travelNote: null },
    ]);
    mocks.bookingCount.mockResolvedValue(0);
    mocks.hutLeaderAssignmentCount.mockResolvedValue(0);
    mocks.memberLodgeAccessCount.mockResolvedValue(0);
    mocks.executeRaw.mockResolvedValue(undefined);
    persistClubZone("Pacific/Kiritimati"); // UTC+14: 1 July
    await PATCH(deactivateRequest(), params);
    expect(bookingCheckOutBounds()[0]).toBe("2026-07-01T00:00:00.000Z");
  });

  it("INV-LOCK-004: resolves the zone before the transaction, never inside it", async () => {
    await PATCH(deactivateRequest(), params);

    const opened = mocks.timeline.indexOf("transaction-open");
    const closed = mocks.timeline.indexOf("transaction-close");
    expect(opened, "the route never opened a transaction").toBeGreaterThan(-1);
    expect(mocks.timeline.slice(0, opened)).toContain("club-zone-read");
    expect(
      mocks.timeline.slice(opened, closed),
      "a club-zone read ran inside the transaction, holding a " +
        "`clubTimeSettings` query under the config-import singleton and the " +
        "per-lodge capacity key. `INV-LOCK-004`.",
    ).not.toContain("club-zone-read");

    // NOT VACUOUS: the timeline really saw the locks it is reasoning about.
    expect(mocks.timeline.slice(opened, closed)).toContain("config-import-lock");
    expect(mocks.timeline.slice(opened, closed)).toContain(
      "lodge-capacity-lock",
    );
  });
});
