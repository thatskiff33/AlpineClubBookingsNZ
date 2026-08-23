import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * CT-4 (#2870): "a date of birth cannot be in the future" is judged against the
 * CLUB's calendar day.
 *
 * The comparison has always been day-against-day rather than day-against-instant
 * (#2682) — what changes here is where the day comes from. It used to be
 * `getTodayDateOnly()`, which reads `APP_TIME_ZONE`, i.e. the container's `TZ`.
 * A club whose server runs in a different region than the club does therefore
 * refused a birthday the club's own date picker offered, or accepted one a day
 * ahead of it. The answer now comes from the persisted `ClubTimeSettings.timeZone`
 * (INV-CONFIG-002, INV-DATE-019). The date of birth itself is a calendar date
 * and is still never projected through any zone (INV-DATE-010).
 *
 * ## Why the assertions here are about AUTHORITY and not merely about zones
 *
 * One payload, one frozen clock, one fixture — the ONLY thing that changes
 * between the two cases is the `ClubTimeSettings` row, and the route's answer has
 * to change with it. That is a property no mutant which ignores the persisted
 * value can satisfy, including the two most tempting ones: reading
 * `APP_TIME_ZONE` (pinned here to `Pacific/Auckland`, so it agrees with one case
 * and not the other) and hard-coding the documented default.
 *
 * A 404 rather than a 422 is what "the gate let it through" looks like: the
 * request goes on to look the requester up, and the fixture has no such member.
 *
 * Independent of the host's own `TZ` — `APP_TIME_ZONE` is supplied by the mock,
 * and `getClubTimeZone`'s environment seed is never reached because a persisted
 * row is always present.
 */

// Inlined: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const BEHIND_UTC_ZONE = "America/Denver";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  applyRateLimit: vi.fn(),
  computeAgeTier: vi.fn(),
  getSeasonStartDate: vi.fn(),
  memberFindUnique: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...a: unknown[]) => mocks.requireActiveSessionUser(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: (...a: unknown[]) => mocks.applyRateLimit(...a),
  rateLimiters: {
    familyGroupJoinRequest: { id: "fgjr", limit: 5, windowSeconds: 3600 },
  },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: (...a: unknown[]) => mocks.computeAgeTier(...a),
  getSeasonStartDate: (...a: unknown[]) => mocks.getSeasonStartDate(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendChildRequestSubmittedEmail: vi.fn(),
  sendAdminFamilyGroupRequestAlert: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
/*
  `clubTimeSettings` is the point of this mock. `getClubTimeZone` degrades
  silently to the environment when the delegate is missing, when the query throws
  and when the row is absent — so a prisma mock without it would make every
  assertion below pass for the wrong reason.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: (...a: unknown[]) => mocks.memberFindUnique(...a) },
    familyGroupJoinRequest: { findFirst: vi.fn(), create: vi.fn() },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));

import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { APP_TIME_ZONE } from "@/config/operational";
import { POST } from "@/app/api/members/family/request-child/route";

/** The frozen clock's calendar day in a given zone. */
function todayIn(zone: string) {
  return clubToday(requireClubTimeZone(zone));
}

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

/** The same payload every time; only the club's zone differs between cases. */
function request() {
  return new NextRequest("http://localhost/api/members/family/request-child", {
    method: "POST",
    body: JSON.stringify({
      familyGroupId: "fg-1",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "2026-07-01",
    }),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "m1", email: "a@x.nz" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.computeAgeTier.mockResolvedValue("INFANT");
  mocks.getSeasonStartDate.mockReturnValue(new Date("2026-06-01T00:00:00.000Z"));
  // No such member: a 404 here is the signal that the date-of-birth gate did
  // not refuse the request.
  mocks.memberFindUnique.mockResolvedValue(null);
});

describe("a child's date of birth is judged on club time (CT-4, #2870)", () => {
  it("PREMISE: the two zones disagree about today at the frozen instant", () => {
    // The ANSWERS differ, not just the identifiers. Without this the two cases
    // below would be the same case written twice.
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(todayIn(ENVIRONMENT_ZONE)).toBe("2026-07-01");
    expect(todayIn(BEHIND_UTC_ZONE)).toBe("2026-06-30");
  });

  it("refuses 1 July for a club whose day is still 30 June", async () => {
    persistClubZone(BEHIND_UTC_ZONE);

    const response = await POST(request());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Date of birth cannot be in the future",
    });
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
  });

  it("accepts the same 1 July for a club whose day IS 1 July", async () => {
    // MUTANT KILLED: any "today" that does not come from the persisted row.
    // Nothing but the ClubTimeSettings value differs from the case above.
    persistClubZone("Pacific/Auckland");

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.memberFindUnique).toHaveBeenCalled();
  });

  it("reads the zone from the ClubTimeSettings row", async () => {
    persistClubZone("Pacific/Auckland");
    await POST(request());

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });
});
