import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";

/**
 * #3123: a hut-leader PIN's validity window is judged on the CLUB's day.
 *
 * `verifyHutLeaderPinForAssignment` admits a PIN only for a current or upcoming
 * assignment (`endDate >= date`), and `findActiveHutLeaderAssignmentByPin` does
 * the same for the kiosk login. Both took that day from a POSITIONAL DEFAULT
 * that read `APP_TIME_ZONE` — the environment's claim. That is a credential
 * decision taken from the wrong clock: a day out in one direction admits a PIN
 * whose assignment has ended, and a day out in the other locks out a hut leader
 * whose assignment has begun.
 *
 * The kiosk caller made it worse than a default usually is. It called
 * `findActiveHutLeaderAssignmentByPin(pin, undefined, kioskLodgeId)` — passing
 * `undefined` purely to reach the third parameter — so the environment's day was
 * being chosen by accident rather than on purpose. Both parameters are required
 * now and both callers supply the club's day.
 *
 * ## What makes this file discriminating
 *
 * It asserts the BOUND VALUE Prisma was handed, not the route's status code. A
 * status code cannot tell 30 June from 1 July when the fixture is comfortably
 * inside both, and those two days are the whole question.
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — the answer the replaced
 * default gave, and this codebase's own fallback, so it is the one value a wrong
 * fix could still pass under. The PERSISTED zone is `America/Denver`, behind
 * Greenwich. Under the frozen clock (`2026-07-01T00:00:00.000Z`) the club's day
 * is 30 June and the environment's is 1 July, so nothing here can agree by
 * coincidence and no `vi.setSystemTime` is needed.
 *
 * THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THE PRISMA MOCK.
 * `getClubTimeZone` degrades silently to the environment when the delegate is
 * missing, when the query throws, and when the row is absent.
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
const PIN = "246813";

const mocks = vi.hoisted(() => ({
  assignmentFindFirst: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  applyRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  createAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(),
  getSanitizedLodgeInstructions: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    hutLeaderAssignment: {
      findFirst: (...a: unknown[]) => mocks.assignmentFindFirst(...a),
    },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  getClientIp: mocks.getClientIp,
  rateLimiters: { lodgePinLogin: { id: "lodge-pin-login" } },
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/lodge-instructions", () => ({
  getSanitizedLodgeInstructions: mocks.getSanitizedLodgeInstructions,
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { POST } from "@/app/api/lodge/instructions/preview/route";

function dayIn(zone: string) {
  return clubToday(requireClubTimeZone(zone));
}

/** The `endDate` lower bound the PIN check handed Prisma. */
function endDateBound(): Date {
  const call = mocks.assignmentFindFirst.mock.calls.at(-1)?.[0] as {
    where: { endDate: { gte: Date } };
  };
  return call.where.endDate.gte;
}

function post() {
  return POST(
    new NextRequest("http://localhost/api/lodge/instructions/preview", {
      method: "POST",
      body: JSON.stringify({ assignmentId: "assign-1", pin: PIN }),
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getClientIp.mockReturnValue("1.2.3.4");
  mocks.getAuditRequestContext.mockReturnValue({
    ipAddress: "1.2.3.4",
    id: "req-1",
    userAgent: "test",
  });
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.getSanitizedLodgeInstructions.mockResolvedValue([]);
  mocks.assignmentFindFirst.mockResolvedValue({
    id: "assign-1",
    memberId: "mem-1",
    lodgeId: "lodge-b",
    hutLeaderPin: await bcrypt.hash(PIN, 10),
    member: { id: "mem-1", active: true },
  });
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: PERSISTED_ZONE,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

describe("a hut-leader PIN window is judged on club time (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's disagree about the day", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(dayIn(PERSISTED_ZONE)).toBe("2026-06-30");
    expect(dayIn(ENVIRONMENT_ZONE)).toBe("2026-07-01");
  });

  it("bounds endDate on the CLUB's day, at UTC midnight", async () => {
    const response = await post();
    expect(response.status).toBe(200);

    // The club's 30 June, encoded the way a `@db.Date` column round-trips
    // (`INV-DATE-026`). A club-LOCAL midnight would be 2026-06-30T06:00Z, which
    // Prisma narrows against a DATE column, and the environment's answer would
    // be 1 July - both are excluded by asserting the exact instant.
    expect(endDateBound().toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it("MOVES with the persisted zone, which kills a hard-coded Pacific/Auckland", async () => {
    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Kiritimati",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await post();
    const east = endDateBound().toISOString();

    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Pago_Pago",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await post();
    const west = endDateBound().toISOString();

    expect(east).toBe("2026-07-01T00:00:00.000Z");
    expect(west).toBe("2026-06-30T00:00:00.000Z");
    expect(east).not.toBe(west);
  });

  it("an assignment that ended on the club's yesterday is outside the bound", async () => {
    // The behavioural half: with the club on 30 June, an assignment whose
    // `endDate` is 29 June must not satisfy `endDate >= today`. The environment's
    // 1 July would have excluded 30 June too - a hut leader whose assignment ends
    // TODAY, refused their own instructions.
    await post();
    const bound = endDateBound();
    expect(new Date("2026-06-29T00:00:00.000Z") >= bound).toBe(false);
    expect(new Date("2026-06-30T00:00:00.000Z") >= bound).toBe(true);
  });
});
